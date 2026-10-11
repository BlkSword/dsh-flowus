import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PUBLIC_NAME_LENGTH, SERVER_NAME_PATTERN, publicToolName } from '../lib/tool-names.js';

test('clean identity is verbatim', () => {
  assert.equal(publicToolName('flowus', 'create_page'), 'mcp__flowus__create_page');
});

test('deterministic across calls', () => {
  assert.equal(publicToolName('flowus', 'x y'), publicToolName('flowus', 'x y'));
});

test('invalid characters are normalized and never collapse two identities', () => {
  const dashed = publicToolName('flowus', 'a.b');
  const underscored = publicToolName('flowus', 'a_b');
  assert.match(dashed, /^[A-Za-z0-9_-]+$/u);
  assert.match(underscored, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(dashed, underscored);
});

test('over-long names are truncated to the function-name budget', () => {
  const name = publicToolName('flowus', 'x'.repeat(200));
  assert.ok(name.length <= MAX_PUBLIC_NAME_LENGTH, `length ${name.length}`);
  assert.match(name, /^[A-Za-z0-9_-]+$/u);
});

test('server name grammar matches the stock bridge reservation', () => {
  assert.ok(SERVER_NAME_PATTERN.test('flowus'));
  assert.ok(SERVER_NAME_PATTERN.test('flow-us_1'));
  assert.ok(!SERVER_NAME_PATTERN.test(''));
  assert.ok(!SERVER_NAME_PATTERN.test('a'.repeat(33)));
  assert.ok(!SERVER_NAME_PATTERN.test('flowus/other'));
});
