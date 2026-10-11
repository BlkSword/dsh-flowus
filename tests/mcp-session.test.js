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
  createSerialQueue,
  isAuthRequired,
  isConcurrencyRejection,
  normalizeCallToolResult,
} from '../lib/mcp-session.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  assert.equal(value.blocks.length, 7, 'raw blocks are preserved verbatim');
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
