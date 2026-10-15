/**
 * OAuth 2.1 client provider for the FlowUs MCP server.
 *
 * Implements the SDK's `OAuthClientProvider` contract on top of
 * {@link JsonStateStore}. Everything the SDK needs to survive a restart and to
 * refresh silently is persisted: the dynamically registered client identity,
 * the token set (with its `issuer` stamp), the PKCE code verifier, the
 * discovery state required on the callback leg, and the resource URL.
 *
 * The `issuer` stamp is not only recorded but enforced: when the SDK asks for
 * credentials on behalf of one authorization server, a credential stamped with
 * a different one is withheld ({@link FlowusOAuthProvider#tokens}) so it can
 * never be presented across a trust boundary — the SEP-2352 binding, held here
 * as well as in the SDK so an older client cannot reintroduce the gap.
 *
 * There is no static token anywhere in this flow: the authorization code is
 * obtained through the browser, exchanged with PKCE, and the refresh token is
 * rotated by the SDK itself. The user is never asked to paste a secret.
 *
 * @module dsh-flowus/oauth-provider
 */

import { randomUUID } from 'node:crypto';

/** Issuer stamped by the SDK; used only to detect a server-side issuer change. */
const SEED = Object.freeze({ version: 1 });

/** Public client name shown on the FlowUs authorization page. */
export const DEFAULT_CLIENT_NAME = 'DeepSeek Harness';

/**
 * Extract the non-secret summary of a stored token set.
 * @param {Record<string, unknown> | undefined} tokens
 * @returns {{ ok: boolean, scope?: string, tokenType?: string, expiresAt?: string, expired?: boolean, hasRefreshToken?: boolean }}
 */
export function describeTokens(tokens) {
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) return { ok: false };
  const obtainedAt = typeof tokens.obtainedAt === 'number' ? tokens.obtainedAt : undefined;
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
  const expiresAt = obtainedAt !== undefined && expiresIn !== undefined ? obtainedAt + expiresIn * 1000 : undefined;
  return {
    ok: true,
    scope: typeof tokens.scope === 'string' ? tokens.scope : undefined,
    tokenType: typeof tokens.token_type === 'string' ? tokens.token_type : undefined,
    expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
    expired: expiresAt === undefined ? undefined : expiresAt <= Date.now(),
    hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
  };
}

/**
 * Whether a token set is expired (or about to expire) according to its own
 * `obtainedAt` + `expires_in` bookkeeping. The SDK itself never inspects
 * expiry; this lets the plugin refresh *before* a request instead of after a
 * 401.
 * @param {Record<string, unknown> | undefined} tokens
 * @param {number} [skewMs] - treat tokens expiring within this window as stale.
 * @returns {boolean} true when the stored access token should not be reused.
 */
export function tokensAreStale(tokens, skewMs = 60_000) {
  if (!tokens || typeof tokens.access_token !== 'string') return true;
  const info = describeTokens(tokens);
  if (info.expiresAt === undefined) return false;
  return Date.parse(info.expiresAt) - skewMs <= Date.now();
}

/**
 * Whether two identifiers name the same authorization server.
 *
 * Mirrors the SDK's SEP-2352 comparison: exact equality, plus the single
 * trailing-slash tolerance RFC 8414 §3.3 allows, because an issuer derived from
 * `new URL(...)` is always slash-suffixed while a published `issuer` may not be.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function issuersMatch(a, b) {
  return a === b || (a.endsWith('/') && a.slice(0, -1) === b) || (b.endsWith('/') && b.slice(0, -1) === a);
}

/**
 * The `OAuthClientProvider` the MCP SDK drives.
 */
export class FlowusOAuthProvider {
  /** @type {import('./store.js').JsonStateStore} */
  #store;
  /** @type {string} */
  #redirectUrl;
  /** @type {string} */
  #clientName;
  /** @type {string} */
  #state;
  /** @type {(message: string) => void} */
  #log;
  /** @type {((url: URL) => void | Promise<void>) | undefined} */
  #onRedirect;

  /**
   * @param {object} options
   * @param {import('./store.js').JsonStateStore} options.store - durable state.
   * @param {string} options.redirectUrl - absolute loopback redirect URI; must
   *   stay byte-identical to the one registered with the authorization server.
   * @param {string} [options.clientName] - `client_name` sent during dynamic registration.
   * @param {string} [options.state] - the CSRF state to use; generated when omitted.
   * @param {(url: URL) => void | Promise<void>} [options.onRedirect] - how to hand
   *   the authorization URL to the user (open a browser, print it, ...).
   * @param {(message: string) => void} [options.log] - diagnostics sink.
   */
  constructor(options) {
    if (!options?.store) throw new TypeError('FlowusOAuthProvider requires a state store');
    if (typeof options.redirectUrl !== 'string' || !/^https?:\/\//u.test(options.redirectUrl)) {
      throw new TypeError('FlowusOAuthProvider requires an absolute redirectUrl');
    }
    this.#store = options.store;
    this.#redirectUrl = options.redirectUrl;
    this.#clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
    this.#state = options.state ?? randomUUID();
    this.#log = options.log ?? (() => {});
    this.#onRedirect = options.onRedirect;
  }

  /** Authorization URL captured by {@link redirectToAuthorization}, for display. */
  authorizationUrl;

  /** @returns {string} the absolute loopback redirect URI. */
  get redirectUrl() {
    return this.#redirectUrl;
  }

  /** @returns {object} the client metadata sent to the registration endpoint. */
  get clientMetadata() {
    return {
      redirect_uris: [this.#redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: this.#clientName,
      software_id: 'dsh-flowus',
    };
  }

  /**
   * The CSRF state. Stable for the lifetime of this provider so the loopback
   * listener can validate the redirect it receives.
   * @returns {string} the state value.
   */
  state() {
    return this.#state;
  }

  /** @returns {Promise<object>} the raw persisted document (read-only copy). */
  async snapshot() {
    return this.#store.read();
  }

  /**
   * Whether a stored credential may be presented to the authorization server
   * the SDK is currently working with.
   *
   * An unstamped credential (pre-SEP-2352 storage, or one the SDK supplied
   * without a context) passes: the SDK writes the stamp back on first use. A
   * stamped credential passes only for its own issuer.
   * @param {{ issuer?: unknown } | undefined} stored
   * @param {string | undefined} requested - `ctx.issuer`, when the SDK supplies one.
   * @param {string} label - what is being read, for the diagnostic.
   * @returns {boolean}
   */
  #allowsIssuer(stored, requested, label) {
    const boundTo = typeof stored?.issuer === 'string' && stored.issuer.length > 0 ? stored.issuer : undefined;
    if (boundTo === undefined || requested === undefined || requested.length === 0) return true;
    if (issuersMatch(boundTo, requested)) return true;
    this.#log(
      `flowus: the stored ${label} is bound to ${boundTo} but ${requested} asked for it; withholding it and treating FlowUs as not authorized`,
    );
    return false;
  }

  /**
   * The stored client identity, for the authorization server asking for it.
   *
   * Withholding a mismatched registration makes the SDK register again, which
   * is the correct outcome when the authorization server changed.
   * @param {{ issuer?: string }} [ctx] - SDK-supplied authorization-server context.
   * @returns {Promise<object | undefined>} the stored client identity.
   */
  async clientInformation(ctx) {
    const doc = await this.#store.read();
    const info = doc.clientInformation;
    if (!info || typeof info !== 'object') return undefined;
    const requested = typeof ctx?.issuer === 'string' ? ctx.issuer : undefined;
    if (!this.#allowsIssuer(info, requested, 'client registration')) return undefined;
    if (requested !== undefined && typeof info.issuer !== 'string') {
      return { ...info, issuer: requested };
    }
    return info;
  }

  /**
   * @param {object} clientInformation - DCR response (or a previously stored identity).
   * @param {{ issuer?: string }} [ctx]
   */
  async saveClientInformation(clientInformation, ctx) {
    await this.#store.mutate((doc) => ({
      ...doc,
      clientInformation: { ...clientInformation, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) },
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * The stored token set, for the authorization server asking for it.
   *
   * The transport reads tokens with no context (it authenticates one known
   * resource URL), so that path is unchanged. The OAuth paths pass
   * `ctx.issuer`, and a mismatch yields `undefined`, which sends the SDK down
   * its "authorize again" branch instead of handing a FlowUs refresh token to a
   * different authorization server.
   * @param {{ issuer?: string }} [ctx]
   * @returns {Promise<object | undefined>} the stored token set.
   */
  async tokens(ctx) {
    const doc = await this.#store.read();
    const tokens = doc.tokens;
    if (!tokens || typeof tokens !== 'object') return undefined;
    const requested = typeof ctx?.issuer === 'string' ? ctx.issuer : undefined;
    if (!this.#allowsIssuer(tokens, requested, 'token set')) return undefined;
    return tokens;
  }

  /**
   * Persist a fresh or refreshed token set, stamping the issue time so the
   * plugin can refresh proactively.
   * @param {object} tokens
   * @param {{ issuer?: string }} [ctx]
   */
  async saveTokens(tokens, ctx) {
    await this.#store.mutate((doc) => ({
      ...doc,
      tokens: {
        ...tokens,
        ...(ctx?.issuer ? { issuer: ctx.issuer } : {}),
        obtainedAt: Date.now(),
      },
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Hand the authorization URL to the user.
   * @param {URL} authorizationUrl
   */
  async redirectToAuthorization(authorizationUrl) {
    this.authorizationUrl = authorizationUrl;
    if (this.#onRedirect) await this.#onRedirect(authorizationUrl);
  }

  /** @param {string} codeVerifier */
  async saveCodeVerifier(codeVerifier) {
    await this.#store.mutate((doc) => ({ ...doc, codeVerifier, state: this.#state }));
  }

  /** @returns {Promise<string>} the PKCE verifier for the in-flight authorization. */
  async codeVerifier() {
    const doc = await this.#store.read();
    if (typeof doc.codeVerifier !== 'string' || doc.codeVerifier.length === 0) {
      throw new Error('flowus: no PKCE code verifier is stored for this login attempt; run /flowus login again');
    }
    return doc.codeVerifier;
  }

  /** @param {object} state */
  async saveDiscoveryState(state) {
    await this.#store.mutate((doc) => ({ ...doc, discoveryState: state }));
  }

  /** @returns {Promise<object | undefined>} */
  async discoveryState() {
    const doc = await this.#store.read();
    return doc.discoveryState && typeof doc.discoveryState === 'object' ? doc.discoveryState : undefined;
  }

  /** @param {string} resourceUrl */
  async saveResourceUrl(resourceUrl) {
    await this.#store.mutate((doc) => ({ ...doc, resourceUrl }));
  }

  /** @returns {Promise<string | undefined>} */
  async resourceUrl() {
    const doc = await this.#store.read();
    return typeof doc.resourceUrl === 'string' ? doc.resourceUrl : undefined;
  }

  /**
   * Deprecated SDK write; kept so nothing the SDK persists is silently lost.
   * @param {string} authorizationServerUrl
   */
  async saveAuthorizationServerUrl(authorizationServerUrl) {
    await this.#store.mutate((doc) => ({ ...doc, authorizationServerUrl }));
  }

  /** @returns {Promise<string | undefined>} */
  async authorizationServerUrl() {
    const doc = await this.#store.read();
    return typeof doc.authorizationServerUrl === 'string' ? doc.authorizationServerUrl : undefined;
  }

  /**
   * Drop the requested slice of persisted OAuth state.
   *
   * `logout()` in this plugin deliberately keeps `clientInformation` and
   * `discoveryState` (dropping only tokens and the verifier) so the next login
   * reuses the existing dynamic registration instead of burning another
   * registration on a rate-limited endpoint.
   * @param {'all' | 'client' | 'tokens' | 'verifier' | 'discovery'} scope
   */
  async invalidateCredentials(scope) {
    await this.#store.mutate((doc) => {
      const next = { ...doc };
      const drop = (...keys) => {
        for (const key of keys) delete next[key];
      };
      switch (scope) {
        case 'all':
          drop('clientInformation', 'tokens', 'codeVerifier', 'discoveryState', 'resourceUrl', 'authorizationServerUrl');
          break;
        case 'client':
          drop('clientInformation');
          break;
        case 'tokens':
          drop('tokens');
          break;
        case 'verifier':
          drop('codeVerifier');
          break;
        case 'discovery':
          drop('discoveryState');
          break;
        default:
          this.#log(`flowus: unknown credential scope ${String(scope)}; ignoring`);
          return undefined;
      }
      this.#log(`flowus: cleared persisted OAuth state (${scope})`);
      return next;
    });
  }

  /**
   * Record the redirect URI this provider is bound to, so a later session can
   * detect that its loopback port changed and force a fresh registration.
   * @param {string} redirectUrl
   */
  async rememberRedirectUrl(redirectUrl) {
    await this.#store.mutate((doc) => ({ ...doc, redirectUrl }));
  }

  /**
   * Whether the redirect URI changed since the stored client was registered.
   * @param {string} redirectUrl
   * @returns {Promise<boolean>}
   */
  async redirectUrlChanged(redirectUrl) {
    const doc = await this.#store.read();
    return typeof doc.redirectUrl === 'string' && doc.redirectUrl !== redirectUrl;
  }

  /**
   * Approved tokens for one issuer, without any secret material other than the
   * tokens themselves (used by status output and by the session layer).
   * @returns {Promise<Record<string, unknown> | undefined>}
   */
  async tokenSet() {
    const doc = await this.#store.read();
    return doc.tokens && typeof doc.tokens === 'object' ? doc.tokens : undefined;
  }
}

// Kept for symmetry with the pure modules: the seed object documents the
// persisted document version and is intentionally inert.
export const STATE_VERSION = SEED.version;
