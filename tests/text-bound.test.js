/**
 * Tests for the shared text bound: the ends survive, the omission is stated,
 * and a cut never splits a surrogate pair.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MAX_TEXT_CHARS, boundServerInstructions, capText } from '../lib/text-bound.js';

/** @param {string} text @returns {boolean} whether any surrogate is unpaired. */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('text that already fits is returned unchanged', () => {
  assert.equal(capText('short', 10), 'short');
  assert.equal(capText('', 10), '');
  assert.equal(capText('exactlyten', 10), 'exactlyten');
  assert.equal(DEFAULT_MAX_TEXT_CHARS, 32_000);
});

test('a non-positive budget disables the bound', () => {
  const text = 'x'.repeat(DEFAULT_MAX_TEXT_CHARS + 10);
  assert.equal(capText(text, 0), text);
  assert.equal(capText(text, -5), text);
});

test('a non-string projection is empty, never the word "undefined"', () => {
  assert.equal(capText(undefined, 10), '');
  assert.equal(capText(null, 10), '');
});

test('long text keeps its head and tail and states exactly what was omitted', () => {
  const text = 'H'.repeat(1_000) + 'M'.repeat(1_000) + 'T'.repeat(1_000);
  const capped = capText(text, 300);

  assert.ok(capped.length < text.length);
  assert.match(capped, /\[2700 characters omitted: the FlowUs result exceeded 300 characters/u);
  assert.ok(capped.startsWith('H'.repeat(100)), 'the prefix survives');
  assert.ok(capped.endsWith('T'.repeat(50)), 'the suffix survives');
  assert.ok(!capped.includes('M'), 'the middle is what gets dropped');
});

test('a cut never splits a surrogate pair', () => {
  const text = '😀'.repeat(500);
  for (const budget of [11, 101, 1_001, 1_003]) {
    const capped = capText(text, budget);
    assert.equal(hasLoneSurrogate(capped), false, `budget ${budget}`);
  }
});

test('server instructions are bounded and the truncation is reported', () => {
  assert.deepEqual(boundServerInstructions('use flowus_help first'), { text: 'use flowus_help first', truncated: false });
  assert.deepEqual(boundServerInstructions(undefined), { text: '', truncated: false });
  assert.deepEqual(boundServerInstructions({ injected: true }), { text: '', truncated: false });
  assert.deepEqual(boundServerInstructions('kept as is', 0), { text: 'kept as is', truncated: false });

  const huge = boundServerInstructions('i'.repeat(50_000), 1_000);
  assert.equal(huge.truncated, true);
  assert.ok(huge.text.length < 2_000);
  assert.match(huge.text, /characters omitted/u);
  assert.equal(hasLoneSurrogate(huge.text), false);
});
