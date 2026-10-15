/**
 * Integration test against the REAL harness services.
 *
 * Unlike `plugin-apply.test.js` (which uses stand-ins), this loads the shipped
 * `ToolRuntime`, `CommandRuntime` and `SystemPrompt` into a bare cordis
 * context and drives actual registrations through them:
 *
 * - `/flowus` really lands in the command registry and is listed there;
 * - the prompt section really survives a real prompt assembly;
 * - a bridged FlowUs tool really registers on the real tool registry, exposes
 *   its JSON Schema to the model, and executes through the full pipeline
 *   (argument validation, output-contract validation, content rendering).
 *
 * No network: the plugin is activated with `autoConnect: false`.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as plugin from '../lib/index.js';
import { buildFlowusToolDefinitions } from '../lib/tool-bridge.js';

/** Boot a real harness service triple plus the plugin. */
async function boot() {
  const ctx = new Context();
  const fibers = [];
  for (const service of [ToolRuntime, CommandRuntime, SystemPrompt]) fibers.push(await ctx.plugin(service));
  const statePath = join(await mkdtemp(join(tmpdir(), 'dsh-flowus-real-')), 'oauth.json');
  fibers.push(
    await ctx.plugin(
      { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply },
      plugin.Config({ statePath, autoConnect: false }),
    ),
  );
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose();
    },
  };
}

test('the real command registry carries /flowus with its descriptor', async () => {
  const { ctx, dispose } = await boot();
  try {
    const agent = /** @type {any} */ ({});
    const found = ctx.commands.find(agent, 'flowus');
    assert.ok(found, 'the command resolves');
    assert.equal(found.name, 'flowus');
    assert.match(found.description, /FlowUs/u);
    assert.match(found.input.hint, /login/u);
    const listed = ctx.commands.list(agent).map((descriptor) => descriptor.name);
    assert.ok(listed.includes('flowus'), `listed: ${listed.join(', ')}`);

    const text = (await found.handler({ rawInput: 'help', signal: new AbortController().signal, attachments: [] })).text;
    assert.match(text, /Usage: \/flowus/u);
  } finally {
    await dispose();
  }
});

test('the real prompt assembly includes the FlowUs section', async () => {
  const { ctx, dispose } = await boot();
  try {
    const assembly = await ctx.systemPrompt.assemble();
    const section = assembly.sections.find((entry) => entry.name === 'flowus:flowus');
    assert.ok(section, `sections: ${assembly.sections.map((entry) => entry.name).join(', ')}`);
    assert.match(section.text, /FlowUs/u);
    assert.match(section.text, /\/flowus login/u);
    assert.equal(section.interpolate, false);
  } finally {
    await dispose();
  }
});

test('a bridged tool registers on the real registry and executes end to end', async () => {
  const { ctx, dispose } = await boot();
  try {
    const calls = [];
    const [built] = buildFlowusToolDefinitions({
      serverName: 'flowus',
      toolCallTimeoutMs: 5_000,
      tools: [
        {
          name: 'search_pages',
          description: 'Search FlowUs pages',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'search text' }, limit: { type: 'integer' } },
            required: ['query'],
          },
          annotations: { readOnlyHint: true },
        },
      ],
      callTool: async (rawName, args) => {
        calls.push({ rawName, args });
        return { text: `found 2 pages for ${args.query}`, blocks: [{ type: 'text', text: 'x' }], isError: false };
      },
    });

    const unregister = ctx.tools.register(built.definition);
    try {
      // The model-facing schema is the compiled parameter schema under the public name.
      const schema = ctx.tools.schemas().find((entry) => entry.name === 'mcp__flowus__search_pages');
      assert.ok(schema, 'the tool is visible to the model');
      assert.deepEqual(schema.parameters.required, ['query']);
      assert.equal(schema.parameters.properties.query.type, 'string');
      assert.match(schema.description, /Search FlowUs pages/u);
      assert.equal(schema.deferLoading, undefined, 'eager by default');
      assert.equal(typeof ctx.tools.get('mcp__flowus__search_pages').presentCall, 'function', 'the call card is registered');

      const result = await ctx.tools.execute({
        callId: /** @type {any} */ ('call-1'),
        name: 'mcp__flowus__search_pages',
        arguments: { query: 'weekly' },
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false);
      assert.deepEqual(calls, [{ rawName: 'search_pages', args: { query: 'weekly' } }]);
      assert.deepEqual(result.content, [{ type: 'text', text: 'found 2 pages for weekly' }]);

      // Invalid arguments are rejected by the registry before the body runs.
      const invalid = await ctx.tools.execute({
        callId: /** @type {any} */ ('call-2'),
        name: 'mcp__flowus__search_pages',
        arguments: {},
        signal: new AbortController().signal,
      });
      assert.equal(invalid.isError, true);
      assert.deepEqual(calls.length, 1, 'the tool body never ran with invalid arguments');
    } finally {
      unregister();
    }
    assert.equal(ctx.tools.get('mcp__flowus__search_pages'), undefined, 'unregistered on disposal');
  } finally {
    await dispose();
  }
});

test('a deferred generation reaches the model-facing schema as deferred', async () => {
  const { ctx, dispose } = await boot();
  try {
    const [built] = buildFlowusToolDefinitions({
      serverName: 'flowus',
      toolCallTimeoutMs: 5_000,
      deferLoading: true,
      tools: [{ name: 'search_pages', description: 'Search FlowUs pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      callTool: async () => ({ text: '', blocks: [], isError: false }),
    });
    const unregister = ctx.tools.register(built.definition);
    try {
      const schema = ctx.tools.schemas().find((entry) => entry.name === 'mcp__flowus__search_pages');
      assert.equal(schema.deferLoading, true);
    } finally {
      unregister();
    }
  } finally {
    await dispose();
  }
});

test('a FlowUs error result surfaces as an error through the real pipeline', async () => {
  const { ctx, dispose } = await boot();
  try {
    const [built] = buildFlowusToolDefinitions({
      serverName: 'flowus',
      toolCallTimeoutMs: 5_000,
      tools: [{ name: 'readonly_probe', description: 'probe', inputSchema: { type: 'object' } }],
      callTool: async () => ({ text: 'permission denied by FlowUs', blocks: [], isError: true }),
    });
    const unregister = ctx.tools.register(built.definition);
    try {
      const result = await ctx.tools.execute({
        callId: /** @type {any} */ ('call-3'),
        name: 'mcp__flowus__readonly_probe',
        arguments: {},
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true);
      assert.match(result.content.map((block) => block.text).join('\n'), /permission denied/u);
    } finally {
      unregister();
    }
  } finally {
    await dispose();
  }
});
