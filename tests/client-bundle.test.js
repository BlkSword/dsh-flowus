/**
 * Tests for the browser half (`lib/client.js`).
 *
 * The bundle is a classic script that only calls
 * `window.__ModuleLoader__.load(...)`, so the test captures that registration,
 * builds the factory with the shell's platform modules stubbed, and drives the
 * page's pure projections — the dictionary, the view model, the host-route
 * calls and one full render — without a browser.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_ROUTES } from '../lib/http-api.js';

/** @type {any[]} */
const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};
await import('../lib/client.js');

const registration = registrations[0];

/** @type {any} */
let hookState;
const fakeReact = {
  useState: (initial) => [hookState ?? initial, () => {}],
  useEffect: () => {},
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
};
const fakeJsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  Fragment: Symbol('Fragment'),
};
const fakePrimitives = {
  Button: (props) => ({ type: 'Button', props }),
  Input: (props) => ({ type: 'Input', props }),
  Tag: (props) => ({ type: 'Tag', props }),
  StateDot: (props) => ({ type: 'StateDot', props }),
};
const requestedModules = [];
const shellRequire = (id) => {
  requestedModules.push(id);
  if (id === 'react') return fakeReact;
  if (id === 'react/jsx-runtime') return fakeJsxRuntime;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
  throw new Error(`unexpected require("${id}")`);
};

const client = registration.factory(shellRequire);
const { NS, statusViewModel, filterTools, timeAgo, describeAgo, FlowusSettingsPage, en, zh, api } = client.__internals;

/** Dictionary reader mirroring the framework's `t`, including `{placeholder}` substitution. */
const t = (key, values) => {
  const raw = en[key] ?? key;
  return values ? raw.replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? '')) : raw;
};

/** Collect every string rendered in a (stubbed) element tree. */
function collectText(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && 'props' in node) collectText(node.props.children, out);
  return out;
}

/** Collect every Tag in a (stubbed) element tree as `{ tone, label }`. */
function collectTags(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectTags(child, out);
    return out;
  }
  if (!('props' in node)) return out;
  if (node.type === fakePrimitives.Tag) {
    out.push({ tone: node.props.tone, label: collectText(node.props.children).join('') });
  }
  collectTags(node.props.children, out);
  return out;
}

const snapshotOf = (overrides = {}) => ({
  plugin: { name: '@blksword/dsh-flowus', version: '0.1.0', serverName: 'flowus' },
  server: {
    url: 'https://mcp.flowus.cn/message',
    namespace: 'mcp__flowus__',
    statePath: 'C:\\Users\\me\\.dsh\\flowus\\oauth.json',
    scope: 'all',
  },
  authorization: { configured: false, scope: 'all', expiresAt: null, expired: null, hasRefreshToken: false },
  connection: { connected: false, toolCount: 0, lastSyncAt: null, serverName: null, serverVersion: null },
  lastError: null,
  login: { phase: 'idle', authorizationUrl: null, startedAt: null, finishedAt: null, error: null, toolCount: null },
  tools: [],
  ...overrides,
});

test('the bundle registers exactly one factory under the package name', () => {
  assert.equal(registrations.length, 1);
  assert.equal(registration.id, '@blksword/dsh-flowus');
  assert.equal(typeof registration.factory, 'function');
  assert.deepEqual(requestedModules, ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
});

test('the factory returns a cordis plugin face for the browser', () => {
  assert.deepEqual(client.inject, ['slots', 'locale']);
  assert.equal(typeof client.apply, 'function');
  assert.equal(NS, 'settings.flowus');
});

test('both dictionaries carry exactly the same keys, all non-empty', () => {
  const english = Object.keys(en).sort();
  const chinese = Object.keys(zh).sort();
  assert.deepEqual(chinese, english);
  for (const key of english) {
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0, `en.${key}`);
    assert.ok(zh[key].length > 0, `zh.${key}`);
  }
  assert.equal(en.nav, 'FlowUs');
  assert.equal(zh.toolsCount, '已注册 {count} 个工具');
});

test('apply registers the dictionaries and one settings.section page', () => {
  const dictionaryCalls = [];
  const slotCalls = [];
  const effects = [];
  const ctx = {
    locale: {
      bind: (namespace) => {
        assert.equal(namespace, NS);
        return t;
      },
      register: (namespace, dictionaries) => {
        dictionaryCalls.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      inject: (name, callback) => {
        slotCalls.push({ kind: 'inject', name });
        return callback();
      },
      register: (descriptor, component) => {
        slotCalls.push({ kind: 'register', descriptor, component });
        return () => {};
      },
    },
    effect: (callback) => {
      const disposer = callback();
      effects.push(typeof disposer);
      return () => {};
    },
  };

  client.apply(ctx);

  assert.equal(dictionaryCalls.length, 1);
  assert.equal(dictionaryCalls[0].namespace, NS);
  assert.deepEqual(dictionaryCalls[0].dictionaries, { en, zh });
  assert.deepEqual(slotCalls[0], { kind: 'inject', name: 'settings.section' });
  const registrationCall = slotCalls[1];
  assert.equal(registrationCall.kind, 'register');
  assert.deepEqual(
    {
      name: registrationCall.descriptor.name,
      id: registrationCall.descriptor.id,
      order: registrationCall.descriptor.order,
      locale: registrationCall.descriptor.locale,
    },
    { name: 'settings.section', id: 'flowus', order: 32, locale: NS },
  );
  assert.equal(registrationCall.descriptor.label(), 'FlowUs');
  assert.deepEqual(registrationCall.descriptor.inject(), {});
  assert.equal(typeof registrationCall.component, 'function');
  assert.deepEqual(effects, ['function', 'function']);
});

test('every host route the page calls exists in the host route table', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, snapshot: snapshotOf() }),
    };
  };
  try {
    await api.status();
    await api.login();
    await api.cancelLogin();
    await api.logout();
    await api.reload();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map((call) => `${call.url} ${call.method}`),
    [
      '/flowus/api/status GET',
      '/flowus/api/login POST',
      '/flowus/api/login-cancel POST',
      '/flowus/api/logout POST',
      '/flowus/api/reload POST',
    ],
  );
  const hostRoutes = new Set(API_ROUTES.map((route) => `${route.path} ${route.method}`));
  for (const call of calls) {
    assert.ok(hostRoutes.has(`${call.url} ${call.method}`), `host route missing for ${call.url}`);
  }
});

test('a failed fetch reports the HTTP status and a rejected envelope reports its message', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(api.status(), /HTTP 401/u);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not authorized yet' }) });
    await assert.rejects(api.login(), /not authorized yet/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the view model reports the unauthorized state', () => {
  const model = statusViewModel(snapshotOf(), t);
  assert.equal(model.badge.dot, 'warning');
  assert.equal(model.badge.tone, 'warning');
  assert.equal(model.badge.title, 'Not authorized');
  assert.match(model.badge.detail, /Sign in with FlowUs/u);
  assert.equal(model.canSignIn, true);
  assert.equal(model.canSignOut, false);
  assert.equal(model.toolsEmpty, true);
  assert.equal(model.toolsTitle, 'Tools (0)');
  assert.equal(model.error, null);
  const labels = model.facts.map((fact) => fact.label);
  assert.deepEqual(labels, ['MCP endpoint', 'Tool namespace', 'Credential file', 'Scope', 'Expires', 'Refresh token']);
  assert.equal(model.facts[1].value, 'mcp__flowus__*');
});

test('the view model reports the connected state with its tool count', () => {
  const model = statusViewModel(
    snapshotOf({
      authorization: { configured: true, scope: 'all', expiresAt: '2026-10-11T23:00:00.000Z', expired: false, hasRefreshToken: true },
      connection: { connected: true, toolCount: 3, lastSyncAt: '2026-10-11T22:00:00.000Z', serverName: 'flowus', serverVersion: '1.0.0' },
      tools: [
        { name: 'mcp__flowus__search_pages', rawName: 'search_pages', description: 'Search pages\nmore' },
        { name: 'mcp__flowus__read_page', rawName: 'read_page', description: '' },
        { name: 'mcp__flowus__list_databases', rawName: 'list_databases', description: 'List databases' },
      ],
    }),
    t,
  );
  assert.equal(model.badge.dot, 'done');
  assert.equal(model.badge.tone, 'success');
  assert.equal(model.badge.title, 'Connected');
  assert.equal(model.badge.tag, '3 tool(s) published');
  assert.equal(model.canSignOut, true);
  assert.equal(model.tools.length, 3);
  assert.ok(model.facts.some((fact) => fact.key === 'lastSync'));
  assert.equal(model.error, null);
});

test('the view model reports a pending login and a failure', () => {
  const pending = statusViewModel(
    snapshotOf({
      login: {
        phase: 'pending',
        authorizationUrl: 'https://api.flowus.cn/oauth/authorize?client_id=abc',
        startedAt: 1,
        finishedAt: null,
        error: null,
        toolCount: null,
      },
    }),
    t,
  );
  assert.equal(pending.badge.dot, 'ongoing');
  assert.equal(pending.badge.tone, 'info');
  assert.equal(pending.loginPhase, 'pending');
  assert.equal(pending.canSignIn, false);
  assert.match(pending.loginUrl, /^https:\/\/api\.flowus\.cn\/oauth\/authorize/u);

  const failed = statusViewModel(
    snapshotOf({
      login: { phase: 'failed', authorizationUrl: null, startedAt: 1, finishedAt: 2, error: 'user denied access', toolCount: null },
    }),
    t,
  );
  assert.equal(failed.badge.dot, 'error');
  assert.equal(failed.badge.tone, 'danger');
  assert.equal(failed.error, 'user denied access');
});

test('the view model survives an empty snapshot', () => {
  const model = statusViewModel(undefined, t);
  assert.equal(model.badge.dot, 'warning');
  assert.equal(model.tools.length, 0);
  assert.equal(model.facts[0].value, '—');
});

test('the page renders the loading state and a full ready state', () => {
  hookState = undefined;
  const loading = collectText(FlowusSettingsPage({ t })).join('\n');
  assert.match(loading, /Reading FlowUs state/u);

  hookState = {
    phase: 'ready',
    snapshot: snapshotOf({
      authorization: { configured: true, scope: 'all', expiresAt: null, expired: null, hasRefreshToken: true },
      connection: { connected: true, toolCount: 1, lastSyncAt: null, serverName: 'flowus', serverVersion: null },
      tools: [{ name: 'mcp__flowus__search_pages', rawName: 'search_pages', description: 'Search pages' }],
    }),
    error: undefined,
  };
  const rendered = collectText(FlowusSettingsPage({ t })).join('\n');
  hookState = undefined;
  assert.match(rendered, /^FlowUs$/mu);
  assert.match(rendered, /Connected/u);
  assert.match(rendered, /1 tool\(s\) published/u);
  assert.match(rendered, /Tools \(1\)/u);
  assert.match(rendered, /mcp__flowus__search_pages/u);
  assert.match(rendered, /Search pages/u);
  assert.match(rendered, /Sign out/u);
  assert.match(rendered, /MCP endpoint/u);
});

test('an authorized-but-disconnected page explains the session, not the credentials', () => {
  const model = statusViewModel(
    snapshotOf({ authorization: { configured: true, scope: 'all', expiresAt: null, expired: null, hasRefreshToken: true } }),
    t,
  );
  assert.equal(model.badge.title, 'Authorized, not connected');
  assert.match(model.badge.detail, /no MCP session is open/u);
  assert.equal(model.canSignIn, true);
  assert.equal(model.canSignOut, true);
});

test('the tool filter matches names and descriptions while AND-ing every term', () => {
  const tools = [
    { name: 'mcp__flowus__search_text', rawName: 'flowus_search_text', description: 'Search pages by keyword' },
    { name: 'mcp__flowus__create_page', rawName: 'flowus_create_page', description: 'Create a page' },
  ];
  assert.equal(filterTools(tools, '').length, 2);
  assert.deepEqual(
    filterTools(tools, 'create').map((tool) => tool.name),
    ['mcp__flowus__create_page'],
  );
  assert.deepEqual(
    filterTools(tools, 'page create').map((tool) => tool.name),
    ['mcp__flowus__create_page'],
  );
  // The raw name counts too, so either spelling finds the tool.
  assert.deepEqual(
    filterTools(tools, 'flowus_search').map((tool) => tool.name),
    ['mcp__flowus__search_text'],
  );
  assert.deepEqual(filterTools(tools, 'keyword'), [tools[0]]);
  assert.deepEqual(filterTools(tools, 'nothing'), []);

  const model = statusViewModel(
    snapshotOf({
      tools: [
        { name: 'a', rawName: 'a', description: 'alpha', readOnly: true },
        { name: 'b', rawName: 'b', description: 'beta', readOnly: false },
      ],
    }),
    t,
    'alpha',
  );
  assert.equal(model.toolsShown.length, 1);
  assert.equal(model.toolsTitle, 'Tools (2)');
  assert.equal(model.toolsSummary, '1 of 2 shown');
  assert.equal(model.toolsEmpty, false);
  assert.equal(model.tools[0].readOnly, true);

  const none = statusViewModel(snapshotOf({ tools: [{ name: 'a', rawName: 'a', description: 'alpha' }] }), t, 'zzz');
  assert.equal(none.toolsEmpty, true);
  assert.equal(none.toolsSummary, '0 of 1 shown');
  assert.equal(none.query, 'zzz');
});

test('ages render through coarse, localized buckets', () => {
  assert.deepEqual(timeAgo(1_000), { unit: 'now', count: 0 });
  assert.deepEqual(timeAgo(5 * 60_000), { unit: 'minutes', count: 5 });
  assert.deepEqual(timeAgo(3 * 3_600_000), { unit: 'hours', count: 3 });
  assert.deepEqual(timeAgo(4 * 86_400_000), { unit: 'days', count: 4 });
  assert.equal(describeAgo(t, 10_000), 'just now');
  assert.equal(describeAgo(t, 5 * 60_000), '5 min ago');
  assert.equal(describeAgo(t, Number.NaN), 'just now');
});

test('the view model carries relative times and the server version', () => {
  const now = Date.parse('2026-10-11T22:30:00.000Z');
  const model = statusViewModel(
    snapshotOf({
      authorization: { configured: true, scope: 'all', expiresAt: null, expired: null, hasRefreshToken: true },
      connection: { connected: true, toolCount: 1, lastSyncAt: '2026-10-11T22:00:00.000Z', serverName: 'flowus', serverVersion: '1.0.0' },
      login: {
        phase: 'pending',
        authorizationUrl: 'https://api.flowus.cn/oauth/authorize?x=1',
        startedAt: now - 70_000,
        finishedAt: null,
        error: null,
        toolCount: null,
      },
    }),
    t,
    '',
    now,
  );
  const byKey = Object.fromEntries(model.facts.map((fact) => [fact.key, fact.value]));
  assert.equal(byKey.version, '1.0.0');
  assert.match(byKey.lastSync, /30 min ago/u);
  assert.equal(model.loginElapsed, '1 min ago');
  assert.equal(model.statePath, 'C:\\Users\\me\\.dsh\\flowus\\oauth.json');
});

test('the rendered tool list labels read-only and write tools', () => {
  hookState = {
    phase: 'ready',
    snapshot: snapshotOf({
      connection: { connected: true, toolCount: 2, lastSyncAt: null, serverName: 'flowus', serverVersion: null },
      tools: [
        { name: 'mcp__flowus__search_text', rawName: 'flowus_search_text', description: 'Search', readOnly: true },
        { name: 'mcp__flowus__create_page', rawName: 'flowus_create_page', description: 'Create', readOnly: false },
      ],
    }),
    error: undefined,
  };
  const tree = FlowusSettingsPage({ t });
  hookState = undefined;
  const rendered = collectText(tree).join('\n');
  assert.match(rendered, /read-only/u);
  assert.match(rendered, /write/u);
  assert.match(rendered, /Tools \(2\)/u);

  // Every label needs a filled capsule: the primitives' `quiet` tone sets no
  // background, which is how the read-only tag once rendered as bare text.
  const tags = collectTags(tree);
  assert.deepEqual(
    tags.map((tag) => [tag.tone, tag.label]),
    [
      ['neutral', 'read-only'],
      ['warning', 'write'],
    ],
  );
  for (const tag of tags) assert.notEqual(tag.tone, 'quiet', 'quiet has no fill');
});
