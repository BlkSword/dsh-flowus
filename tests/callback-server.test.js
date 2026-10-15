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

test('a callback without this login attempt state is ignored, never accepted', async () => {
  const server = await startCallbackServer({ state: 's-3', port: 0, log: () => {} });
  try {
    const refused = await get(`${server.redirectUrl}?code=c&state=attacker`);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /ignored/iu);

    // The rejection did not settle the login: the real redirect still lands.
    const accepted = await get(`${server.redirectUrl}?code=the-code&state=s-3`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await server.waitForCode(), { code: 'the-code', state: 's-3', iss: undefined });
  } finally {
    await server.close();
  }
});

test('an error redirect without a matching state cannot cancel a pending login', async () => {
  const server = await startCallbackServer({ state: 's-3b', port: 0, log: () => {} });
  try {
    // Any local process can reach loopback; before the state check this killed
    // the login outright.
    const refused = await get(`${server.redirectUrl}?error=access_denied&error_description=user+refused`);
    assert.equal(refused.status, 400);

    const accepted = await get(`${server.redirectUrl}?code=kept&state=s-3b`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await server.waitForCode(), { code: 'kept', state: 's-3b', iss: undefined });
  } finally {
    await server.close();
  }
});

test('duplicated or missing single-value parameters are ignored', async () => {
  const server = await startCallbackServer({ state: 's-3c', port: 0, log: () => {} });
  try {
    const duplicated = await get(`${server.redirectUrl}?code=a&code=b&state=s-3c`);
    assert.equal(duplicated.status, 400);
    const doublyStated = await get(`${server.redirectUrl}?code=a&state=s-3c&state=s-3c`);
    assert.equal(doublyStated.status, 400);
    const bare = await get(server.redirectUrl);
    assert.equal(bare.status, 400);

    const accepted = await get(`${server.redirectUrl}?code=the-code&state=s-3c`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await server.waitForCode(), { code: 'the-code', state: 's-3c', iss: undefined });
  } finally {
    await server.close();
  }
});

test('only GET is accepted on the callback path', async () => {
  const server = await startCallbackServer({ state: 's-3d', port: 0, log: () => {} });
  try {
    const posted = await fetch(server.redirectUrl, { method: 'POST', body: 'code=c&state=s-3d' });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get('allow'), 'GET');

    const accepted = await get(`${server.redirectUrl}?code=the-code&state=s-3d`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await server.waitForCode(), { code: 'the-code', state: 's-3d', iss: undefined });
  } finally {
    await server.close();
  }
});

test('server-supplied error text reaches the page escaped and truncated', async () => {
  const server = await startCallbackServer({ state: 's-3d2', port: 0, log: () => {} });
  try {
    const hostile = `<img src=x onerror=alert(1)>${'x'.repeat(500)}`;
    const response = await get(`${server.redirectUrl}?error=${encodeURIComponent(hostile)}&state=s-3d2`);
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.ok(!body.includes('<img'), 'the injected tag must not survive as markup');
    assert.match(body, /&lt;img/u);
    assert.ok(body.length < 2_000, 'the echo is truncated');
    await assert.rejects(server.waitForCode(), /authorization failed/u);
  } finally {
    await server.close();
  }
});

test('a non-loopback callback host is refused', async () => {
  await assert.rejects(
    startCallbackServer({ state: 's-3e', port: 0, host: '0.0.0.0', log: () => {} }),
    /loopback/u,
  );
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
