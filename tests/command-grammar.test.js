import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USAGE, parseFlowusCommand } from '../lib/command-grammar.js';

test('bare invocation shows status', () => {
  assert.deepEqual(parseFlowusCommand(''), { kind: 'status' });
  assert.deepEqual(parseFlowusCommand('   '), { kind: 'status' });
});

test('control verbs parse with surrounding whitespace', () => {
  assert.deepEqual(parseFlowusCommand(' login '), { kind: 'login' });
  assert.deepEqual(parseFlowusCommand('logout'), { kind: 'logout' });
  assert.deepEqual(parseFlowusCommand('TOOLS'), { kind: 'tools' });
  assert.deepEqual(parseFlowusCommand('reload'), { kind: 'reload' });
  assert.deepEqual(parseFlowusCommand('refresh'), { kind: 'reload' });
  assert.deepEqual(parseFlowusCommand('help'), { kind: 'help' });
});

test('control verbs reject extra arguments', () => {
  const parsed = parseFlowusCommand('login now');
  assert.equal(parsed.kind, 'help');
  assert.match(parsed.reason, /takes no arguments/u);
});

test('call without arguments defaults to an empty object', () => {
  assert.deepEqual(parseFlowusCommand('call search'), { kind: 'call', tool: 'search', args: {} });
});

test('call parses a JSON object, including spaces and newlines in the body', () => {
  const parsed = parseFlowusCommand('call search {"query": "weekly report", "limit": 3}');
  assert.deepEqual(parsed, { kind: 'call', tool: 'search', args: { query: 'weekly report', limit: 3 } });
});

test('call rejects non-object or malformed JSON with usage-shaped help', () => {
  for (const input of ['call search [1,2]', 'call search {oops}', 'call search "text"', 'call search 42', 'call search null']) {
    const parsed = parseFlowusCommand(input);
    assert.equal(parsed.kind, 'help', input);
    assert.ok(parsed.reason.length > 0, input);
  }
});

test('unknown verbs are reported, never thrown', () => {
  const parsed = parseFlowusCommand('frobnicate');
  assert.equal(parsed.kind, 'help');
  assert.match(parsed.reason, /unknown subcommand/u);
});

test('usage text names every supported subcommand', () => {
  for (const verb of ['status', 'login', 'logout', 'tools', 'call', 'reload', 'help']) {
    assert.ok(USAGE.includes(verb), verb);
  }
});
