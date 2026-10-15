import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import {
  CALL_RESULT_OUTPUT_SCHEMA,
  buildFlowusToolDefinitions,
  buildParameterSpec,
  convertJsonSchemaToValueSpec,
  describeTool,
  humanToolLabel,
  presentCallTitle,
  renderCallResult,
  toolCallKind,
} from '../lib/tool-bridge.js';

test('the output contract compiles to a schema the harness enforces', () => {
  const compiled = valueSchemaSpecToJsonSchema(CALL_RESULT_OUTPUT_SCHEMA);
  assertSupportedJsonSchema(compiled);
  assert.equal(compiled.type, 'object');
  assert.equal(compiled.additionalProperties, false);
  assert.deepEqual(
    validateJsonSchemaValue(compiled, { text: 'hi', blocks: [{ type: 'text', text: 'hi' }], isError: false }),
    [],
  );
  assert.deepEqual(
    validateJsonSchemaValue(compiled, { text: 'hi', blocks: [], structuredContent: { a: 1 }, isError: false }),
    [],
  );
  assert.ok(validateJsonSchemaValue(compiled, { text: 'hi', blocks: [] }).length > 0, 'isError is required by the value shape');
  assert.ok(validateJsonSchemaValue(compiled, { text: 'hi', blocks: [], isError: false, extra: 1 }).length > 0, 'closed object');
});

test('a converted MCP input schema compiles as the harness parameter schema', () => {
  const compiled = parameterSchemaSpecToJsonSchema(
    buildParameterSpec({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search text' },
        limit: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        filter: { type: 'object', properties: { parent: { type: 'string' } }, required: ['parent'], additionalProperties: false },
      },
      required: ['query'],
    }),
  );
  assertSupportedJsonSchema(compiled);
  assert.deepEqual(compiled.required, ['query']);
  assert.equal(compiled.properties.filter.additionalProperties, false);
  assert.deepEqual(compiled.properties.tags.items, { type: 'string' });
});

test('scalar schemas lower with their annotations', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'string', description: 'a page title' }), {
    type: 'string',
    description: 'a page title',
  });
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'integer' }), { type: 'integer' });
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'boolean', default: false }), { type: 'boolean', default: false });
});

test('scalar enums survive; a mismatched enum degrades to the plain type', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'string', enum: ['a', 'b'] }), { type: 'string', enum: ['a', 'b'] });
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'string', enum: ['a', 1] }), { type: 'string' });
});

test('const lowers with the right primitive type', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ const: 'page' }), { type: 'string', const: 'page' });
  assert.deepEqual(convertJsonSchemaToValueSpec({ const: 7 }), { type: 'integer', const: 7 });
  assert.deepEqual(convertJsonSchemaToValueSpec({ const: 1.5 }), { type: 'number', const: 1.5 });
});

test('objects carry requiredness per property and keep openness', () => {
  const converted = convertJsonSchemaToValueSpec({
    type: 'object',
    properties: { id: { type: 'string' }, limit: { type: 'integer' } },
    required: ['id'],
    additionalProperties: false,
  });
  assert.deepEqual(converted, {
    type: 'object',
    properties: { id: { type: 'string', required: true }, limit: { type: 'integer' } },
    additionalProperties: false,
  });
});

test('arrays nest their item schema', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'array', items: { type: 'string' } }), {
    type: 'array',
    items: { type: 'string' },
  });
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'array' }), { type: 'array' });
});

test('oneOf becomes the DSL union; a single branch is unwrapped', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ oneOf: [{ type: 'string' }, { type: 'integer' }] }), {
    type: 'oneOf',
    oneOf: [{ type: 'string' }, { type: 'integer' }],
  });
  assert.deepEqual(convertJsonSchemaToValueSpec({ oneOf: [{ type: 'string' }] }), { type: 'string' });
});

test('an object without an explicit type is still an object', () => {
  assert.deepEqual(convertJsonSchemaToValueSpec({ properties: { a: { type: 'string' } } }), {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: true,
  });
});

test('unsupported vocabulary degrades to unconstrained JSON instead of failing', () => {
  for (const schema of [{ $ref: '#/definitions/x' }, { type: 'weird' }, undefined, 'nope', 42]) {
    assert.deepEqual(convertJsonSchemaToValueSpec(schema), { type: 'json' }, JSON.stringify(schema));
  }
});

test('a declared type wins over keywords the DSL cannot express', () => {
  // `allOf` has no DSL counterpart, but dropping it must not discard the type.
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'string', allOf: [{ minLength: 1 }] }), { type: 'string' });
  // An object whose keys are only pattern-constrained still lowers to an open object.
  assert.deepEqual(convertJsonSchemaToValueSpec({ type: 'object', patternProperties: { '^a': { type: 'string' } } }), {
    type: 'object',
    properties: {},
    additionalProperties: true,
  });
});

test('buildParameterSpec produces the implicit property map', () => {
  const parameters = buildParameterSpec({
    type: 'object',
    properties: { query: { type: 'string', description: 'search text' } },
    required: ['query'],
  });
  assert.deepEqual(parameters, { query: { type: 'string', description: 'search text', required: true } });
  assert.deepEqual(buildParameterSpec(undefined), {});
});

test('a tool definition is namespaced, calls the raw name, and validates args', async () => {
  const calls = [];
  const [built] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 5_000,
    tools: [
      {
        name: 'search_pages',
        description: 'Search FlowUs pages',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        annotations: { readOnlyHint: true },
      },
    ],
    callTool: async (rawName, args) => {
      calls.push({ rawName, args });
      return { text: 'two hits', blocks: [{ type: 'text', text: 'two hits' }], isError: false };
    },
  });

  assert.equal(built.publicName, 'mcp__flowus__search_pages');
  assert.equal(built.rawName, 'search_pages');
  assert.equal(built.definition.name, 'mcp__flowus__search_pages');
  assert.equal(built.definition.timeoutMs, 5_000);
  assert.equal(built.definition.isConcurrencySafe({ query: 'x' }), true);

  const value = await built.definition.execute({ query: 'weekly' }, { signal: new AbortController().signal });
  assert.deepEqual(calls, [{ rawName: 'search_pages', args: { query: 'weekly' } }]);
  assert.deepEqual(value, { text: 'two hits', blocks: [{ type: 'text', text: 'two hits' }], isError: false });
  assert.deepEqual(built.definition.output.render({ query: 'weekly' }, value), [{ type: 'text', text: 'two hits' }]);
});

test('an oversized structured result is bounded in the rendered block', () => {
  const value = { text: '', blocks: [], structuredContent: { blob: 'x'.repeat(50_000) }, isError: false };
  const blocks = renderCallResult(value, 1_000);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /characters omitted/u);
  assert.ok(blocks[0].text.length < 2_000);
  // The default budget leaves a normal result untouched.
  const small = renderCallResult({ text: 'ok', blocks: [], structuredContent: { a: 1 }, isError: false });
  assert.deepEqual(small, [
    { type: 'text', text: 'ok' },
    { type: 'text', text: '\n\n{\n  "a": 1\n}' },
  ]);
});

test('every published tool carries a readable call card', () => {
  const [search, create] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [
      { name: 'flowus_search_text', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
      { name: 'flowus_create_page', description: 'Create', inputSchema: { type: 'object', properties: { parent_id: { type: 'string' } } }, annotations: { readOnlyHint: false } },
    ],
    callTool: async () => ({ text: '', blocks: [], isError: false }),
  });

  assert.deepEqual(search.definition.presentCall({ query: 'weekly report' }), {
    card: 'generic',
    kind: 'search',
    title: 'FlowUs · search text: weekly report',
  });
  // No hint argument: the card still says what the call is.
  assert.deepEqual(create.definition.presentCall({}), {
    card: 'generic',
    kind: 'edit',
    title: 'FlowUs · create page',
  });
  assert.equal(create.definition.presentCall({ parent_id: 'abc123' }).title, 'FlowUs · create page: abc123');
});

test('the call-card kind follows the tool name, not only the read-only hint', () => {
  const build = (name, readOnly) =>
    buildFlowusToolDefinitions({
      serverName: 'flowus',
      toolCallTimeoutMs: 1_000,
      tools: [{ name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: readOnly } }],
      callTool: async () => ({ text: '', blocks: [], isError: false }),
    })[0].definition.presentCall({}).kind;

  assert.equal(build('flowus_search_semantic', true), 'search');
  assert.equal(build('flowus_fetch', true), 'fetch');
  assert.equal(build('flowus_get_page', true), 'read');
  assert.equal(build('flowus_list_pages', true), 'read');
  assert.equal(build('flowus_edit_page_text', false), 'edit');
  // An unknown verb falls back to the server's own hint.
  assert.equal(build('flowus_weird_thing', true), 'read');
  assert.equal(build('flowus_weird_thing', false), 'edit');
});

test('the card helpers are pure and reusable', () => {
  assert.equal(humanToolLabel('flowus_get_page_markdown'), 'get page markdown');
  assert.equal(presentCallTitle('flowus_search_text', { query: ['a', 'b'] }), 'FlowUs · search text: a, b');
  assert.equal(presentCallTitle('flowus_get_page', { page_id: 'p1' }), 'FlowUs · get page: p1');
  assert.equal(presentCallTitle('flowus_get_page', { page_id: 'x'.repeat(200) }).length, 'FlowUs · get page: '.length + 60);
  assert.equal(presentCallTitle('flowus_get_page', null), 'FlowUs · get page');
  assert.equal(toolCallKind('flowus_help', true), 'read');
});

test('deferred loading is opt-in and lands on every definition', () => {
  const tools = [
    { name: 'flowus_help', description: 'Help', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'flowus_create_page', description: 'Create', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const eager = buildFlowusToolDefinitions({ serverName: 'flowus', toolCallTimeoutMs: 1_000, tools, callTool: async () => ({ text: '', blocks: [], isError: false }) });
  for (const built of eager) assert.equal(built.definition.deferLoading, undefined, 'off by default');

  const deferred = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools,
    deferLoading: true,
    callTool: async () => ({ text: '', blocks: [], isError: false }),
  });
  for (const built of deferred) assert.equal(built.definition.deferLoading, true);
});

test('a server-side error result fails the call', async () => {
  const [built] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [{ name: 'bad', description: 'fails', inputSchema: { type: 'object' } }],
    callTool: async () => ({ text: 'permission denied', blocks: [], isError: true }),
  });
  await assert.rejects(built.definition.execute({}, { signal: new AbortController().signal }), /permission denied/u);
});

test('invalid model arguments are rejected before the call', async () => {
  let called = false;
  const [built] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [
      {
        name: 'strict',
        description: 'needs a query',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    callTool: async () => {
      called = true;
      return { text: '', blocks: [], isError: false };
    },
  });
  await assert.rejects(built.definition.execute({}, { signal: new AbortController().signal }), /query/u);
  assert.equal(called, false);
});

test('a duplicate public name rejects the whole generation', () => {
  assert.throws(
    () =>
      buildFlowusToolDefinitions({
        serverName: 'flowus',
        toolCallTimeoutMs: 1_000,
        tools: [
          { name: 'dup', description: 'a', inputSchema: { type: 'object' } },
          { name: 'dup', description: 'b', inputSchema: { type: 'object' } },
        ],
        callTool: async () => ({ text: '', blocks: [], isError: false }),
      }),
    /listed tool "dup" twice/u,
  );
});

test('a tool requiring the task extension is skipped, not registered', () => {
  const logs = [];
  const built = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [
      { name: 'async_task', description: 'task', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
      { name: 'sync_tool', description: 'sync', inputSchema: { type: 'object' } },
    ],
    callTool: async () => ({ text: '', blocks: [], isError: false }),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(built.map((tool) => tool.rawName), ['sync_tool']);
  assert.match(logs.join('\n'), /task execution extension/u);
});

test('read-only annotations only opt into parallel dispatch', () => {
  const [readOnly] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [{ name: 'read', description: 'r', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ text: '', blocks: [], isError: false }),
  });
  const [writer] = buildFlowusToolDefinitions({
    serverName: 'flowus',
    toolCallTimeoutMs: 1_000,
    tools: [{ name: 'write', description: 'w', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }],
    callTool: async () => ({ text: '', blocks: [], isError: false }),
  });
  assert.equal(readOnly.definition.isConcurrencySafe({}), true);
  assert.equal(writer.definition.isConcurrencySafe({}), false);
});

test('renderCallResult always renders something and appends structured content', () => {
  assert.deepEqual(renderCallResult({ text: 'hi', isError: false }), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(renderCallResult({ text: '', isError: false }), [{ type: 'text', text: '(FlowUs returned no content)' }]);
  const rendered = renderCallResult({ text: 'hi', structuredContent: { n: 1 }, isError: false });
  assert.equal(rendered.length, 2);
  assert.match(rendered[1].text, /"n": 1/u);
});

test('describeTool falls back to the title and always names the raw tool', () => {
  assert.equal(describeTool({ name: 'a', description: 'Does A' }), 'Does A\n(FlowUs MCP tool: a)');
  assert.equal(describeTool({ name: 'a', title: 'Tool A' }), 'Tool A\n(FlowUs MCP tool: a)');
  assert.equal(describeTool({ name: 'a' }), 'FlowUs MCP tool "a"');
});
