/**
 * One authenticated MCP connection to FlowUs.
 *
 * Owns the SDK client plus its Streamable HTTP transport, the bearer-token
 * handoff to the OAuth provider, tool discovery and tool calls. The plugin
 * layer above it decides when to connect, how to register the discovered tools
 * on the harness tool registry, and what to do when authorization is missing.
 *
 * @module dsh-flowus/mcp-session
 */

import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';

/** Client identity advertised to the FlowUs MCP server. */
export const CLIENT_INFO = Object.freeze({ name: 'dsh-flowus', version: '0.1.0' });

/** Error code used when the session needs the user to authorize in a browser. */
export const AUTH_REQUIRED = 'FLOWUS_AUTH_REQUIRED';

/**
 * Retry budget for a server-side concurrency rejection.
 *
 * The FlowUs MCP server allows one tool call in flight per MCP session and
 * answers a second concurrent call with JSON-RPC `-32002` ("MCP session has
 * too many concurrent tool calls; retry with backoff"). Calls are serialized
 * per session below, and this budget covers the residual race where something
 * outside this session shares the same connection.
 */
export const CONCURRENCY_MAX_ATTEMPTS = 3;

/** Base backoff between concurrency retries (multiplied by the attempt number). */
export const CONCURRENCY_RETRY_DELAY_MS = 250;

/**
 * Whether a failure is the server's "one call at a time" rejection.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConcurrencyRejection(error) {
  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  const nested = record.error && typeof record.error === 'object' ? /** @type {Record<string, unknown>} */ (record.error) : {};
  if (record.code === -32002 || nested.code === -32002) return true;
  const text = typeof record.message === 'string' ? record.message : String(error ?? '');
  return /-32002/u.test(text) || /too many concurrent tool calls/iu.test(text);
}

/**
 * One FIFO lane: each task starts only after the previous one settled, and a
 * rejected task never breaks the lane for its successors.
 * @returns {(task: () => Promise<unknown>) => Promise<unknown>}
 */
export function createSerialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Wait, unless the caller cancels first.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('flowus: the tool call was cancelled while waiting to retry'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Authorization is required before this operation can succeed. */
export class FlowusAuthRequiredError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = 'FlowusAuthRequiredError';
    this.code = AUTH_REQUIRED;
  }
}

/**
 * Render one MCP `CallToolResult` into the plugin's canonical JSON value.
 *
 * The raw content blocks are preserved verbatim in `blocks` so a caller can
 * still reach resource links or structured content; `text` is the model-facing
 * projection, and every non-text block contributes an explicit marker instead
 * of silently disappearing.
 * @param {unknown} result - the SDK's `CallToolResult`.
 * @returns {{ text: string, blocks: unknown[], structuredContent?: unknown, isError: boolean }}
 */
export function normalizeCallToolResult(result) {
  const record = result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
  const blocks = Array.isArray(record.content) ? record.content : [];
  const lines = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const entry = /** @type {Record<string, unknown>} */ (block);
    switch (entry.type) {
      case 'text':
        lines.push(typeof entry.text === 'string' ? entry.text : '');
        break;
      case 'image':
        lines.push(`[image ${typeof entry.mimeType === 'string' ? entry.mimeType : 'unknown'} — not rendered inline by this plugin]`);
        break;
      case 'audio':
        lines.push(`[audio ${typeof entry.mimeType === 'string' ? entry.mimeType : 'unknown'} — not rendered inline by this plugin]`);
        break;
      case 'resource_link':
        lines.push(`[resource ${typeof entry.name === 'string' ? entry.name : ''} ${typeof entry.uri === 'string' ? entry.uri : ''}]`.trim());
        break;
      case 'resource': {
        const resource = entry.resource && typeof entry.resource === 'object' ? /** @type {Record<string, unknown>} */ (entry.resource) : {};
        if (typeof resource.text === 'string') lines.push(resource.text);
        else lines.push(`[resource ${typeof resource.uri === 'string' ? resource.uri : ''} — binary content omitted]`);
        break;
      }
      default:
        lines.push(`[unsupported content block ${String(entry.type)}]`);
        break;
    }
  }
  /** @type {{ text: string, blocks: unknown[], structuredContent?: unknown, isError: boolean }} */
  const value = {
    text: lines.join('\n'),
    blocks,
    isError: record.isError === true,
  };
  if (record.structuredContent !== undefined) value.structuredContent = record.structuredContent;
  return value;
}

/**
 * A live FlowUs MCP session.
 */
export class FlowusMcpSession {
  /** @type {string} */
  #serverUrl;
  /** @type {string | undefined} */
  #scope;
  /** @type {import('./oauth-provider.js').FlowusOAuthProvider} */
  #provider;
  /** @type {(message: string) => void} */
  #log;
  /** @type {number} */
  #toolCallTimeoutMs;
  /** @type {Client | undefined} */
  #client;
  /** @type {StreamableHTTPClientTransport | undefined} */
  #transport;
  /** @type {object[]} */
  #tools = [];
  /**
   * One call at a time on this session: the FlowUs server rejects concurrent
   * calls with `-32002`, so the lane is what makes the harness's parallel
   * read-only scheduling safe.
   * @type {(task: () => Promise<unknown>) => Promise<unknown>}
   */
  #lane = createSerialQueue();

  /**
   * @param {object} options
   * @param {string} options.serverUrl - the MCP resource URL.
   * @param {string} [options.scope] - OAuth scope to request.
   * @param {import('./oauth-provider.js').FlowusOAuthProvider} options.provider
   * @param {(message: string) => void} [options.log]
   * @param {number} [options.toolCallTimeoutMs]
   */
  constructor(options) {
    this.#serverUrl = options.serverUrl;
    this.#scope = options.scope;
    this.#provider = options.provider;
    this.#log = options.log ?? (() => {});
    this.#toolCallTimeoutMs = options.toolCallTimeoutMs ?? 60_000;
  }

  /** @returns {boolean} whether a transport+client pair is open. */
  get connected() {
    return this.#client !== undefined;
  }

  /** @returns {object[]} the tools discovered by the last successful sync. */
  get tools() {
    return this.#tools;
  }

  /**
   * Open the connection and complete the MCP initialize handshake.
   *
   * The provider supplies the bearer token on every request; a 401 makes the
   * SDK run its refresh branch once, and anything still unauthorized is
   * reported as {@link FlowusAuthRequiredError} instead of a raw transport
   * error so the caller can tell the user to run `/flowus login`.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ serverName?: string, serverVersion?: string, instructions?: string, toolCount: number }>}
   */
  async connect(options = {}) {
    await this.close();
    const transport = new StreamableHTTPClientTransport(new URL(this.#serverUrl), {
      authProvider: this.#provider,
    });
    const client = new Client(
      { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error) {
                this.#log(`flowus: tool list refresh failed: ${error.message}`);
                return;
              }
              if (Array.isArray(tools)) this.#tools = tools;
            },
          },
        },
      },
    );
    try {
      await client.connect(transport, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (isAuthRequired(error)) {
        throw new FlowusAuthRequiredError(
          'FlowUs authorization is missing or expired. Run /flowus login to authorize in the browser.',
          { cause: error },
        );
      }
      throw error;
    }
    this.#client = client;
    this.#transport = transport;
    this.#tools = [];
    const serverVersion = client.getServerVersion();
    return {
      serverName: typeof serverVersion?.name === 'string' ? serverVersion.name : undefined,
      serverVersion: typeof serverVersion?.version === 'string' ? serverVersion.version : undefined,
      instructions: client.getInstructions(),
      toolCount: 0,
    };
  }

  /**
   * Fetch the server's tool list.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>} the raw MCP tool definitions.
   */
  async listTools(options = {}) {
    const client = this.#requireClient();
    const result = await client.listTools(undefined, options.signal ? { signal: options.signal } : undefined);
    this.#tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.#tools;
  }

  /**
   * Call one tool by its raw MCP name.
   *
   * Calls queue behind each other: the FlowUs server accepts a single
   * in-flight call per session, so the harness may schedule read-only tools in
   * parallel without the server rejecting the extras.
   * @param {string} rawName - the name the server published.
   * @param {Record<string, unknown>} args - JSON arguments.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<ReturnType<typeof normalizeCallToolResult>>}
   */
  async callTool(rawName, args, options = {}) {
    return /** @type {Promise<ReturnType<typeof normalizeCallToolResult>>} */ (
      this.#lane(() => this.#callToolNow(rawName, args, options))
    );
  }

  /**
   * Issue one call, retrying only the server's concurrency rejection.
   * @param {string} rawName
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal }} options
   * @returns {Promise<ReturnType<typeof normalizeCallToolResult>>}
   */
  async #callToolNow(rawName, args, options) {
    if (options.signal?.aborted) throw new Error('flowus: the tool call was cancelled before it started');
    for (let attempt = 1; ; attempt += 1) {
      try {
        const client = this.#requireClient();
        /** @type {{ signal?: AbortSignal, timeout?: number }} */
        const requestOptions = { timeout: this.#toolCallTimeoutMs };
        if (options.signal) requestOptions.signal = options.signal;
        const result = await client.callTool({ name: rawName, arguments: args ?? {} }, requestOptions);
        return normalizeCallToolResult(result);
      } catch (error) {
        if (attempt >= CONCURRENCY_MAX_ATTEMPTS || !isConcurrencyRejection(error)) throw error;
        this.#log(`flowus: the server refused a concurrent call; retrying ${rawName} (attempt ${attempt + 1})`);
        await delay(CONCURRENCY_RETRY_DELAY_MS * attempt, options.signal);
      }
    }
  }

  /** Close the client and its transport; safe to call repeatedly. */
  async close() {
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools = [];
    if (client) await client.close().catch(() => undefined);
  }

  /** @returns {Client} the open client, or a clear error. */
  #requireClient() {
    if (!this.#client) throw new Error('flowus: the MCP session is not connected');
    return this.#client;
  }
}

/**
 * Whether an SDK failure means "authorize again" rather than a transport fault.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAuthRequired(error) {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof FlowusAuthRequiredError) return true;
  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  if (record.code === AUTH_REQUIRED) return true;
  if (typeof record.message === 'string' && /401|unauthorized/u.test(record.message)) return true;
  return false;
}
