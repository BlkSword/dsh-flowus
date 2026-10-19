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
import { DEFAULT_MAX_TEXT_CHARS, capText } from './text-bound.js';

/** Client identity advertised to the FlowUs MCP server. */
export const CLIENT_INFO = Object.freeze({ name: 'dsh-flowus', version: '0.1.1' });

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
 * Whether an SDK failure means this MCP session is gone rather than the call
 * itself being wrong.
 *
 * The FlowUs server forgets a session it no longer holds and answers every
 * later request with JSON-RPC `-32001` ("Session not found"); the same
 * condition can surface as a plain 404 from the streamable-HTTP endpoint. A
 * missing session is recoverable — reconnect and retry — unlike an
 * authorization failure, which needs the user.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSessionMissing(error) {
  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  const nested = record.error && typeof record.error === 'object' ? /** @type {Record<string, unknown>} */ (record.error) : {};
  if (record.code === -32001 || nested.code === -32001) return true;
  const text = typeof record.message === 'string' ? record.message : String(error ?? '');
  return /-32001/u.test(text) || /session (?:not found|expired|unknown)/iu.test(text);
}

/**
 * Render one failure for a log line.
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retry budget for transient transport failures.
 *
 * The FlowUs endpoint answers 5xx from the nginx in front of it, and those are
 * short: a client that replays the attempt with backoff never sees them. Three
 * retries with exponential backoff and jitter, capped at eight seconds, mirror
 * the harness's own MCP bridge; a longer outage is left to the plugin-level
 * re-sync schedule rather than holding a tool call open.
 */
export const TRANSIENT_RETRY_POLICY = Object.freeze({ maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8_000 });

/**
 * HTTP statuses nginx answers when it cannot reach the upstream. The request
 * never reached the MCP application, so replaying it — even a write — is safe.
 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Transient statuses where the attempt may already have been processed, so only
 * an idempotent (read-only) call may be replayed.
 */
const AMBIGUOUS_STATUSES = new Set([408, 425, 429, 500]);

/** Connection-level failure codes (fetch/undici) that mean the transport broke. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The HTTP status behind an SDK failure.
 *
 * The streamable-HTTP transport attaches `status`/`text` to its
 * `SdkHttpError`, and older paths only embed `(HTTP 503)` in the message.
 * @param {unknown} error
 * @returns {number | undefined}
 */
function httpStatusOf(error) {
  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  if (typeof record.status === 'number' && Number.isFinite(record.status)) return record.status;
  const message = typeof record.message === 'string' ? record.message : '';
  const match = /HTTP (\d{3})\b/u.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * Classify a failed MCP exchange so the caller knows what to do with it.
 *
 * `gateway` and `transient` are the failures worth retrying; `session` can be
 * recovered by reconnecting; `concurrency` is the server's one-call-at-a-time
 * rejection; `auth` needs the user. Anything else is terminal.
 * @param {unknown} error
 * @returns {'session' | 'concurrency' | 'auth' | 'gateway' | 'transient' | undefined}
 */
export function classifyFailure(error) {
  if (isSessionMissing(error)) return 'session';
  if (isConcurrencyRejection(error)) return 'concurrency';
  if (isAuthRequired(error)) return 'auth';

  const status = httpStatusOf(error);
  if (status !== undefined) {
    if (GATEWAY_STATUSES.has(status)) return 'gateway';
    if (AMBIGUOUS_STATUSES.has(status)) return 'transient';
  }

  const record = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
  if (typeof record.code === 'string' && TRANSIENT_NETWORK_CODES.has(record.code)) return 'transient';
  const message = typeof record.message === 'string' ? record.message : String(error ?? '');
  if (/fetch failed|socket hang up|network error|other side closed/iu.test(message)) return 'transient';
  if (/Error POSTing to endpoint/iu.test(message) && /(?:5\d\d|Bad Gateway|Service Temporarily|Gateway Time-?out)/iu.test(message)) {
    return 'gateway';
  }
  return undefined;
}

/**
 * Whether one failure may be retried, given what the call itself does.
 *
 * A gateway rejection is always safe to replay because the request never ran;
 * an ambiguous failure is replayed only for an idempotent (read-only) call, so a
 * write is never applied twice by the plugin's own retry.
 * @param {ReturnType<typeof classifyFailure>} kind
 * @param {{ idempotent?: boolean }} [options]
 * @returns {boolean}
 */
export function isRetryableFailure(kind, options = {}) {
  if (kind === 'gateway') return true;
  if (kind === 'transient') return options.idempotent === true;
  return false;
}

/**
 * Exponential backoff with equal jitter.
 * @param {number} attempt - 1-based retry number.
 * @param {{ baseDelayMs: number, maxDelayMs: number }} [policy]
 * @param {() => number} [random] - injectable for deterministic tests.
 * @returns {number} milliseconds to wait, between half and the full ceiling.
 */
export function backoffDelay(attempt, policy = TRANSIENT_RETRY_POLICY, random = Math.random) {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const half = ceiling / 2;
  return Math.max(0, Math.round(half + random() * half));
}

/**
 * Strip markup so a gateway page never reaches the model, the settings page or
 * the log as hundreds of characters of HTML.
 * @param {string} text
 * @returns {string}
 */
function stripMarkup(text) {
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&[a-z]+;|&#\d+;/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Longest failure description that leaves the plugin. */
const MAX_FAILURE_CHARS = 200;

/**
 * A short, markup-free description of a failed MCP exchange.
 *
 * Everything the plugin surfaces — the status snapshot, the tool error the model
 * reads, the settings-page envelope — is built from this instead of the raw SDK
 * message, which carries the whole response body.
 * @param {unknown} error
 * @returns {string}
 */
export function describeFailure(error) {
  const status = httpStatusOf(error);
  if (status !== undefined && GATEWAY_STATUSES.has(status)) return `FlowUs gateway is temporarily unavailable (HTTP ${status})`;
  if (status === 429) return 'FlowUs is rate limiting this client (HTTP 429)';
  if (status !== undefined && status >= 500) return `FlowUs failed this request (HTTP ${status})`;
  const text = stripMarkup(errorMessage(error));
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS - 1)}…` : text;
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

/** Inline payload ceiling for one content block kept in the result value. */
export const DEFAULT_MAX_INLINE_CHARS = 256 * 1024;

/**
 * Bound one content block's inline payload.
 *
 * The raw blocks are kept so a caller can still reach resource links, but a
 * base64 image or blob is not worth carrying at full length into the session
 * record: the marker keeps the block's type and the original size. A block that
 * is already small is returned unchanged, so nothing is copied for free.
 * @param {unknown} block
 * @param {number} maxInlineChars
 * @returns {unknown}
 */
function boundBlockPayload(block, maxInlineChars) {
  if (!block || typeof block !== 'object') return block;
  const record = /** @type {Record<string, unknown>} */ (block);
  /** @type {Record<string, unknown>} */
  const next = { ...record };
  let changed = false;
  for (const key of ['data', 'blob']) {
    const value = next[key];
    if (typeof value === 'string' && value.length > maxInlineChars) {
      next[key] = '';
      next.omittedBytes = value.length;
      changed = true;
    }
  }
  if (next.resource && typeof next.resource === 'object') {
    const resource = { .../** @type {Record<string, unknown>} */ (next.resource) };
    for (const key of ['blob', 'text']) {
      const value = resource[key];
      if (typeof value === 'string' && value.length > maxInlineChars) {
        resource[key] = key === 'text' ? capText(value, maxInlineChars) : '';
        resource.omittedBytes = value.length;
        changed = true;
      }
    }
    if (changed) next.resource = resource;
  }
  return changed ? next : block;
}

/**
 * Render one MCP `CallToolResult` into the plugin's canonical JSON value.
 *
 * The raw content blocks are preserved verbatim in `blocks` so a caller can
 * still reach resource links or structured content; `text` is the model-facing
 * projection, and every non-text block contributes an explicit marker instead
 * of silently disappearing. Both are bounded: `text` keeps its head and tail
 * with a notice, and an oversized inline payload is replaced by its size.
 * @param {unknown} result - the SDK's `CallToolResult`.
 * @param {{ maxTextChars?: number, maxInlineChars?: number }} [limits]
 * @returns {{ text: string, blocks: unknown[], structuredContent?: unknown, isError: boolean }}
 */
export function normalizeCallToolResult(result, limits = {}) {
  const maxTextChars = limits.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxInlineChars = limits.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  const record = result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const lines = [];
  for (const block of content) {
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
    text: capText(lines.join('\n'), maxTextChars),
    blocks: content.map((block) => boundBlockPayload(block, maxInlineChars)),
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
  /** @type {number} */
  #maxTextChars;
  /** @type {Client | undefined} */
  #client;
  /** @type {StreamableHTTPClientTransport | undefined} */
  #transport;
  /** @type {object[]} */
  #tools = [];
  /**
   * Adopt a refreshed tool list: the plugin re-registers the whole generation
   * from it. Called after a reconnect and on `tools/list_changed`, so the
   * model's tool set follows the server instead of waiting for `/flowus reload`.
   * @type {((tools: object[]) => void | Promise<void>) | undefined}
   */
  #onToolsChanged;
  /**
   * Factory for the client + transport pair, injectable so the reconnect path
   * can be driven in tests. It receives the hooks the session needs wired.
   * @type {(hooks: { onListChanged: (error: unknown, tools: unknown) => void }) => { client: Client, transport: StreamableHTTPClientTransport }}
   */
  #openClient;
  /** @type {Promise<void> | undefined} */
  #recovery;
  /** @type {{ maxRetries: number, baseDelayMs: number, maxDelayMs: number }} */
  #retryPolicy;
  /** @type {() => number} */
  #random;
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
   * @param {number} [options.maxTextChars] - ceiling for one result's model-facing text; `0` disables it.
   * @param {typeof TRANSIENT_RETRY_POLICY} [options.retryPolicy] - transient-failure retry budget.
   * @param {() => number} [options.random] - jitter source, injectable for deterministic tests.
   * @param {(tools: object[]) => void | Promise<void>} [options.onToolsChanged] - re-register one generation.
   * @param {(hooks: { onListChanged: (error: unknown, tools: unknown) => void }) => { client: Client, transport: StreamableHTTPClientTransport }} [options.openClient] - test seam.
   */
  constructor(options) {
    this.#serverUrl = options.serverUrl;
    this.#scope = options.scope;
    this.#provider = options.provider;
    this.#log = options.log ?? (() => {});
    this.#toolCallTimeoutMs = options.toolCallTimeoutMs ?? 60_000;
    this.#maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    this.#retryPolicy = options.retryPolicy ?? TRANSIENT_RETRY_POLICY;
    this.#random = options.random ?? Math.random;
    this.#onToolsChanged = options.onToolsChanged;
    this.#openClient = options.openClient ?? ((hooks) => this.#buildClient(hooks));
  }

  /**
   * Build the SDK client and its streamable-HTTP transport.
   * @param {{ onListChanged: (error: unknown, tools: unknown) => void }} hooks
   * @returns {{ client: Client, transport: StreamableHTTPClientTransport }}
   */
  #buildClient(hooks) {
    const transport = new StreamableHTTPClientTransport(new URL(this.#serverUrl), {
      authProvider: this.#provider,
    });
    const client = new Client(
      { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
      {
        capabilities: {},
        listChanged: { tools: { onChanged: hooks.onListChanged } },
      },
    );
    return { client, transport };
  }

  /**
   * The server changed its tool list: adopt it and let the plugin re-register,
   * instead of caching a list nothing reads.
   * @param {unknown} error
   * @param {unknown} tools
   */
  #handleListChanged(error, tools) {
    if (error) {
      this.#log(`flowus: tool list refresh failed: ${errorMessage(error)}`);
      return;
    }
    if (Array.isArray(tools)) void this.#notifyTools(tools);
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
    const { client, transport } = this.#openClient({ onListChanged: (error, tools) => this.#handleListChanged(error, tools) });
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
    const listed = () => this.#listToolsNow(options);
    let recovered = false;
    let retries = 0;
    for (;;) {
      try {
        return await listed();
      } catch (error) {
        // The discovery call can be the first request after the server forgot the
        // session, so it recovers the same way a tool call does.
        if (!recovered && isSessionMissing(error)) {
          recovered = true;
          await this.#recover('the server no longer knows this MCP session');
          continue;
        }
        const kind = classifyFailure(error);
        if (isRetryableFailure(kind, { idempotent: true }) && retries < this.#retryPolicy.maxRetries) {
          retries += 1;
          await this.#waitForRetry(retries, 'tool discovery', options);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Wait out one transient retry and say so in the log.
   * @param {number} attempt - 1-based retry number.
   * @param {string} what - the exchange being retried.
   * @param {{ signal?: AbortSignal }} options
   * @returns {Promise<void>}
   */
  async #waitForRetry(attempt, what, options) {
    const wait = backoffDelay(attempt, this.#retryPolicy, this.#random);
    this.#log(`flowus: ${what} failed transiently; retrying in ${wait}ms (attempt ${attempt + 1}/${this.#retryPolicy.maxRetries + 1})`);
    await delay(wait, options.signal);
  }

  /**
   * Adopt one refreshed tool list and hand it to the plugin.
   *
   * A failing re-registration is reported, never thrown: the previously
   * published generation stays live, which beats losing both.
   * @param {object[]} tools
   */
  async #notifyTools(tools) {
    const next = Array.isArray(tools) ? tools : [];
    this.#tools = next;
    const notify = this.#onToolsChanged;
    if (!notify) return;
    try {
      await notify(next);
    } catch (error) {
      this.#log(`flowus: re-registering the refreshed tool list failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Reconnect once after the server lost this session, then re-register.
   *
   * Concurrent callers share one recovery: the lane already serializes tool
   * calls, and a queued caller must not open a second connection.
   * @param {string} reason - what to tell the log.
   * @returns {Promise<void>}
   */
  #recover(reason) {
    if (this.#recovery) return this.#recovery;
    const run = (async () => {
      this.#log(`flowus: ${reason}; reconnecting`);
      await this.connect();
      await this.#notifyTools(await this.#listToolsNow());
    })();
    this.#recovery = run;
    return run.finally(() => {
      this.#recovery = undefined;
    });
  }

  /**
   * Fetch the server's tool list without recovery; see {@link listTools}.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  async #listToolsNow(options = {}) {
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
   * @param {{ signal?: AbortSignal, idempotent?: boolean }} [options] - `idempotent` lets a transient failure be replayed.
   * @returns {Promise<ReturnType<typeof normalizeCallToolResult>>}
   */
  async callTool(rawName, args, options = {}) {
    return /** @type {Promise<ReturnType<typeof normalizeCallToolResult>>} */ (
      this.#lane(() => this.#callToolNow(rawName, args, options))
    );
  }

  /**
   * Issue one call, recovering a lost session and retrying the failures whose
   * replay is safe.
   *
   * A `-32001` means the session the server holds no longer exists (it expired
   * or the server restarted): reconnect once, re-register the tool list and
   * replay this call. A gateway 5xx never reached the application, so it is
   * replayed regardless; an ambiguous failure is replayed only when the caller
   * declared the call idempotent, so a write is never applied twice here.
   * @param {string} rawName
   * @param {Record<string, unknown>} args
   * @param {{ signal?: AbortSignal, idempotent?: boolean }} options
   * @returns {Promise<ReturnType<typeof normalizeCallToolResult>>}
   */
  async #callToolNow(rawName, args, options) {
    if (options.signal?.aborted) throw new Error('flowus: the tool call was cancelled before it started');
    const idempotent = options.idempotent === true;
    let recovered = false;
    let rejections = 0;
    let retries = 0;
    for (;;) {
      try {
        const client = this.#requireClient();
        /** @type {{ signal?: AbortSignal, timeout?: number }} */
        const requestOptions = { timeout: this.#toolCallTimeoutMs };
        if (options.signal) requestOptions.signal = options.signal;
        const result = await client.callTool({ name: rawName, arguments: args ?? {} }, requestOptions);
        return normalizeCallToolResult(result, { maxTextChars: this.#maxTextChars });
      } catch (error) {
        const kind = classifyFailure(error);
        if (kind === 'session' && !recovered) {
          recovered = true;
          await this.#recover('the server no longer knows this MCP session');
          continue;
        }
        if (kind === 'concurrency') {
          rejections += 1;
          if (rejections >= CONCURRENCY_MAX_ATTEMPTS) throw error;
          this.#log(`flowus: the server refused a concurrent call; retrying ${rawName} (attempt ${rejections + 1})`);
          await delay(CONCURRENCY_RETRY_DELAY_MS * rejections, options.signal);
          continue;
        }
        if (isRetryableFailure(kind, { idempotent }) && retries < this.#retryPolicy.maxRetries) {
          retries += 1;
          await this.#waitForRetry(retries, `tool call ${rawName}`, options);
          continue;
        }
        this.#log(`flowus: ${rawName} failed (${kind ?? 'terminal'}): ${describeFailure(error)}`);
        throw error;
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
