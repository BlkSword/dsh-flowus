/**
 * Tests for the MCP session's pure mechanics: result normalization, the
 * concurrency lane that keeps the FlowUs server's "one call at a time" rule,
 * and authorization-error classification.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedError } from '@modelcontextprotocol/client';
import {
  AUTH_REQUIRED,
  CONCURRENCY_MAX_ATTEMPTS,
  FlowusAuthRequiredError,
  FlowusMcpSession,
  TRANSIENT_RETRY_POLICY,
  backoffDelay,
  classifyFailure,
  createSerialQueue,
  describeFailure,
  isAuthRequired,
  isConcurrencyRejection,
  isRetryableFailure,
  isSessionMissing,
  normalizeCallToolResult,
} from '../lib/mcp-session.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transient policy that keeps the retry tests fast and deterministic. */
const FAST_RETRY = Object.freeze({ maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 });

/**
 * A session over a fake SDK client/transport pair, so the reconnect path runs
 * without a network.
 * @param {{ tools?: object[], onCall?: (request: object, state: object) => object, onList?: (state: object) => { tools: object[] }, onToolsChanged?: (tools: object[]) => void | Promise<void> }} [options]
 */
function fakeSession(options = {}) {
  const tools = options.tools ?? [{ name: 'flowus_help' }];
  const state = { connects: 0, closed: 0, calls: 0, lists: 0, handlers: undefined, logs: [], generations: [] };
  const session = new FlowusMcpSession({
    serverUrl: 'https://mcp.flowus.cn/message',
    provider: {},
    log: (message) => state.logs.push(message),
    toolCallTimeoutMs: 1_000,
    retryPolicy: FAST_RETRY,
    random: () => 0,
    onToolsChanged:
      options.onToolsChanged ??
      ((next) => {
        state.generations.push(next.map((tool) => tool.name));
      }),
    openClient: (hooks) => {
      state.handlers = hooks;
      return {
        client: {
          connect: async () => {
            state.connects += 1;
          },
          close: async () => {
            state.closed += 1;
          },
          listTools: async () => {
            state.lists += 1;
            if (options.onList) return options.onList(state);
            return { tools };
          },
          callTool: async (request) => {
            state.calls += 1;
            if (options.onCall) return options.onCall(request, state);
            return { content: [{ type: 'text', text: 'ok' }] };
          },
          getServerVersion: () => ({ name: 'FlowUs MCP Server', version: '1.0.0' }),
          getInstructions: () => undefined,
        },
        transport: {},
      };
    },
  });
  return { session, state };
}

/** The server's own "this session is gone" answer, in the shape the SDK throws. */
const sessionMissing = () =>
  new Error('Error POSTing to endpoint: {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Session not found"}}');

/** A gateway rejection shaped like the streamable-HTTP transport's failure. */
const gatewayFailure = (status = 503) =>
  Object.assign(new Error(`Error POSTing to endpoint: <html><head><title>${status} Service Temporarily Unavailable</title></head></html>`), {
    status,
    text: `<html><head><title>${status} Service Temporarily Unavailable</title></head></html>`,
  });

test('a text result projects to text and keeps its raw blocks', () => {
  const value = normalizeCallToolResult({ content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(value, { text: 'hello', blocks: [{ type: 'text', text: 'hello' }], isError: false });
});

test('several blocks join in order and non-text blocks leave a marker', () => {
  const value = normalizeCallToolResult({
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'audio', mimeType: 'audio/mpeg', data: 'AAAA' },
      { type: 'resource_link', uri: 'flowus://page/1', name: 'A page' },
      { type: 'resource', resource: { uri: 'flowus://page/2', text: 'embedded' } },
      { type: 'resource', resource: { uri: 'flowus://page/3', blob: 'AAAA' } },
      { type: 'weird' },
    ],
    structuredContent: { ok: true },
  });
  assert.equal(value.isError, false);
  assert.deepEqual(value.structuredContent, { ok: true });
  const lines = value.text.split('\n');
  assert.equal(lines[0], 'first');
  assert.match(lines[1], /image\/png/u);
  assert.match(lines[2], /audio\/mpeg/u);
  assert.match(lines[3], /A page/u);
  assert.equal(lines[4], 'embedded');
  assert.match(lines[5], /binary content omitted/u);
  assert.match(lines[6], /unsupported content block weird/u);
  assert.equal(value.blocks.length, 7, 'the raw blocks come through while their payloads are small');
});

test('an isError result is flagged but still normalized', () => {
  const value = normalizeCallToolResult({ content: [{ type: 'text', text: 'permission denied' }], isError: true });
  assert.equal(value.isError, true);
  assert.equal(value.text, 'permission denied');
});

test('a result with no content normalizes to empty text', () => {
  assert.deepEqual(normalizeCallToolResult({ content: [] }), { text: '', blocks: [], isError: false });
  assert.deepEqual(normalizeCallToolResult(undefined), { text: '', blocks: [], isError: false });
});

test('an oversized result text keeps its ends and states what was dropped', () => {
  const text = 'a'.repeat(10_000) + 'z'.repeat(10_000);
  const value = normalizeCallToolResult({ content: [{ type: 'text', text }] }, { maxTextChars: 1_000 });

  assert.ok(value.text.length < text.length);
  assert.match(value.text, /characters omitted/u);
  assert.ok(value.text.startsWith('a'));
  assert.ok(value.text.endsWith('z'));
  assert.equal(value.blocks[0].text, text, 'the raw block is untouched while it is small enough');
});

test('an oversized inline payload is replaced by its size, not carried on', () => {
  const data = 'A'.repeat(3_000);
  const value = normalizeCallToolResult({ content: [{ type: 'image', mimeType: 'image/png', data }] }, { maxInlineChars: 1_000 });

  assert.equal(value.blocks[0].data, '');
  assert.equal(value.blocks[0].omittedBytes, 3_000);
  assert.equal(value.blocks[0].mimeType, 'image/png');
  assert.match(value.text, /image\/png/u);
});

test('a small block is passed through by identity, never copied', () => {
  const block = { type: 'text', text: 'hi' };
  const value = normalizeCallToolResult({ content: [block] });
  assert.equal(value.blocks[0], block);
});

test('the server concurrency rejection is recognized in every shape it arrives', () => {
  assert.equal(isConcurrencyRejection({ code: -32002 }), true);
  assert.equal(isConcurrencyRejection({ error: { code: -32002 } }), true);
  assert.equal(isConcurrencyRejection({ message: 'MCP session has too many concurrent tool calls; retry with backoff' }), true);
  assert.equal(
    isConcurrencyRejection(
      new Error(
        'Error POSTing to endpoint: {"jsonrpc":"2.0","id":10,"error":{"code":-32002,"message":"MCP session has too many concurrent tool calls; retry with backoff"}}',
      ),
    ),
    true,
  );
  assert.equal(isConcurrencyRejection(new Error('not_found')), false);
  assert.equal(isConcurrencyRejection(undefined), false);
  assert.equal(isConcurrencyRejection('plain string'), false);
});

test('the concurrency lane runs tasks one at a time and preserves order and results', async () => {
  const lane = createSerialQueue();
  const events = [];
  let active = 0;
  let maxActive = 0;
  const task = (id, ms) =>
    lane(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start${id}`);
      await sleep(ms);
      events.push(`end${id}`);
      active -= 1;
      return id;
    });

  const results = await Promise.all([task(1, 20), task(2, 5), task(3, 1)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(maxActive, 1, 'never two tasks in flight');
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('a rejected task does not break the lane for its successors', async () => {
  const lane = createSerialQueue();
  const failing = lane(async () => {
    throw new Error('boom');
  });
  const following = lane(async () => 'ok');
  await assert.rejects(failing, /boom/u);
  assert.equal(await following, 'ok');
});

test('the retry budget is bounded and the base delay is small', () => {
  assert.ok(CONCURRENCY_MAX_ATTEMPTS >= 2);
  assert.ok(CONCURRENCY_MAX_ATTEMPTS <= 5);
});

test('authorization-required failures are classified, others are not', () => {
  assert.equal(isAuthRequired(new FlowusAuthRequiredError('run /flowus login')), true);
  assert.equal(isAuthRequired(new UnauthorizedError()), true);
  assert.equal(isAuthRequired({ code: AUTH_REQUIRED }), true);
  assert.equal(isAuthRequired(new Error('Server returned 401 after re-authentication')), true);
  assert.equal(isAuthRequired(new Error('fetch failed')), false);
  assert.equal(isAuthRequired(new Error('not_found')), false);
});

test('the auth-required error carries a stable name and code', () => {
  const error = new FlowusAuthRequiredError('authorize in the browser');
  assert.equal(error.name, 'FlowusAuthRequiredError');
  assert.equal(error.code, AUTH_REQUIRED);
  assert.ok(error instanceof Error);
});

test('a lost MCP session is recognized in every shape it arrives', () => {
  assert.equal(isSessionMissing({ code: -32001 }), true);
  assert.equal(isSessionMissing({ error: { code: -32001 } }), true);
  assert.equal(isSessionMissing(sessionMissing()), true);
  assert.equal(isSessionMissing(new Error('MCP session expired')), true);
  assert.equal(isSessionMissing({ code: -32002 }), false);
  assert.equal(isSessionMissing(new Error('fetch failed')), false);
  assert.equal(isSessionMissing(undefined), false);
});

test('a lost session reconnects once, re-registers and replays the call', async () => {
  let attempt = 0;
  const { session, state } = fakeSession({
    onCall: () => {
      attempt += 1;
      if (attempt === 1) throw sessionMissing();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  await session.connect();
  const value = await session.callTool('flowus_help', {});

  assert.equal(value.text, 'ok');
  assert.equal(attempt, 2, 'the call was replayed exactly once');
  assert.equal(state.connects, 2, 'the session was reconnected');
  assert.deepEqual(state.generations, [['flowus_help']], 'the refreshed list went to the owner');
  assert.match(state.logs.join('\n'), /reconnecting/u);
});

test('a session that stays lost fails after one reconnect, not a loop', async () => {
  const { session, state } = fakeSession({
    onCall: () => {
      throw sessionMissing();
    },
  });
  await session.connect();
  await assert.rejects(session.callTool('flowus_help', {}), /Session not found|32001/u);
  assert.equal(state.connects, 2, 'exactly one reconnect');
  assert.equal(state.calls, 2, 'exactly one replay');
});

test('a lost session is recovered when discovery is the first call', async () => {
  const { session, state } = fakeSession({
    onList: (s) => {
      if (s.lists === 1) throw sessionMissing();
      return { tools: [{ name: 'flowus_help' }, { name: 'flowus_get_page' }] };
    },
  });
  await session.connect();
  const tools = await session.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['flowus_help', 'flowus_get_page'],
  );
  assert.equal(state.connects, 2, 'the session was reconnected');
  assert.deepEqual(state.generations, [['flowus_help', 'flowus_get_page']]);
});

test("a server tool-list notification re-registers the next generation", async () => {
  const { session, state } = fakeSession({ tools: [{ name: 'first' }] });
  await session.connect();
  state.handlers.onListChanged(null, [{ name: 'second' }, { name: 'third' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.generations, [['second', 'third']]);
});

test('a failing re-registration is logged and never thrown', async () => {
  const { session, state } = fakeSession({
    onToolsChanged: () => {
      throw new Error('name already registered by another plugin');
    },
  });
  await session.connect();
  state.handlers.onListChanged(null, [{ name: 'second' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(state.logs.join('\n'), /re-registering the refreshed tool list failed/u);
});

test('a failed tool-list refresh is reported, not fatal', async () => {
  const { session, state } = fakeSession();
  await session.connect();
  state.handlers.onListChanged(new Error('transport closed'), undefined);
  assert.match(state.logs.join('\n'), /tool list refresh failed/u);
  assert.deepEqual(state.generations, []);
});

test('a failure is classified by what the caller can do about it', () => {
  assert.equal(classifyFailure(gatewayFailure(503)), 'gateway');
  assert.equal(classifyFailure(gatewayFailure(502)), 'gateway');
  assert.equal(classifyFailure(gatewayFailure(504)), 'gateway');
  assert.equal(classifyFailure(Object.assign(new Error('server error'), { status: 500 })), 'transient');
  assert.equal(classifyFailure(Object.assign(new Error('slow down'), { status: 429 })), 'transient');
  assert.equal(classifyFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), 'transient');
  assert.equal(classifyFailure(new Error('fetch failed')), 'transient');
  assert.equal(classifyFailure(sessionMissing()), 'session');
  assert.equal(classifyFailure({ code: -32002 }), 'concurrency');
  assert.equal(classifyFailure(new UnauthorizedError()), 'auth');
  assert.equal(classifyFailure(new Error('not_found')), undefined);
  // Older transport paths only embed the status in the message.
  assert.equal(classifyFailure(new Error('Error POSTing to endpoint: 503 Service Temporarily Unavailable')), 'gateway');
});

test('only a gateway rejection is replayed for every call', () => {
  assert.equal(isRetryableFailure('gateway', { idempotent: false }), true);
  assert.equal(isRetryableFailure('gateway', { idempotent: true }), true);
  assert.equal(isRetryableFailure('transient', { idempotent: true }), true);
  assert.equal(isRetryableFailure('transient', { idempotent: false }), false);
  assert.equal(isRetryableFailure('session', { idempotent: true }), false);
  assert.equal(isRetryableFailure('concurrency', { idempotent: true }), false);
  assert.equal(isRetryableFailure('auth', { idempotent: true }), false);
  assert.equal(isRetryableFailure(undefined, { idempotent: true }), false);
});

test('backoff grows exponentially with equal jitter and respects the cap', () => {
  const policy = { baseDelayMs: 500, maxDelayMs: 8_000 };
  assert.equal(backoffDelay(1, policy, () => 0), 250);
  assert.equal(backoffDelay(1, policy, () => 1), 500);
  assert.equal(backoffDelay(2, policy, () => 1), 1_000);
  assert.equal(backoffDelay(3, policy, () => 1), 2_000);
  assert.equal(backoffDelay(10, { baseDelayMs: 500, maxDelayMs: 3_000 }, () => 1), 3_000, 'the cap holds');
  assert.ok(backoffDelay(3) >= 1_000 && backoffDelay(3) <= 2_000, 'the default policy stays inside its jitter bounds');
  assert.equal(TRANSIENT_RETRY_POLICY.maxRetries, 3);
});

test('a gateway page is never surfaced as markup', () => {
  assert.equal(describeFailure(gatewayFailure(503)), 'FlowUs gateway is temporarily unavailable (HTTP 503)');
  assert.equal(describeFailure(Object.assign(new Error('x'), { status: 429 })), 'FlowUs is rate limiting this client (HTTP 429)');
  assert.equal(describeFailure(Object.assign(new Error('x'), { status: 500 })), 'FlowUs failed this request (HTTP 500)');

  const stripped = describeFailure(new Error('boom <html><head><title>503</title></head><body>nginx</body></html>'));
  assert.ok(!/[<>]/u.test(stripped), `expected no markup, got ${stripped}`);
  assert.match(stripped, /boom/u);
  assert.match(stripped, /nginx/u);

  const long = describeFailure(new Error('x'.repeat(500)));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('a read-only call rides out gateway 503s and logs each retry', async () => {
  let attempt = 0;
  const { session, state } = fakeSession({
    onCall: () => {
      attempt += 1;
      if (attempt <= 2) throw gatewayFailure(503);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  });
  await session.connect();
  const value = await session.callTool('flowus_search_text', {}, { idempotent: true });
  assert.equal(value.text, 'ok');
  assert.equal(state.calls, 3);
  assert.match(state.logs.join('\n'), /failed transiently; retrying/u);
});

test('a gateway rejection is replayed even for a write, because it never ran', async () => {
  let attempt = 0;
  const { session, state } = fakeSession({
    onCall: () => {
      attempt += 1;
      if (attempt === 1) throw gatewayFailure(503);
      return { content: [] };
    },
  });
  await session.connect();
  await session.callTool('flowus_create_page', { title: 'x' });
  assert.equal(state.calls, 2);
});

test('an ambiguous failure is never replayed for a write', async () => {
  const { session, state } = fakeSession({
    onCall: () => {
      throw Object.assign(new Error('server error'), { status: 500 });
    },
  });
  await session.connect();
  await assert.rejects(session.callTool('flowus_create_page', {}), /server error/u);
  assert.equal(state.calls, 1, 'a write is not replayed while it may already have been applied');
});

test('an ambiguous failure is replayed for a read', async () => {
  let attempt = 0;
  const { session, state } = fakeSession({
    onCall: () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('server error'), { status: 500 });
      return { content: [] };
    },
  });
  await session.connect();
  await session.callTool('flowus_search_text', {}, { idempotent: true });
  assert.equal(state.calls, 2);
});

test('retries are bounded and the last failure is what surfaces', async () => {
  const { session, state } = fakeSession({
    onCall: () => {
      throw gatewayFailure(503);
    },
  });
  await session.connect();
  await assert.rejects(session.callTool('flowus_search_text', {}, { idempotent: true }), /503/u);
  assert.equal(state.calls, 1 + FAST_RETRY.maxRetries);
  assert.match(state.logs.join('\n'), /failed \(gateway\): FlowUs gateway is temporarily unavailable/u);
});

test('tool discovery retries a gateway rejection before giving up', async () => {
  let listed = 0;
  const { session } = fakeSession({
    onList: () => {
      listed += 1;
      if (listed === 1) throw gatewayFailure(503);
      return { tools: [{ name: 'flowus_help' }] };
    },
  });
  await session.connect();
  const tools = await session.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['flowus_help'],
  );
  assert.equal(listed, 2);
});

test('a cancelled call stops waiting for its retry', async () => {
  const controller = new AbortController();
  const { session } = fakeSession({
    onCall: () => {
      controller.abort();
      throw gatewayFailure(503);
    },
  });
  await session.connect();
  await assert.rejects(session.callTool('flowus_search_text', {}, { idempotent: true, signal: controller.signal }), /cancelled/u);
});
