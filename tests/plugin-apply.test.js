/**
 * Loads the plugin into a real cordis context with stand-in services.
 *
 * This is the pre-install gate: it proves the module shape the loader expects
 * (named `name`/`inject`/`Config`/`apply`), that the config schema validates
 * and applies defaults, that `apply` registers `/flowus` and a system-prompt
 * section, that every command path answers sensibly while unauthorized, and
 * that disposal releases the registrations. No network is touched: with no
 * stored token the startup sync stops before it opens a connection.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

/** Minimal stand-ins for the harness services the plugin registers against. */
function fakeHarness() {
  const ctx = new Context();
  const tools = new Map();
  const commands = new Map();
  const sections = [];
  ctx.provide('tools', {
    register: (definition) => {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    get: (name) => tools.get(name),
  });
  ctx.provide('commands', {
    register: (definition) => {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    },
  });
  ctx.provide('systemPrompt', {
    section: (section) => {
      sections.push(section);
      return () => sections.splice(sections.indexOf(section), 1);
    },
    getSectionOrder: (name) => (name === 'MCP_SERVERS' ? 3100 : 0),
  });
  return { ctx, tools, commands, sections };
}

/** @returns {Promise<{ ctx: Context, tools: Map<string, any>, commands: Map<string, any>, sections: any[], statePath: string }>} */
async function boot(overrides = {}) {
  const statePath = join(await mkdtemp(join(tmpdir(), 'dsh-flowus-apply-')), 'oauth.json');
  const harness = fakeHarness();
  const config = plugin.Config({ statePath, ...overrides });
  const fiber = await harness.ctx.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, config);
  return { ...harness, statePath, dispose: () => fiber.dispose() };
}

/** @param {any} commands @param {string} rawInput */
const run = (commands, rawInput) =>
  commands.get('flowus').handler({ rawInput, signal: new AbortController().signal, attachments: [] });

test('the module exposes the loader-visible named exports', () => {
  assert.equal(plugin.name, 'flowus');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'function');
});

test('the config schema applies defaults and rejects invalid values', () => {
  const defaults = plugin.Config({});
  assert.equal(defaults.serverUrl, 'https://mcp.flowus.cn/message');
  assert.equal(defaults.serverName, 'flowus');
  assert.equal(defaults.scope, 'all');
  assert.equal(defaults.autoConnect, true);
  assert.equal(defaults.failOnStartupError, false);
  assert.equal(defaults.callbackPort, 42813);
  assert.equal(defaults.callbackPath, '/callback');
  assert.equal(defaults.toolCallTimeoutMs, 60_000);
  assert.equal(defaults.promptSection, true);
  assert.equal(defaults.maxResultChars, 32_000);
  assert.equal(defaults.deferToolLoading, false);
  assert.equal(defaults.maxInstructionChars, 32_000);
  assert.throws(() => plugin.Config({ serverName: 'not a namespace' }));
  assert.throws(() => plugin.Config({ callbackPort: 70_000 }));
  // RFC 8252 §7.3: the OAuth redirect may only be loopback.
  assert.throws(() => plugin.Config({ callbackHost: '0.0.0.0' }));
  assert.equal(plugin.Config({ callbackHost: '::1' }).callbackHost, '::1');
});

test('apply registers /flowus and a system-prompt section without publishing tools', async () => {
  const { tools, commands, sections, dispose } = await boot();
  try {
    assert.ok(commands.has('flowus'), 'the /flowus command is registered');
    assert.equal(tools.size, 0, 'no tools before authorization');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'flowus:flowus');
    assert.equal(sections[0].order, 3100);
    assert.equal(sections[0].interpolate, false);
    const text = sections[0].text();
    assert.match(text, /not connected/u);
    assert.match(text, /\/flowus login/u);
  } finally {
    await dispose();
  }
});

test('the command surface answers help, status and misuse without a connection', async () => {
  const { commands, dispose } = await boot();
  try {
    const help = await run(commands, 'help');
    assert.equal(help.kind, 'success');
    assert.match(help.text, /Usage: \/flowus/u);

    const misuse = await run(commands, 'login now');
    assert.equal(misuse.kind, 'error');
    assert.match(misuse.text, /takes no arguments/u);
    assert.match(misuse.text, /Usage: \/flowus/u);

    const status = await run(commands, '');
    assert.equal(status.kind, 'success');
    assert.match(status.text, /未授权/u);
    assert.match(status.text, /https:\/\/mcp\.flowus\.cn\/message/u);

    const call = await run(commands, 'call search {"query":"x"}');
    assert.equal(call.kind, 'error');
    assert.match(call.text, /未连接|login/u);

    const tools = await run(commands, 'tools');
    assert.equal(tools.kind, 'success');
    assert.match(tools.text, /没有已注册/u);

    const reload = await run(commands, 'reload');
    assert.equal(reload.kind, 'error');
    assert.match(reload.text, /not authorized yet|login/iu);
  } finally {
    await dispose();
  }
});

test('logout rewrites the state file and keeps the client registration', async () => {
  const { commands, statePath, dispose } = await boot();
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        clientInformation: { client_id: 'abc', issuer: 'https://mcp.flowus.cn' },
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
        codeVerifier: 'v',
      }),
    );
    const result = await run(commands, 'logout');
    assert.equal(result.kind, 'success');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.tokens, undefined);
    assert.equal(state.codeVerifier, undefined);
    assert.equal(state.clientInformation.client_id, 'abc');
  } finally {
    await dispose();
  }
});

test('promptSection: false registers no section', async () => {
  const { sections, dispose } = await boot({ promptSection: false });
  try {
    assert.equal(sections.length, 0);
  } finally {
    await dispose();
  }
});

test('credentials issued for another resource are refused, never presented', async () => {
  const { commands, statePath, dispose } = await boot({ serverUrl: 'https://someone-else.example/message' });
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        clientInformation: { client_id: 'abc', issuer: 'https://mcp.flowus.cn' },
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', issuer: 'https://mcp.flowus.cn' },
        resourceUrl: 'https://mcp.flowus.cn/message',
      }),
    );
    const result = await run(commands, 'reload');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /belong to https:\/\/mcp\.flowus\.cn\/message/u);
    assert.match(result.text, /someone-else\.example/u);
    assert.match(result.text, /logout/u);
  } finally {
    await dispose();
  }
});

test('credentials for the configured resource pass the binding check', async () => {
  // A closed loopback port makes the connect fail fast without any network.
  const { commands, statePath, dispose } = await boot({ serverUrl: 'http://127.0.0.1:9/message' });
  try {
    await writeFile(
      statePath,
      JSON.stringify({
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
        resourceUrl: 'http://127.0.0.1:9/message/',
      }),
    );
    const result = await run(commands, 'reload');
    assert.equal(result.kind, 'error', 'the connection itself fails');
    assert.doesNotMatch(result.text, /belong to/u);
  } finally {
    await dispose();
  }
});

test('disposal releases the registrations', async () => {
  const { commands, sections, dispose } = await boot();
  await dispose();
  assert.equal(commands.size, 0);
  assert.equal(sections.length, 0);
});
