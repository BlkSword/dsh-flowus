import { createHash } from 'node:crypto';

/**
 * Model-facing tool naming for the FlowUs MCP bridge.
 *
 * The naming contract mirrors `@deepseek-ai/dsh-mcp-client` exactly so the same
 * FlowUs tool keeps the same model-facing name whether it reaches the harness
 * through this plugin or through the stock MCP bridge: identity is
 * `(serverName, rawName)` and the public name is
 * `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * contract (at most 64 characters, `[A-Za-z0-9_-]`). A lossy normalization
 * appends a 12-hex-char SHA-256 of the identity, so distinct MCP identities can
 * never collapse into one public name. The raw name is only ever sent on the
 * wire; the public name is never parsed back into it.
 *
 * @module dsh-flowus/tool-names
 */

/** DeepSeek function-name contract: at most 64 characters. */
export const MAX_PUBLIC_NAME_LENGTH = 64;

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** Hex characters of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;

/** Allowed `serverName` values; matches the stock MCP bridge's reservation grammar. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Derive the model-facing public name for one MCP tool.
 * @param serverName - stable local namespace from plugin config.
 * @param rawName - the MCP server's own tool name.
 * @returns the globally unique, model-facing tool name.
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, '_');
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
