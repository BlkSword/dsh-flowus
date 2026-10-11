/**
 * Browser authorization-code + PKCE login for the FlowUs MCP server.
 *
 * The sequence is the SDK's two-leg `auth()` flow:
 *
 * 1. `auth(provider, { serverUrl, scope, forceReauthorization: true })` performs
 *    RFC 9728/8414 discovery, dynamically registers this client when no stored
 *    registration exists, mints a PKCE verifier, and calls
 *    `redirectToAuthorization`.
 * 2. The user approves in the browser; the loopback listener captures
 *    `code` (+ `iss`).
 * 3. `auth(provider, { serverUrl, scope, authorizationCode, iss })` exchanges the
 *    code and persists the token set (including the refresh token).
 *
 * No secret ever passes through chat, configuration, or an environment
 * variable: the client is public (`token_endpoint_auth_method: "none"`), the
 * code is bound to a PKCE verifier, and the refresh token lives only in the
 * private state file.
 *
 * @module dsh-flowus/login
 */

import { randomUUID } from 'node:crypto';
import { auth } from '@modelcontextprotocol/client';
import { DEFAULT_CALLBACK_PATH, DEFAULT_CALLBACK_PORT, startCallbackServer } from './callback-server.js';
import { FlowusOAuthProvider } from './oauth-provider.js';
import { openInBrowser } from './browser.js';

/** How long a login waits for the browser before giving up. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

/** The login produced no authorization code in time. */
export class FlowusLoginTimeoutError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FlowusLoginTimeoutError';
  }
}

/**
 * Wait for the loopback listener, bounded by a timer and the caller's signal.
 * @param {{ waitForCode: (signal?: AbortSignal) => Promise<{ code: string, state: string, iss?: string }> }} server
 * @param {{ timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<{ code: string, state: string, iss?: string }>}
 */
async function waitForAuthorizationCode(server, options) {
  const { timeoutMs, signal } = options;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new Error('FlowUs login was cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer;
  try {
    return await Promise.race([
      server.waitForCode(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new FlowusLoginTimeoutError(
              `FlowUs login timed out after ${Math.round(timeoutMs / 1000)}s: no authorization callback arrived. Run /flowus login again.`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Run one interactive login.
 * @param {object} options
 * @param {import('./store.js').JsonStateStore} options.store - durable OAuth state.
 * @param {string} options.serverUrl - MCP resource URL, e.g. `https://mcp.flowus.cn/message`.
 * @param {string} [options.scope] - requested scope; defaults to the server's published scope.
 * @param {string} [options.clientName] - `client_name` for dynamic registration.
 * @param {number} [options.callbackPort] - preferred loopback port (`0` = ephemeral).
 * @param {string} [options.callbackPath] - loopback callback path.
 * @param {string} [options.callbackHost] - loopback host.
 * @param {number} [options.timeoutMs] - browser wait budget.
 * @param {boolean} [options.openBrowser] - whether to launch the default browser.
 * @param {AbortSignal} [options.signal] - cancellation from the invoking UI request.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @param {(url: URL) => void | Promise<void>} [options.onAuthorizationUrl] - observe the URL.
 * @returns {Promise<{ authorizationUrl: string, redirectUrl: string, browserOpened: boolean, browserDetail?: string }>}
 */
export async function loginToFlowus(options) {
  const log = options.log ?? (() => {});
  const state = randomUUID();
  const server = await startCallbackServer({
    state,
    port: options.callbackPort ?? DEFAULT_CALLBACK_PORT,
    path: options.callbackPath ?? DEFAULT_CALLBACK_PATH,
    host: options.callbackHost,
    log,
    signals: [options.signal],
  });

  let browserOpened = false;
  /** @type {string | undefined} */
  let browserDetail;
  const provider = new FlowusOAuthProvider({
    store: options.store,
    redirectUrl: server.redirectUrl,
    clientName: options.clientName,
    state,
    log,
    onRedirect: async (authorizationUrl) => {
      if (options.openBrowser === false) return;
      const opened = await openInBrowser(authorizationUrl.toString());
      browserOpened = opened.opened;
      browserDetail = opened.detail;
      if (!opened.opened) {
        log(`flowus: could not open a browser (${opened.detail ?? 'unknown reason'}); open this URL manually: ${authorizationUrl}`);
      }
    },
  });

  try {
    if (await provider.redirectUrlChanged(server.redirectUrl)) {
      log('flowus: the loopback redirect URI changed; re-registering this client and re-discovering the authorization server');
      await provider.invalidateCredentials('client');
      await provider.invalidateCredentials('discovery');
    }
    await provider.rememberRedirectUrl(server.redirectUrl);
    if (options.signal?.aborted) throw new Error('FlowUs login was cancelled');

    /** @type {import('@modelcontextprotocol/client').AuthOptions} */
    const authOptions = { serverUrl: options.serverUrl, forceReauthorization: true };
    if (options.scope) authOptions.scope = options.scope;
    const firstLeg = await auth(provider, authOptions);
    const authorizationUrl = provider.authorizationUrl;
    if (firstLeg === 'AUTHORIZED' && authorizationUrl === undefined) {
      // Only reachable for a non-interactive provider; kept for completeness.
      return { authorizationUrl: '', redirectUrl: server.redirectUrl, browserOpened };
    }
    if (authorizationUrl === undefined) {
      throw new Error('flowus: the authorization server did not produce a browser URL');
    }
    await options.onAuthorizationUrl?.(authorizationUrl);

    const callback = await waitForAuthorizationCode(server, {
      timeoutMs: options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      signal: options.signal,
    });

    /** @type {import('@modelcontextprotocol/client').AuthOptions} */
    const exchangeOptions = { serverUrl: options.serverUrl, authorizationCode: callback.code };
    if (options.scope) exchangeOptions.scope = options.scope;
    if (typeof callback.iss === 'string' && callback.iss.length > 0) exchangeOptions.iss = callback.iss;
    const secondLeg = await auth(provider, exchangeOptions);
    if (secondLeg !== 'AUTHORIZED') {
      throw new Error(`flowus: the authorization code was not exchanged (${secondLeg}); run /flowus login again`);
    }
    return {
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl: server.redirectUrl,
      browserOpened,
      ...(browserDetail ? { browserDetail } : {}),
    };
  } finally {
    await server.close();
  }
}
