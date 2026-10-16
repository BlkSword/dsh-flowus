/**
 * Bridge MCP tool definitions onto the harness tool registry.
 *
 * MCP publishes raw JSON Schema; the harness `defineTool` API takes its own
 * authoring DSL. {@link convertJsonSchemaToValueSpec} lowers the portable
 * subset (single `type`, `properties`/`required`/`additionalProperties`,
 * `items`, scalar `enum`/`const`, `oneOf`) and falls back to the
 * unconstrained `{ type: 'json' }` node for anything it cannot represent, so an
 * exotic upstream schema degrades to "accept any JSON" instead of failing the
 * whole tool set.
 *
 * @module dsh-flowus/tool-bridge
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_MAX_TEXT_CHARS, capText } from './text-bound.js';
import { publicToolName } from './tool-names.js';

/** Keys copied verbatim onto a value-schema node. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/**
 * Copy author-facing annotations onto a converted node.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function withAnnotations(target, source) {
  for (const key of ANNOTATION_KEYS) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

/**
 * Whether a value is a JSON Schema scalar acceptable for `enum`/`const`.
 * @param {unknown} value
 * @returns {boolean}
 */
function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Convert one MCP JSON Schema node into the harness value-schema DSL.
 * @param {unknown} node - a JSON Schema node (may be `undefined`).
 * @returns {Record<string, unknown>} a `ValueSchemaSpec`; `{ type: 'json' }` when unsupported.
 */
export function convertJsonSchemaToValueSpec(node) {
  if (node === undefined || node === null || typeof node !== 'object' || Array.isArray(node)) return { type: 'json' };
  const schema = /** @type {Record<string, unknown>} */ (node);

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => convertJsonSchemaToValueSpec(branch));
    if (branches.length >= 2) return withAnnotations({ type: 'oneOf', oneOf: branches }, schema);
    if (branches.length === 1) return branches[0];
    return { type: 'json' };
  }

  if (schema.const !== undefined) {
    if (typeof schema.const === 'string') return withAnnotations({ type: 'string', const: schema.const }, schema);
    if (typeof schema.const === 'number') {
      const spec = Number.isInteger(schema.const)
        ? { type: 'integer', const: schema.const }
        : { type: 'number', const: schema.const };
      return withAnnotations(spec, schema);
    }
    if (typeof schema.const === 'boolean') return withAnnotations({ type: 'boolean', const: schema.const }, schema);
    if (schema.const === null) return withAnnotations({ type: 'null', const: null }, schema);
    return { type: 'json' };
  }

  const type = typeof schema.type === 'string' ? schema.type : undefined;

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    /** @type {Record<string, unknown>} */
    const spec = { type };
    if (Array.isArray(schema.enum)) {
      const allowed = schema.enum.filter(isScalar);
      const homogeneous = allowed.every((entry) =>
        type === 'null' ? entry === null : typeof entry === type || (type === 'integer' && typeof entry === 'number' && Number.isInteger(entry)),
      );
      if (allowed.length === schema.enum.length && homogeneous) spec.enum = allowed;
    }
    return withAnnotations(spec, schema);
  }

  if (type === 'array') {
    /** @type {Record<string, unknown>} */
    const spec = { type: 'array' };
    if (schema.items !== undefined) spec.items = convertJsonSchemaToValueSpec(schema.items);
    return withAnnotations(spec, schema);
  }

  if (type === 'object' || (type === undefined && (schema.properties !== undefined || schema.required !== undefined))) {
    const required = Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === 'string') : [];
    /** @type {Record<string, unknown>} */
    const properties = {};
    const declared = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? /** @type {Record<string, unknown>} */ (schema.properties)
      : {};
    for (const [key, child] of Object.entries(declared)) {
      const converted = convertJsonSchemaToValueSpec(child);
      properties[key] = required.includes(key) ? { ...converted, required: true } : converted;
    }
    return withAnnotations(
      { type: 'object', properties, additionalProperties: schema.additionalProperties !== false },
      schema,
    );
  }

  return { type: 'json' };
}

/**
 * Convert an MCP `inputSchema` into the harness per-property parameter spec.
 * @param {unknown} inputSchema
 * @returns {Record<string, unknown>} implicit open object root properties.
 */
export function buildParameterSpec(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return {};
  const converted = convertJsonSchemaToValueSpec(inputSchema);
  const properties = converted?.type === 'object' ? converted.properties : undefined;
  return properties && typeof properties === 'object' ? /** @type {Record<string, unknown>} */ (properties) : {};
}

/** Canonical output schema shared by every bridged FlowUs tool. */
export const CALL_RESULT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text projection of the FlowUs tool result.', required: true },
    blocks: { type: 'array', description: 'Raw MCP content blocks returned by the server.', required: true },
    structuredContent: { type: 'json', description: 'MCP structuredContent, when the server provides it.' },
    isError: { type: 'boolean', description: 'Whether the server flagged the result as an error.', required: true },
  },
  additionalProperties: false,
});

/**
 * Render one canonical FlowUs tool value for the model.
 *
 * The session already bounds the text projection; this bound covers the
 * structured content, which is rendered here as JSON and would otherwise carry
 * a whole database query into the context window.
 * @param {{ text: string, structuredContent?: unknown, isError: boolean }} value
 * @param {number} [maxChars]
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function renderCallResult(value, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  /** @type {Array<{ type: 'text', text: string }>} */
  const blocks = [];
  const text = typeof value?.text === 'string' ? value.text : '';
  if (text.length > 0) blocks.push({ type: 'text', text: capText(text, maxChars) });
  if (value?.structuredContent !== undefined) {
    const json = capText(JSON.stringify(value.structuredContent, null, 2), maxChars);
    blocks.push({ type: 'text', text: `${text.length > 0 ? '\n\n' : ''}${json}` });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(FlowUs returned no content)' });
  return blocks;
}

/**
 * The presentation kind for one FlowUs tool, from its own name.
 *
 * The harness renders a call card from this: searches and reads should not look
 * like the calls that change the workspace.
 * @param {string} rawName
 * @param {boolean} readOnly
 * @returns {'read' | 'search' | 'fetch' | 'edit' | 'other'}
 */
export function toolCallKind(rawName, readOnly) {
  const rest = String(rawName).replace(/^flowus_/u, '');
  if (/^search/u.test(rest)) return 'search';
  if (/^fetch/u.test(rest)) return 'fetch';
  if (/^(get|list|help)/u.test(rest)) return 'read';
  if (/^(create|append|update|edit|move|mutate|upload|duplicate)/u.test(rest)) return 'edit';
  return readOnly ? 'read' : 'edit';
}

/**
 * A human label for one tool: the server's own prefix is noise in a card title.
 * @param {string} rawName
 * @returns {string}
 */
export function humanToolLabel(rawName) {
  return String(rawName).replace(/^flowus_/u, '').replace(/_/gu, ' ');
}

/** Argument keys worth showing next to the card title, most specific first. */
const TITLE_ARG_KEYS = ['query', 'parent_id', 'page_id', 'database_id', 'record_id', 'url', 'name', 'title', 'id', 'node_id'];

/**
 * Build the pending-call card title: what this call is about, at a glance.
 * @param {string} rawName
 * @param {unknown} args
 * @returns {string}
 */
export function presentCallTitle(rawName, args) {
  const record = args && typeof args === 'object' ? /** @type {Record<string, unknown>} */ (args) : {};
  const label = `FlowUs · ${humanToolLabel(rawName)}`;
  for (const key of TITLE_ARG_KEYS) {
    const value = record[key];
    const text = Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(', ') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    if (text.trim().length > 0) return `${label}: ${text.trim().slice(0, 60)}`;
  }
  return label;
}

/**
 * Build the model-facing description for one MCP tool.
 * @param {{ name: string, title?: string, description?: string }} tool
 * @returns {string}
 */
export function describeTool(tool) {
  const parts = [];
  const summary = typeof tool.description === 'string' && tool.description.trim().length > 0
    ? tool.description.trim()
    : typeof tool.title === 'string' && tool.title.trim().length > 0
      ? tool.title.trim()
      : `FlowUs MCP tool "${tool.name}"`;
  parts.push(summary);
  if (!summary.includes(tool.name)) parts.push(`(FlowUs MCP tool: ${tool.name})`);
  return parts.join('\n');
}

/**
 * Build registry-ready definitions for one discovered tool generation.
 *
 * Every definition calls back into {@link callTool} with the raw MCP name; the
 * public name is only ever model-facing. A duplicate public name or a tool
 * that requires the unsupported task-based execution extension rejects the
 * whole generation before anything is registered.
 *
 * @param {object} options
 * @param {object[]} options.tools - raw MCP tool definitions.
 * @param {string} options.serverName - namespace segment for public names.
 * @param {(rawName: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{ text: string, blocks: unknown[], structuredContent?: unknown, isError: boolean }>} options.callTool
 * @param {number} options.toolCallTimeoutMs
 * @param {number} [options.maxResultChars] - ceiling for one rendered result.
 * @param {boolean} [options.deferLoading] - publish the tools as deferred, so the harness keeps them out of the always-on schema block.
 * @param {(message: string) => void} [options.log]
 * @returns {Array<{ publicName: string, rawName: string, definition: object, description: string, readOnly: boolean }>}
 */
export function buildFlowusToolDefinitions(options) {
  const { tools, serverName, callTool, toolCallTimeoutMs } = options;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_TEXT_CHARS;
  const deferred = options.deferLoading === true;
  const log = options.log ?? (() => {});
  /** @type {Map<string, object>} */
  const definitions = new Map();
  /** @type {Array<{ publicName: string, rawName: string, definition: object, description: string, readOnly: boolean }>} */
  const built = [];

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    if (tool.execution?.taskSupport === 'required') {
      log(`flowus: skipping tool ${tool.name}: it requires the MCP task execution extension, which this plugin does not implement`);
      continue;
    }
    const publicName = publicToolName(serverName, tool.name);
    if (definitions.has(publicName)) {
      throw new Error(`flowus: the server listed tool "${tool.name}" twice (public name ${publicName}); refusing to register an ambiguous tool set`);
    }
    // One read of the server's own hint, used both for local scheduling and for
    // the read-only/write label the settings page shows.
    const readOnly = tool.annotations?.readOnlyHint === true;
    const definition = defineTool({
      name: publicName,
      description: describeTool(tool),
      parameters: /** @type {import('@deepseek-ai/dsh-tools').ParameterSchemaSpec} */ (buildParameterSpec(tool.inputSchema)),
      output: {
        // The DSL's inferred value shape collapses in plain JavaScript, where an
        // object literal widens `type` to `string`; the shared constant is
        // checked against the harness instead by
        // tests/tool-bridge.test.js (`valueSchemaSpecToJsonSchema` +
        // `assertSupportedJsonSchema`).
        schema: /** @type {import('@deepseek-ai/dsh-tools').ValueSchemaSpec} */ (CALL_RESULT_OUTPUT_SCHEMA),
        render: (_args, value) => renderCallResult(value, maxResultChars),
      },
      timeoutMs: toolCallTimeoutMs,
      isConcurrencySafe: () => readOnly,
      // One card the transcript can read: the kind separates reads and searches
      // from the calls that change the workspace, and the title says what the
      // call is about instead of dumping its arguments.
      presentCall: (args) => ({ card: 'generic', kind: toolCallKind(tool.name, readOnly), title: presentCallTitle(tool.name, args) }),
      // Opt-in: with deferred loading the harness keeps these schemas out of the
      // always-on tool block and activates them through a tool-addition message.
      ...(deferred ? { deferLoading: true } : {}),
      execute: async (args, exec) => {
        const value = await callTool(tool.name, args, { signal: exec.signal });
        if (value.isError) throw new Error(value.text.length > 0 ? value.text : `FlowUs tool ${tool.name} reported an error`);
        // Same collapsed inference as above: the runtime shape is the value the
        // session normalized, and its output schema is enforced by the registry.
        return /** @type {never} */ (/** @type {unknown} */ (value));
      },
    });
    definitions.set(publicName, definition);
    built.push({ publicName, rawName: tool.name, definition, description: describeTool(tool), readOnly });
  }
  return built;
}
