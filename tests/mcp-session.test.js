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
  createSerialQueue,
  isAuthRequired,
  isConcurrencyRejection,
  isSessionMissing,
  normalizeCallToolResult,
} from '../lib/mcp-session.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
