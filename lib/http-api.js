/**
 * The plugin's browser-facing JSON API.
 *
 * The settings page is a browser module, so it cannot call host methods
 * directly; this module exposes one small JSON surface on the composition's
 * own HTTP server instead of a custom RPC namespace. That keeps the browser
 * half dependency-free (`fetch` only) and reuses the composition's existing
 * trust fence: every route asks `ctx.connection.requestRejection(req)` first,
 * whose Host/Origin check and login-token cookie gate the caller before any
 * FlowUs state is read or any login is started.
 *
 * Every action answers with the complete status snapshot, so the page renders
 * one shape for every button and never has to reconcile partial responses.
 *
 * @module dsh-flowus/http-api
 */

/** Route prefix owned by this plugin. */
export const API_PREFIX = '/flowus/api';

/**
 * The route table: one exact path, one method, one controller action.
 * @type {ReadonlyArray<{ path: string, method: 'GET' | 'POST', action: 'status' | 'login' | 'loginCancel' | 'logout' | 'reload' }>}
 */
export const API_ROUTES = Object.freeze([
  Object.freeze({ path: `${API_PREFIX}/status`, method: 'GET', action: 'status' }),
  Object.freeze({ path: `${API_PREFIX}/login`, method: 'POST', action: 'login' }),
  Object.freeze({ path: `${API_PREFIX}/login-cancel`, method: 'POST', action: 'loginCancel' }),
  Object.freeze({ path: `${API_PREFIX}/logout`, method: 'POST', action: 'logout' }),
  Object.freeze({ path: `${API_PREFIX}/reload`, method: 'POST', action: 'reload' }),
]);

/**
 * Render one failure for a client that may not share this process's Error
 * prototype (the browser reads `error` as a string).
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Write one JSON response that no cache may reuse.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Build the registrable routes for a controller.
 *
 * @param {object} options
 * @param {{ status: () => Promise<object>, login: () => Promise<object>, loginCancel: () => Promise<object>, logout: () => Promise<object>, reload: () => Promise<object> }} options.controller
 *   Every action resolves to the same status snapshot.
 * @param {(req: import('node:http').IncomingMessage) => number | undefined} options.guard
 *   The composition's trust fence: a status code to answer, or `undefined` to proceed.
 * @param {(message: string) => void} [options.log]
 * @param {(error: unknown) => string} [options.describeError] - turns one failure
 *   into the text the browser reads; the default is the raw message, and the
 *   plugin passes a version that keeps gateway HTML out of the page.
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }>}
 */
export function createApiRoutes(options) {
  const { controller, guard } = options;
  const log = options.log ?? (() => {});
  const describeError = options.describeError ?? errorMessage;
  return API_ROUTES.map(({ path, method, action }) => ({
    kind: 'exact',
    path,
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    handler: async (req, res) => {
      const rejection = guard(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== method) {
        res.statusCode = 405;
        res.setHeader('allow', method);
        res.end();
        return;
      }
      // These endpoints take no body; drain anything sent so the socket is reusable.
      req.resume();
      try {
        const snapshot = await controller[action]();
        sendJson(res, 200, { ok: true, snapshot });
      } catch (error) {
        const message = describeError(error);
        log(`flowus: ${method} ${path} failed: ${message}`);
        sendJson(res, 200, { ok: false, error: message });
      }
    },
  }));
}
