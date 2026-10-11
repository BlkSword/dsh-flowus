/**
 * Loopback OAuth redirect receiver.
 *
 * The FlowUs authorization server redirects the browser to
 * `http://127.0.0.1:<port><path>?code=...&state=...`. This module owns that
 * one-shot listener: it validates the `state` the client minted, answers the
 * browser with a small human page, and hands the authorization code to the
 * waiting login call. A mismatched or missing `state` is refused (CSRF), and
 * an `error`/`error_description` redirect is surfaced verbatim.
 *
 * @module dsh-flowus/callback-server
 */

import { createServer } from 'node:http';

/** Default loopback port: stable so one dynamic client registration is reusable. */
export const DEFAULT_CALLBACK_PORT = 42813;

/** Default callback path. */
export const DEFAULT_CALLBACK_PATH = '/callback';

/** Result page rendered into the user's browser. */
function resultPage({ ok, title, detail }) {
  const accent = ok ? '#1f9d55' : '#c53030';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f1115;color:#e6e8eb}
main{max-width:34rem;padding:2.5rem;border-radius:14px;background:#171a21;border:1px solid #232733}
h1{margin:0 0 .75rem;font-size:1.25rem;color:${accent}}p{margin:.25rem 0;color:#a9b0bd}code{color:#e6e8eb}</style></head>
<body><main><h1>${title}</h1><p>${detail}</p><p>You can close this tab and return to DeepSeek Harness.</p></main></body></html>`;
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
    const returnedState = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const iss = url.searchParams.get('iss');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    const reject_ = (status, title, detail, reason) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(resultPage({ ok: false, title, detail }));
      finish(() => fail(new Error(reason)));
    };
    if (error) {
      reject_(400, 'FlowUs authorization failed', `The server returned <code>${error}</code>. ${errorDescription ?? ''}`.trim(), `FlowUs authorization failed: ${error}${errorDescription ? ` (${errorDescription})` : ''}`);
      return;
    }
    if (returnedState !== state) {
      reject_(400, 'State mismatch', 'The redirect did not carry this login attempt\'s state parameter.', 'FlowUs authorization redirect carried an unexpected state parameter');
      return;
    }
    if (!code) {
      reject_(400, 'Missing authorization code', 'The redirect carried no <code>code</code> parameter.', 'FlowUs authorization redirect carried no code');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(resultPage({ ok: true, title: 'FlowUs authorized', detail: 'DeepSeek Harness received the authorization code.' }));
    finish(() => settle({ code, state: returnedState, iss: iss ?? undefined }));
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
