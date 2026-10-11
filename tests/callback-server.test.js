import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCallbackServer } from '../lib/callback-server.js';

/** @param {string} url */
const get = async (url) => fetch(url, { redirect: 'manual' });

test('a matching state and code resolve the pending login', async () => {
  const server = await startCallbackServer({ state: 's-1', port: 0, log: () => {} });
  try {
    assert.match(server.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    assert.ok(server.port > 0);
    const response = await get(`${server.redirectUrl}?code=the-code&state=s-1`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /authorized/iu);
    assert.deepEqual(await server.waitForCode(), { code: 'the-code', state: 's-1', iss: undefined });
  } finally {
    await server.close();
  }
});

test('an iss parameter is forwarded for RFC 9207 validation', async () => {
  const server = await startCallbackServer({ state: 's-2', port: 0 });
  try {
    await get(`${server.redirectUrl}?code=c&state=s-2&iss=${encodeURIComponent('https://mcp.flowus.cn')}`);
    assert.deepEqual(await server.waitForCode(), { code: 'c', state: 's-2', iss: 'https://mcp.flowus.cn' });
  } finally {
    await server.close();
  }
});

test('a mismatched state is refused and fails the login', async () => {
  const server = await startCallbackServer({ state: 's-3', port: 0 });
  try {
    const pending = assert.rejects(server.waitForCode(), /unexpected state/u);
    const response = await get(`${server.redirectUrl}?code=c&state=attacker`);
    assert.equal(response.status, 400);
    await pending;
  } finally {
    await server.close();
  }
});

test('a missing code is refused', async () => {
  const server = await startCallbackServer({ state: 's-4', port: 0 });
  try {
    const pending = assert.rejects(server.waitForCode(), /no code/u);
    const response = await get(`${server.redirectUrl}?state=s-4`);
    assert.equal(response.status, 400);
    await pending;
  } finally {
    await server.close();
  }
});

test('an error redirect is surfaced verbatim', async () => {
  const server = await startCallbackServer({ state: 's-5', port: 0 });
  try {
    const pending = assert.rejects(server.waitForCode(), /access_denied \(user refused\)/u);
    const response = await get(`${server.redirectUrl}?error=access_denied&error_description=user+refused&state=s-5`);
    assert.equal(response.status, 400);
    await pending;
  } finally {
    await server.close();
  }
});

test('other paths are not the callback', async () => {
  const server = await startCallbackServer({ state: 's-6', port: 0 });
  try {
    const response = await get(`http://127.0.0.1:${server.port}/other?code=c&state=s-6`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test('a busy preferred port falls back to an ephemeral one', async () => {
  const first = await startCallbackServer({ state: 's-7', port: 0, log: () => {} });
  const logs = [];
  const second = await startCallbackServer({ state: 's-8', port: first.port, log: (message) => logs.push(message) });
  try {
    assert.notEqual(second.port, first.port);
    assert.match(logs.join('\n'), /is busy/u);
  } finally {
    await second.close();
    await first.close();
  }
});

test('an abort signal fails the pending login', async () => {
  const controller = new AbortController();
  const server = await startCallbackServer({ state: 's-9', port: 0, signals: [controller.signal] });
  try {
    const pending = server.waitForCode();
    controller.abort();
    await assert.rejects(pending, /cancelled/u);
  } finally {
    await server.close();
  }
});
