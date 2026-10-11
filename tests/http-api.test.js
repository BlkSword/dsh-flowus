/**
 * Tests for the settings page's host API.
 *
 * The handlers are exercised with stand-in request/response objects, so the
 * trust fence, the method guard, the response envelope and the error path are
 * all covered without starting an HTTP server.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_PREFIX, API_ROUTES, createApiRoutes, sendJson } from '../lib/http-api.js';

/** @returns {{ req: any, res: any, body: () => any }} one recorded exchange */
function exchange(method = 'GET') {
  const chunks = [];
  const req = { method, resume: () => {} };
  const res = {
    statusCode: undefined,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      if (body !== undefined) chunks.push(String(body));
    },
  };
  return {
    req,
    res,
    body: () => (chunks.length === 0 ? undefined : JSON.parse(chunks.join(''))),
  };
}

const snapshot = { plugin: { name: '@mars-sea/dsh-flowus', version: '0.1.0' }, tools: [] };

/** @param {object} [overrides] */
function routes(overrides = {}) {
  const calls = [];
  const controller = {
    status: async () => {
      calls.push('status');
      return snapshot;
    },
    login: async () => {
      calls.push('login');
      return snapshot;
    },
    loginCancel: async () => {
      calls.push('loginCancel');
      return snapshot;
    },
    logout: async () => {
      calls.push('logout');
      return snapshot;
    },
    reload: async () => {
      calls.push('reload');
      return snapshot;
    },
    ...overrides,
  };
  return { calls, routes: createApiRoutes({ controller, guard: () => undefined, log: () => {} }) };
}

test('every declared route has a matching handler with the declared method', () => {
  const { routes: built } = routes();
  assert.equal(built.length, API_ROUTES.length);
  for (const [index, route] of built.entries()) {
    assert.equal(route.kind, 'exact');
    assert.equal(route.path, API_ROUTES[index].path);
    assert.ok(route.path.startsWith(`${API_PREFIX}/`));
    assert.equal(typeof route.handler, 'function');
  }
  assert.deepEqual(
    built.map((route) => `${route.path} ${API_ROUTES[built.indexOf(route)].method}`),
    API_ROUTES.map((route) => `${route.path} ${route.method}`),
  );
});

test('GET status answers the snapshot envelope with no-store caching', async () => {
  const { routes: built, calls } = routes();
  const { req, res, body } = exchange('GET');
  await built[0].handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(body(), { ok: true, snapshot });
  assert.deepEqual(calls, ['status']);
});

test('a wrong method is a 405 naming the allowed one', async () => {
  const { routes: built, calls } = routes();
  const { req, res, body } = exchange('POST');
  await built[0].handler(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET');
  assert.equal(body(), undefined);
  assert.deepEqual(calls, [], 'the controller is never reached');
});

test('the trust fence short-circuits before any controller work', async () => {
  const calls = [];
  const guarded = createApiRoutes({
    controller: {
      status: async () => {
        calls.push('status');
        return snapshot;
      },
      login: async () => snapshot,
      loginCancel: async () => snapshot,
      logout: async () => snapshot,
      reload: async () => snapshot,
    },
    guard: () => 401,
    log: () => {},
  });
  const { req, res, body } = exchange('GET');
  await guarded[0].handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(body(), undefined);
  assert.deepEqual(calls, []);
});

test('each POST route maps to its controller action', async () => {
  const { routes: built, calls } = routes();
  const cases = [
    ['/flowus/api/login', 'login'],
    ['/flowus/api/login-cancel', 'loginCancel'],
    ['/flowus/api/logout', 'logout'],
    ['/flowus/api/reload', 'reload'],
  ];
  for (const [path, action] of cases) {
    const route = built.find((candidate) => candidate.path === path);
    assert.ok(route, path);
    const { req, res, body } = exchange('POST');
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(body().ok, true);
    assert.equal(calls.at(-1), action);
  }
  assert.deepEqual(calls, ['login', 'loginCancel', 'logout', 'reload']);
});

test('a controller failure is reported as ok:false with the message, not a broken response', async () => {
  const { routes: built } = routes({
    reload: async () => {
      throw new Error('FlowUs is not authorized yet. Run /flowus login to authorize in the browser.');
    },
  });
  const route = built.find((candidate) => candidate.path === '/flowus/api/reload');
  const { req, res, body } = exchange('POST');
  await route.handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(), {
    ok: false,
    error: 'FlowUs is not authorized yet. Run /flowus login to authorize in the browser.',
  });
});

test('a non-Error rejection still reaches the client as text', async () => {
  const { routes: built } = routes({
    logout: async () => {
      throw 'plain string failure';
    },
  });
  const route = built.find((candidate) => candidate.path === '/flowus/api/logout');
  const { req, res, body } = exchange('POST');
  await route.handler(req, res);
  assert.deepEqual(body(), { ok: false, error: 'plain string failure' });
});

test('sendJson writes one JSON body with the plugin headers', () => {
  const { res, body } = exchange();
  sendJson(res, 201, { hello: 'world' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(body(), { hello: 'world' });
});
