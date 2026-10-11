import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { browserCandidates, openInBrowser } from '../lib/browser.js';

const URL_ = 'https://api.flowus.cn/oauth/authorize?client_id=a&scope=all&state=b';

test('every candidate passes the URL as exactly one argv element', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const candidates = browserCandidates(URL_, platform);
    assert.ok(candidates.length >= 1, platform);
    for (const candidate of candidates) {
      const matching = candidate.args.filter((arg) => arg.includes('client_id=a'));
      assert.equal(matching.length, 1, `${platform} ${candidate.command}`);
    }
  }
});

test('windows tries the shell-free launchers before cmd', () => {
  const commands = browserCandidates(URL_, 'win32').map((candidate) => candidate.command);
  assert.deepEqual(commands, ['rundll32.exe', 'explorer.exe', 'cmd']);
  const cmd = browserCandidates(URL_, 'win32').at(-1);
  assert.equal(cmd.args[0], '/c');
  assert.ok(cmd.args.at(-1).startsWith('"'), 'the URL is quoted so cmd cannot split it at &');
});

test('a successful first launcher reports opened', async () => {
  const launched = [];
  const spawnImpl = (command, args) => {
    launched.push({ command, args });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const result = await openInBrowser(URL_, { platform: 'win32', spawnImpl });
  assert.deepEqual(result, { opened: true, command: 'rundll32.exe' });
  assert.equal(launched.length, 1);
});

test('a failing launcher falls through to the next candidate', async () => {
  const attempted = [];
  const spawnImpl = (command) => {
    attempted.push(command);
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => (command === 'rundll32.exe' ? child.emit('error', new Error('missing')) : child.emit('spawn')));
    return child;
  };
  const result = await openInBrowser(URL_, { platform: 'win32', spawnImpl });
  assert.equal(result.opened, true);
  assert.equal(result.command, 'explorer.exe');
  assert.deepEqual(attempted, ['rundll32.exe', 'explorer.exe']);
});

test('an exhausting platform reports failure with details instead of throwing', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('error', new Error('nope')));
    return child;
  };
  const result = await openInBrowser(URL_, { platform: 'linux', spawnImpl });
  assert.equal(result.opened, false);
  assert.match(result.detail, /nope/u);
});

test('a synchronous spawn throw is contained', async () => {
  const spawnImpl = () => {
    throw new Error('cannot spawn');
  };
  const result = await openInBrowser(URL_, { platform: 'linux', spawnImpl });
  assert.equal(result.opened, false);
  assert.match(result.detail, /cannot spawn/u);
});
