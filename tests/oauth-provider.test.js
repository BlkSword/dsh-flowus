import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FlowusOAuthProvider, describeTokens, issuersMatch, sameResourceUrl, tokensAreStale } from '../lib/oauth-provider.js';
import { JsonStateStore } from '../lib/store.js';

/** @returns {Promise<{ store: JsonStateStore, provider: FlowusOAuthProvider, redirects: string[], logs: string[] }>} */
async function fixture(redirectUrl = 'http://127.0.0.1:42813/callback') {
  const store = new JsonStateStore(join(await mkdtemp(join(tmpdir(), 'dsh-flowus-oauth-')), 'oauth.json'));
  const redirects = [];
  const logs = [];
  const provider = new FlowusOAuthProvider({
    store,
    redirectUrl,
    clientName: 'Test Client',
    state: 'fixed-state',
    log: (message) => logs.push(message),
    onRedirect: (url) => redirects.push(url.toString()),
  });
  return { store, provider, redirects, logs };
}

test('client metadata is a public client bound to the loopback redirect', async () => {
  const { provider } = await fixture();
  assert.deepEqual(provider.clientMetadata, {
    redirect_uris: ['http://127.0.0.1:42813/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Test Client',
    software_id: 'dsh-flowus',
  });
  assert.equal(provider.redirectUrl, 'http://127.0.0.1:42813/callback');
});

test('state is stable for the provider lifetime', async () => {
  const { provider } = await fixture();
  assert.equal(provider.state(), 'fixed-state');
  assert.equal(provider.state(), provider.state());
});

test('client information and tokens round-trip with the issuer stamp', async () => {
  const { provider } = await fixture();
  assert.equal(await provider.clientInformation(), undefined);
  await provider.saveClientInformation({ client_id: 'abc' }, { issuer: 'https://mcp.flowus.cn' });
  assert.deepEqual(await provider.clientInformation(), { client_id: 'abc', issuer: 'https://mcp.flowus.cn' });

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_in: 3600 }, { issuer: 'https://mcp.flowus.cn' });
  const tokens = await provider.tokens();
  assert.equal(tokens.access_token, 'a');
  assert.equal(tokens.refresh_token, 'r');
  assert.equal(tokens.issuer, 'https://mcp.flowus.cn');
  assert.equal(typeof tokens.obtainedAt, 'number');
});

test('an unstamped client read is stamped from the SDK context without a write', async () => {
  const { provider, store } = await fixture();
  await provider.saveClientInformation({ client_id: 'abc' });
  const stamped = await provider.clientInformation({ issuer: 'https://mcp.flowus.cn' });
  assert.equal(stamped.issuer, 'https://mcp.flowus.cn');
  assert.equal((await store.read()).clientInformation.issuer, undefined);
});

test('a credential bound to another authorization server is never presented', async () => {
  const { provider, logs } = await fixture();
  const flowus = 'https://mcp.flowus.cn';
  await provider.saveClientInformation({ client_id: 'abc' }, { issuer: flowus });
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' }, { issuer: flowus });

  // The transport's bearer-token path reads with no context and is unaffected.
  assert.equal((await provider.tokens()).access_token, 'a');
  assert.ok(await provider.clientInformation());

  // Another authorization server gets nothing, and the reason is logged.
  assert.equal(await provider.tokens({ issuer: 'https://evil.example' }), undefined);
  assert.equal(await provider.clientInformation({ issuer: 'https://evil.example' }), undefined);
  assert.equal(logs.filter((line) => line.includes('withholding it')).length, 2);

  // Withheld, not deleted: the issuer that owns the credential still reads it.
  assert.equal((await provider.tokens({ issuer: flowus })).refresh_token, 'r');
  assert.equal((await provider.clientInformation({ issuer: flowus })).client_id, 'abc');
});

test('the issuer comparison tolerates one trailing slash, as the SDK does', async () => {
  const { provider } = await fixture();
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: 'https://mcp.flowus.cn/' });
  assert.equal((await provider.tokens({ issuer: 'https://mcp.flowus.cn' })).access_token, 'a');
  assert.equal(await provider.tokens({ issuer: 'https://mcp.flowus.cn/other' }), undefined);
});

test('an unstamped token set is read through for any issuer, and issuersMatch follows the tolerance rules', async () => {
  const { provider } = await fixture();
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
  assert.equal((await provider.tokens({ issuer: 'https://mcp.flowus.cn' })).access_token, 'a');

  assert.equal(issuersMatch('https://a', 'https://a'), true);
  assert.equal(issuersMatch('https://a/', 'https://a'), true);
  assert.equal(issuersMatch('https://a', 'https://a/'), true);
  assert.equal(issuersMatch('https://a', 'https://b'), false);
  assert.equal(issuersMatch('https://mcp.flowus.cn', 'https://mcp.flowus.cn.evil.example'), false);
  // The tolerance strips one trailing slash, exactly like the SDK's own copy.
  assert.equal(issuersMatch('https://a/', 'https://a//'), true);
});

test('redirectToAuthorization records the URL and delegates', async () => {
  const { provider, redirects } = await fixture();
  const url = new URL('https://api.flowus.cn/oauth/authorize?client_id=abc');
  await provider.redirectToAuthorization(url);
  assert.equal(provider.authorizationUrl.toString(), url.toString());
  assert.deepEqual(redirects, [url.toString()]);
});

test('code verifier round-trips and its absence is a loud error', async () => {
  const { provider } = await fixture();
  await assert.rejects(provider.codeVerifier(), /no PKCE code verifier/u);
  await provider.saveCodeVerifier('verifier-1');
  assert.equal(await provider.codeVerifier(), 'verifier-1');
});

test('discovery state, resource URL and the deprecated server URL all persist', async () => {
  const { provider } = await fixture();
  await provider.saveDiscoveryState({ authorizationServerUrl: 'https://mcp.flowus.cn' });
  await provider.saveResourceUrl('https://mcp.flowus.cn/message');
  await provider.saveAuthorizationServerUrl('https://mcp.flowus.cn');
  assert.equal((await provider.discoveryState()).authorizationServerUrl, 'https://mcp.flowus.cn');
  assert.equal(await provider.resourceUrl(), 'https://mcp.flowus.cn/message');
  assert.equal(await provider.authorizationServerUrl(), 'https://mcp.flowus.cn');
});

test('invalidateCredentials drops exactly the requested slice', async () => {
  const { provider } = await fixture();
  const seed = async () => {
    await provider.saveClientInformation({ client_id: 'abc' }, { issuer: 'iss' });
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' }, { issuer: 'iss' });
    await provider.saveCodeVerifier('v');
    await provider.saveDiscoveryState({ authorizationServerUrl: 'iss' });
    await provider.saveResourceUrl('https://mcp.flowus.cn/message');
  };

  await seed();
  await provider.invalidateCredentials('tokens');
  assert.equal(await provider.tokens(), undefined);
  assert.ok(await provider.clientInformation());

  await seed();
  await provider.invalidateCredentials('client');
  assert.equal(await provider.clientInformation(), undefined);
  assert.ok(await provider.tokens());

  await seed();
  await provider.invalidateCredentials('verifier');
  await assert.rejects(provider.codeVerifier(), /no PKCE code verifier/u);

  await seed();
  await provider.invalidateCredentials('discovery');
  assert.equal(await provider.discoveryState(), undefined);

  await seed();
  await provider.invalidateCredentials('all');
  assert.equal(await provider.clientInformation(), undefined);
  assert.equal(await provider.tokens(), undefined);
  assert.equal(await provider.discoveryState(), undefined);
  assert.equal(await provider.resourceUrl(), undefined);
});

test('an unknown invalidation scope is ignored, not fatal', async () => {
  const { provider } = await fixture();
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
  await provider.invalidateCredentials('nonsense');
  assert.ok(await provider.tokens());
});

test('redirect URL change detection drives re-registration', async () => {
  const { provider } = await fixture('http://127.0.0.1:42813/callback');
  assert.equal(await provider.redirectUrlChanged('http://127.0.0.1:42813/callback'), false);
  await provider.rememberRedirectUrl('http://127.0.0.1:42813/callback');
  assert.equal(await provider.redirectUrlChanged('http://127.0.0.1:42813/callback'), false);
  assert.equal(await provider.redirectUrlChanged('http://127.0.0.1:50123/callback'), true);
});

test('the constructor rejects a non-absolute redirect URL', () => {
  assert.throws(() => new FlowusOAuthProvider({ store: new JsonStateStore('x.json'), redirectUrl: '/callback' }), TypeError);
});

test('describeTokens reports expiry facts without leaking the token', () => {
  assert.deepEqual(describeTokens(undefined), { ok: false });
  const info = describeTokens({ access_token: 'secret', token_type: 'Bearer', expires_in: 60, obtainedAt: Date.now(), refresh_token: 'r' });
  assert.equal(info.ok, true);
  assert.equal(info.hasRefreshToken, true);
  assert.equal(info.expired, false);
  assert.ok(!JSON.stringify(info).includes('secret'));
});

test('tokensAreStale treats missing, expired and soon-expiring tokens as stale', () => {
  assert.equal(tokensAreStale(undefined), true);
  assert.equal(tokensAreStale({ access_token: 'a', token_type: 'Bearer' }), false);
  assert.equal(tokensAreStale({ access_token: 'a', token_type: 'Bearer', expires_in: 10, obtainedAt: Date.now() }), true);
  assert.equal(tokensAreStale({ access_token: 'a', token_type: 'Bearer', expires_in: 3600, obtainedAt: Date.now() }), false);
});

test('sameResourceUrl binds a URL to its resource, not to a look-alike', () => {
  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message', 'https://mcp.flowus.cn/message'), true);
  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message/', 'https://mcp.flowus.cn/message'), true);
  // An origin-only indicator still names the same server as one of its paths.
  assert.equal(sameResourceUrl('https://mcp.flowus.cn', 'https://mcp.flowus.cn/message'), true);
  assert.equal(sameResourceUrl('HTTPS://MCP.FlowUs.CN/message', 'https://mcp.flowus.cn/message'), true);

  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message', 'https://mcp.flowus.cn/messages'), false);
  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message', 'https://mcp.flowus.cn/other'), false);
  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message', 'https://mcp.flowus.cn.evil.example/message'), false);
  assert.equal(sameResourceUrl('https://mcp.flowus.cn/message', 'http://mcp.flowus.cn/message'), false);
  assert.equal(sameResourceUrl('not a url', 'https://mcp.flowus.cn/message'), false);
});
