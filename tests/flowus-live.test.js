/**
 * Live smoke tests against the real FlowUs MCP server.
 *
 * Skipped unless `DSH_FLOWUS_LIVE=1` is set, because they reach the network.
 * They never open a browser, never complete an authorization code exchange,
 * and never perform dynamic client registration: this machine already holds one
 * throwaway public-client registration for the redirect URI below, and reusing
 * it keeps the registration endpoint's rate limit for the real `/flowus login`.
 *
 * Run with:  DSH_FLOWUS_LIVE=1 node --test tests/flowus-live.test.js
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auth } from '@modelcontextprotocol/client';
import { FlowusMcpSession } from '../lib/mcp-session.js';
import { FlowusOAuthProvider } from '../lib/oauth-provider.js';
import { JsonStateStore } from '../lib/store.js';

const live = process.env.DSH_FLOWUS_LIVE === '1';
const skip = live ? false : 'set DSH_FLOWUS_LIVE=1 to run the network smoke tests';

const SERVER_URL = 'https://mcp.flowus.cn/message';
const PROBE_REDIRECT = 'http://127.0.0.1:8765/callback';
const PROBE_CLIENT_ID = process.env.DSH_FLOWUS_SMOKE_CLIENT_ID ?? '2bf63157-2f82-49af-930f-7dbe5be71b23';

/** @returns {Promise<JsonStateStore>} */
const freshStore = async () => new JsonStateStore(join(await mkdtemp(join(tmpdir(), 'dsh-flowus-live-')), 'oauth.json'));

/** @returns {Promise<FlowusOAuthProvider>} a provider seeded with the smoke registration */
async function seededProvider(redirectUrl = PROBE_REDIRECT) {
  const store = await freshStore();
  const provider = new FlowusOAuthProvider({ store, redirectUrl, clientName: 'DSH FlowUs smoke test', state: 'smoke-state', log: () => {} });
  await provider.saveClientInformation({ client_id: PROBE_CLIENT_ID, redirect_uris: [redirectUrl], token_endpoint_auth_method: 'none' });
  return provider;
}

test('FlowUs publishes the discovery documents this plugin requires', { skip }, async () => {
  const resourceResponse = await fetch('https://mcp.flowus.cn/.well-known/oauth-protected-resource');
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, SERVER_URL);
  assert.deepEqual(resource.authorization_servers, ['https://mcp.flowus.cn']);

  const metadataResponse = await fetch('https://mcp.flowus.cn/.well-known/oauth-authorization-server');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  // RFC 8414 §3.3 echo check the SDK performs for us.
  assert.equal(metadata.issuer, 'https://mcp.flowus.cn');
  assert.ok(metadata.response_types_supported.includes('code'));
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.ok(metadata.token_endpoint_auth_methods_supported.includes('none'), 'a public client needs "none"');
  assert.ok(metadata.registration_endpoint, 'dynamic client registration must be advertised');
  assert.ok(metadata.token_endpoint.startsWith('https://'));
  assert.equal(metadata.authorization_endpoint, 'https://api.flowus.cn/oauth/authorize');
});

test('the SDK builds a PKCE authorization URL without registering a new client', { skip }, async () => {
  const provider = await seededProvider();
  const result = await auth(provider, { serverUrl: SERVER_URL, scope: 'all' });
  assert.equal(result, 'REDIRECT');
  const url = new URL(provider.authorizationUrl);
  assert.equal(url.origin, 'https://api.flowus.cn');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), PROBE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), PROBE_REDIRECT);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.equal(url.searchParams.get('state'), 'smoke-state');
  assert.equal(url.searchParams.get('scope'), 'all');
  // Discovered state is persisted for the callback leg of a real login.
  assert.equal((await provider.discoveryState()).authorizationServerUrl, 'https://mcp.flowus.cn');
});

test('an unauthorized MCP connect is reported as "authorize in the browser", not a raw transport error', { skip }, async () => {
  const provider = await seededProvider();
  const session = new FlowusMcpSession({ serverUrl: SERVER_URL, scope: 'all', provider, log: () => {}, toolCallTimeoutMs: 20_000 });
  try {
    await assert.rejects(session.connect({ signal: AbortSignal.timeout(30_000) }), (error) => {
      assert.equal(error.name, 'FlowusAuthRequiredError');
      assert.match(error.message, /\/flowus login/u);
      return true;
    });
    // The transport's 401 path drove the OAuth redirect, which the silent
    // provider captures instead of opening a browser.
    assert.ok((provider.authorizationUrl ?? '').toString().startsWith('https://api.flowus.cn/oauth/authorize'));
    assert.equal(session.connected, false);
  } finally {
    await session.close();
  }
});
