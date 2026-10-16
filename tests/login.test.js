/**
 * Offline tests for the interactive login orchestration.
 *
 * Every test drives `loginToFlowus` through its `authImpl` seam: the two legs of
 * the SDK exchange are the only part of the flow that reaches the network, and
 * the seam lets each leg be scripted instead. The loopback callback listener is
 * real (bound to port 0) and is reached with `fetch`, exactly as the browser
 * would reach it — nothing here leaves the machine.
 *
 * The seam exists for these tests and nothing else: a caller that passes no
 * `authImpl` keeps using the SDK's own `auth()`.
 *
 * Every login also gets an explicit `timeoutMs` budget, so a fixture that
 * forgets to deliver its callback fails as a timeout instead of hanging the run.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FlowusLoginTimeoutError, loginToFlowus } from '../lib/login.js';
import { JsonStateStore } from '../lib/store.js';

const SERVER_URL = 'https://mcp.flowus.cn/message';
const AUTHORIZE_URL = 'https://api.flowus.cn/oauth/authorize?client_id=abc&response_type=code&state=whatever';
const ISSUER = 'https://mcp.flowus.cn';

/** @returns {Promise<JsonStateStore>} an empty store in a fresh temporary directory. */
const freshStore = async () => new JsonStateStore(join(await mkdtemp(join(tmpdir(), 'dsh-flowus-login-')), 'oauth.json'));

/** @param {string} url */
const get = async (url) => fetch(url, { redirect: 'manual' });

test('the two-leg exchange completes and the result names the bound loopback URL', async () => {
  const store = await freshStore();
  const legs = [];
  const observed = [];
  /** @type {import('../lib/oauth-provider.js').FlowusOAuthProvider | undefined} */
  let provider;
  /** @type {Response | undefined} */
  let callbackResponse;

  const result = await loginToFlowus({
    store,
    serverUrl: SERVER_URL,
    callbackPort: 0,
    timeoutMs: 10_000,
    openBrowser: false,
    log: () => {},
    onAuthorizationUrl: (url) => observed.push(url.toString()),
    authImpl: async (oauthProvider, options) => {
      provider = oauthProvider;
      legs.push(options);
      if (options.authorizationCode === undefined) {
        await oauthProvider.redirectToAuthorization(new URL(AUTHORIZE_URL));
        // The browser follows the redirect while the login waits on the
        // loopback listener, so the callback settles before this leg returns.
        callbackResponse = await get(
          `${oauthProvider.redirectUrl}?code=the-code&state=${oauthProvider.state()}&iss=${encodeURIComponent(ISSUER)}`,
        );
        return 'REDIRECT';
      }
      return 'AUTHORIZED';
    },
  });

  assert.equal(callbackResponse?.status, 200);
  assert.equal(result.authorizationUrl, AUTHORIZE_URL);
  assert.deepEqual(observed, [AUTHORIZE_URL]);
  assert.equal(result.browserOpened, false);
  assert.equal(result.browserDetail, undefined);

  // The result reports the URL the loopback listener actually bound: an
  // ephemeral port the login learned from the socket, not the requested 0.
  assert.match(result.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal(result.redirectUrl, provider?.redirectUrl);
  assert.deepEqual(provider?.clientMetadata.redirect_uris, [result.redirectUrl]);

  // The second leg receives the code and issuer the callback carried, and the
  // first leg asked for a forced re-authorization.
  assert.deepEqual(legs, [
    { serverUrl: SERVER_URL, forceReauthorization: true },
    { serverUrl: SERVER_URL, authorizationCode: 'the-code', iss: ISSUER },
  ]);
});

test('an already-authorized first leg returns without waiting for a callback', async () => {
  const store = await freshStore();
  const legs = [];

  const result = await loginToFlowus({
    store,
    serverUrl: SERVER_URL,
    callbackPort: 0,
    openBrowser: false,
    // No log sink is passed, so the default no-op sink is used. The timer is
    // deliberately tight: if this edge waited for a callback it would have to
    // time out, but it must return straight away instead.
    timeoutMs: 10,
    authImpl: async (_provider, options) => {
      legs.push(options);
      return 'AUTHORIZED';
    },
  });

  assert.equal(result.authorizationUrl, '');
  assert.match(result.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal(result.browserOpened, false);
  assert.deepEqual(legs, [{ serverUrl: SERVER_URL, forceReauthorization: true }]);
});

test('a first leg that produces no authorization URL is a loud error', async () => {
  const store = await freshStore();
  /** @type {string | undefined} */
  let redirectUrl;

  await assert.rejects(
    loginToFlowus({
      store,
      serverUrl: SERVER_URL,
      callbackPort: 0,
      openBrowser: false,
      log: () => {},
      authImpl: async (provider) => {
        redirectUrl = provider.redirectUrl;
        return 'REDIRECT';
      },
    }),
    /did not produce a browser URL/u,
  );

  // The failed login still closed its listener.
  await assert.rejects(get(`${redirectUrl}?code=the-code&state=whatever`));
});

test('a second leg that does not exchange the code is a loud error', async () => {
  const store = await freshStore();

  await assert.rejects(
    loginToFlowus({
      store,
      serverUrl: SERVER_URL,
      callbackPort: 0,
      timeoutMs: 10_000,
      openBrowser: false,
      log: () => {},
      authImpl: async (provider, options) => {
        if (options.authorizationCode === undefined) {
          await provider.redirectToAuthorization(new URL(AUTHORIZE_URL));
          await get(`${provider.redirectUrl}?code=the-code&state=${provider.state()}`);
          return 'REDIRECT';
        }
        return 'REDIRECT';
      },
    }),
    /was not exchanged \(REDIRECT\)/u,
  );
});

test('with the browser launch disabled the login still completes', async () => {
  const store = await freshStore();
  /** @type {import('../lib/oauth-provider.js').FlowusOAuthProvider | undefined} */
  let provider;
  /** @type {Response | undefined} */
  let callbackResponse;

  const result = await loginToFlowus({
    store,
    serverUrl: SERVER_URL,
    callbackPort: 0,
    timeoutMs: 10_000,
    openBrowser: false,
    log: () => {},
    onAuthorizationUrl: async () => {
      // Delivered from the observation hook instead: the callback can settle
      // the listener before the login attaches its awaiter.
      callbackResponse = await get(`${provider?.redirectUrl}?code=manual&state=${provider?.state()}`);
    },
    authImpl: async (oauthProvider, options) => {
      provider = oauthProvider;
      if (options.authorizationCode === undefined) {
        await oauthProvider.redirectToAuthorization(new URL(AUTHORIZE_URL));
        return 'REDIRECT';
      }
      assert.equal(options.authorizationCode, 'manual');
      return 'AUTHORIZED';
    },
  });

  assert.equal(callbackResponse?.status, 200);
  assert.equal(result.browserOpened, false);
  assert.equal('browserDetail' in result, false);
  assert.equal(result.authorizationUrl, AUTHORIZE_URL);
});

test('cancellation rejects the login and still closes the listener', async () => {
  const store = await freshStore();
  const controller = new AbortController();
  /** @type {string | undefined} */
  let redirectUrl;

  await assert.rejects(
    loginToFlowus({
      store,
      serverUrl: SERVER_URL,
      callbackPort: 0,
      openBrowser: false,
      signal: controller.signal,
      log: () => {},
      authImpl: async (provider) => {
        redirectUrl = provider.redirectUrl;
        await provider.redirectToAuthorization(new URL(AUTHORIZE_URL));
        // The user cancels while the login waits on the listener.
        setTimeout(() => controller.abort(), 0);
        return 'REDIRECT';
      },
    }),
    /cancel/u,
  );

  await assert.rejects(get(`${redirectUrl}?code=the-code&state=whatever`));
});

test('a login with no callback times out loudly', async () => {
  const store = await freshStore();

  await assert.rejects(
    loginToFlowus({
      store,
      serverUrl: SERVER_URL,
      callbackPort: 0,
      openBrowser: false,
      timeoutMs: 25,
      log: () => {},
      authImpl: async (provider) => {
        await provider.redirectToAuthorization(new URL(AUTHORIZE_URL));
        return 'REDIRECT';
      },
    }),
    (error) => {
      assert.ok(error instanceof FlowusLoginTimeoutError);
      assert.match(error.message, /timed out/u);
      assert.match(error.message, /Run \/flowus login again/u);
      return true;
    },
  );
});

test('FlowusLoginTimeoutError carries its own name for callers that branch on it', () => {
  const error = new FlowusLoginTimeoutError('FlowUs login timed out after 300s');
  assert.equal(error.name, 'FlowusLoginTimeoutError');
  assert.ok(error instanceof Error);
  assert.match(error.message, /timed out/u);
});

test('a changed loopback redirect invalidates the stored client and discovery state first', async () => {
  const store = await freshStore();
  await store.mutate((document) => ({
    ...document,
    clientInformation: { client_id: 'stale-client' },
    discoveryState: { authorizationServerUrl: ISSUER },
    redirectUrl: 'http://127.0.0.1:1/callback',
  }));

  let clientAtFirstLeg;
  let discoveryAtFirstLeg;
  /** @type {import('../lib/oauth-provider.js').FlowusOAuthProvider | undefined} */
  let provider;

  const result = await loginToFlowus({
    store,
    serverUrl: SERVER_URL,
    callbackPort: 0,
    timeoutMs: 10_000,
    openBrowser: false,
    // No log sink: the default no-op sink absorbs the re-registration
    // diagnostics this path emits.
    authImpl: async (oauthProvider, options) => {
      provider = oauthProvider;
      if (options.authorizationCode === undefined) {
        // Re-registration happens before discovery: neither credential from
        // the previous loopback port may be offered to the server again.
        clientAtFirstLeg = await oauthProvider.clientInformation();
        discoveryAtFirstLeg = await oauthProvider.discoveryState();
        await oauthProvider.redirectToAuthorization(new URL(AUTHORIZE_URL));
        await get(`${oauthProvider.redirectUrl}?code=the-code&state=${oauthProvider.state()}`);
        return 'REDIRECT';
      }
      return 'AUTHORIZED';
    },
  });

  assert.equal(clientAtFirstLeg, undefined);
  assert.equal(discoveryAtFirstLeg, undefined);
  assert.equal(await provider?.clientInformation(), undefined);
  assert.equal(await provider?.discoveryState(), undefined);

  const document = await store.read();
  assert.equal(document.clientInformation, undefined);
  assert.equal(document.discoveryState, undefined);
  assert.equal(document.redirectUrl, result.redirectUrl);
});
