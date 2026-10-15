/**
 * Bounding of model-facing text.
 *
 * A FlowUs page body, a block listing or a database query can be far larger
 * than a single tool result should contribute to the context window. Both the
 * plugin's result projection and the harness's own tools bound what they
 * forward; this module owns the one rule they share: keep a prefix and a suffix
 * — the ends of a document are what identify it — and say exactly how much was
 * dropped, so a reader can tell truncation from a short document and ask for a
 * narrower query instead of trusting a silently clipped answer.
 *
 * @module dsh-flowus/text-bound
 */

/** Default ceiling for one model-facing text projection (UTF-16 code units). */
export const DEFAULT_MAX_TEXT_CHARS = 32_000;

/** Share of the budget given to the prefix; the rest keeps the suffix. */
const HEAD_SHARE = 0.6;

/**
 * Cut a string without leaving a lone surrogate at either edge.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a naive cut can split a
 * surrogate pair and produce a replacement character. Emoji and rare CJK
 * characters are exactly what that hits.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function safeSlice(text, start, end) {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  const isHigh = (index) => index >= 0 && index < text.length && text.charCodeAt(index) >= 0xd800 && text.charCodeAt(index) <= 0xdbff;
  if (from > 0 && isHigh(from - 1) && from < text.length && text.charCodeAt(from) >= 0xdc00 && text.charCodeAt(from) <= 0xdfff) from += 1;
  if (to > 0 && to < text.length && isHigh(to - 1) && text.charCodeAt(to) >= 0xdc00 && text.charCodeAt(to) <= 0xdfff) to -= 1;
  return text.slice(from, to);
}

/**
 * Bound one text projection, keeping both ends and stating what was omitted.
 * @param {string} text
 * @param {number} [maxChars] - ceiling in UTF-16 code units.
 * @returns {string} the input when it already fits.
 */
export function capText(text, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * HEAD_SHARE));
  const tail = Math.max(0, maxChars - head);
  const omitted = text.length - head - tail;
  const notice = `\n\n… [${omitted} characters omitted: the FlowUs result exceeded ${Math.floor(maxChars)} characters; narrow the request to read the rest] …\n\n`;
  return `${safeSlice(text, 0, head)}${notice}${tail > 0 ? safeSlice(text, text.length - tail, text.length) : ''}`;
}
