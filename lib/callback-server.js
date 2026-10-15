/**
 * Loopback OAuth redirect receiver.
 *
 * The FlowUs authorization server redirects the browser to
 * `http://127.0.0.1:<port><path>?code=...&state=...`. This module owns that
 * one-shot listener: it accepts only a `GET` on its own path, requires exactly
 * one `state` that matches the one the client minted (compared in constant
 * time), and hands the authorization code to the waiting login call.
 *
 * A request that fails those checks is answered and then ignored, never used to
 * settle the login: the listener stays open for the real redirect, so a local
 * process or a stray browser navigation cannot cancel a login in progress.
 * Loopback binding is enforced (RFC 8252 §7.3), and server-supplied error text
 * reaches the browser page escaped and truncated.
 *
 * @module dsh-flowus/callback-server
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** Default loopback port: stable so one dynamic client registration is reusable. */
export const DEFAULT_CALLBACK_PORT = 42813;

/** Default callback path. */
export const DEFAULT_CALLBACK_PATH = '/callback';

/**
 * Hosts an OAuth redirect URI may use.
 *
 * RFC 8252 §7.3 requires a loopback redirect for a public native client: any
 * other host would expose the authorization code to the network.
 */
export const LOOPBACK_HOST_PATTERN = /^(?:127(?:\.\d{1,3}){3}|::1|localhost)$/;

/** Longest server-supplied text echoed into the browser result page. */
const MAX_ECHO_LENGTH = 200;

/**
 * Escape one value for HTML interpolation.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character === '"' ? '&quot;' : '&#39;',
  );
}

/**
 * Constant-time equality for two query values.
 *
 * Both sides are hashed first, so the buffers always have the same length and
 * `timingSafeEqual` cannot throw on a length difference.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Result page rendered into the user's browser.
 *
 * `detail` is local copy; `echoed` is the only server-supplied text that ever
 * reaches the page, and it is escaped and truncated.
 * @param {{ ok: boolean, title: string, detail: string, echoed?: string }} page
 * @returns {string}
 */
function resultPage({ ok, title, detail, echoed }) {
  const accent = ok ? '#1f9d55' : '#c53030';
  const echo = echoed ? ` <code>${escapeHtml(echoed)}</code>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f1115;color:#e6e8eb}
main{max-width:34rem;padding:2.5rem;border-radius:14px;background:#171a21;border:1px solid #232733}
h1{margin:0 0 .75rem;font-size:1.25rem;color:${accent}}p{margin:.25rem 0;color:#a9b0bd}code{color:#e6e8eb}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}${echo}</p><p>You can close this tab and return to DeepSeek Harness.</p></main></body></html>`;
}

/**
 * Start the callback listener.
 * @param {object} options
 * @param {string} options.state - the exact `state` the client expects back.
 * @param {number} [options.port] - preferred port; `0` picks an ephemeral port.
 * @param {string} [options.host] - loopback host, defaults to `127.0.0.1`.
 * @param {string} [options.path] - callback path, defaults to `/callback`.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @returns {Promise<{ redirectUrl: string, port: number, waitForCode: (signal?: AbortSignal) => Promise<{code: string, state: string}>, close: () => Promise<void> }>}
 */
export async function startCallbackServer(options) {
  const state = options.state;
  if (typeof state !== 'string' || state.length === 0) throw new TypeError('callback state is required');
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOST_PATTERN.test(host)) {
    throw new TypeError(`callback host must be a loopback address (127.0.0.1, ::1 or localhost), received ${JSON.stringify(host)}`);
  }
  const path = options.path ?? DEFAULT_CALLBACK_PATH;
  const preferredPort = options.port ?? DEFAULT_CALLBACK_PORT;
  const log = options.log ?? (() => {});

  let settle;
  let fail;
  const pending = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // The listener can settle the login before the caller attaches its awaiter
  // (the browser response is written first). Keep that early rejection from
  // surfacing as an unhandled rejection; `waitForCode()` still returns the
  // same promise, so awaiting callers observe the failure.
  pending.catch(() => {});
  let settled = false;
  const listeners = new Set();

  const server = createServer((request, response) => {
    const respond = (status, page) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(resultPage(page));
    };
    // A redirect from an authorization server is always a GET.
    if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed');
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${host}`);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('bad request');
      return;
    }
    if (url.pathname !== path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    // Nothing settles before the state proves this is our own redirect. A
    // request that cannot prove it — a local process, another page navigating
    // the browser here — is answered and ignored, so it cannot cancel a login
    // that is still waiting for the real redirect.
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || !sameValue(states[0], state)) {
      log('flowus: ignoring a callback that did not carry this login attempt\'s state');
      respond(400, {
        ok: false,
        title: 'Ignored callback',
        detail: 'This request did not carry this login attempt\'s state parameter, so it was ignored. The login is still waiting for the real redirect.',
      });
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const errorDescription = url.searchParams.get('error_description');
      const summary = `${error}${errorDescription ? ` (${errorDescription})` : ''}`;
      respond(400, {
        ok: false,
        title: 'FlowUs authorization failed',
        detail: 'The authorization server refused this request:',
        echoed: summary.slice(0, MAX_ECHO_LENGTH),
      });
      finish(() => fail(new Error(`FlowUs authorization failed: ${summary}`)));
      return;
    }
    const codes = url.searchParams.getAll('code');
    if (codes.length > 1) {
      // Malformed rather than failed: ignore it and keep waiting.
      respond(400, {
        ok: false,
        title: 'Ignored callback',
        detail: 'This request carried more than one code parameter, so it was ignored.',
      });
      return;
    }
    if (codes.length === 0 || codes[0].length === 0) {
      respond(400, {
        ok: false,
        title: 'Missing authorization code',
        detail: 'The redirect carried no single code parameter.',
      });
      finish(() => fail(new Error('FlowUs authorization redirect carried no code')));
      return;
    }
    respond(200, {
      ok: true,
      title: 'FlowUs authorized',
      detail: 'DeepSeek Harness received the authorization code.',
    });
    finish(() => settle({ code: codes[0], state: states[0], iss: url.searchParams.get('iss') ?? undefined }));
  });

  const finish = (action) => {
    if (settled) return;
    settled = true;
    action();
  };

  const onAbort = () => finish(() => fail(new Error('FlowUs authorization was cancelled')));
  for (const signal of options.signals ?? []) {
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      listeners.add(signal);
    }
  }

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  try {
    await listen(preferredPort);
  } catch (error) {
    if (error?.code === 'EADDRINUSE' && preferredPort !== 0) {
      log(`flowus: port ${preferredPort} is busy; falling back to an ephemeral loopback port`);
      await listen(0);
    } else {
      throw error;
    }
  }

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : preferredPort;
  const redirectUrl = `http://${host}:${port}${path}`;

  return {
    redirectUrl,
    port,
    waitForCode: (signal) => {
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.add(signal);
      }
      return pending;
    },
    close: async () => {
      for (const signal of listeners) signal.removeEventListener('abort', onAbort);
      listeners.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
