import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonStateStore, LOCK_WAIT_MS, resolveHarnessHome } from '../lib/store.js';

/** @returns {Promise<string>} a fresh temporary file path */
const freshPath = async () => join(await mkdtemp(join(tmpdir(), 'dsh-flowus-')), 'oauth.json');

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a missing file reads as an empty document', async () => {
  const store = new JsonStateStore(await freshPath());
  assert.deepEqual(await store.read(), {});
});

test('mutate writes atomically and persists across store instances', async () => {
  const file = await freshPath();
  const store = new JsonStateStore(file);
  await store.mutate((doc) => ({ ...doc, clientInformation: { client_id: 'c1' } }));
  await store.mutate((doc) => ({ ...doc, tokens: { access_token: 'a' } }));
  const reread = new JsonStateStore(file);
  assert.deepEqual(await reread.read(), { clientInformation: { client_id: 'c1' }, tokens: { access_token: 'a' } });
  assert.match(await readFile(file, 'utf8'), /client_id/u);
});

test('a mutate returning undefined leaves the document untouched', async () => {
  const store = new JsonStateStore(await freshPath());
  await store.mutate((doc) => ({ ...doc, keep: true }));
  const after = await store.mutate(() => undefined);
  assert.deepEqual(after, { keep: true });
});

test('the mutator receives a copy, so a thrown mutator cannot corrupt state', async () => {
  const store = new JsonStateStore(await freshPath());
  await store.mutate((doc) => ({ ...doc, value: 1 }));
  await assert.rejects(
    store.mutate((doc) => {
      doc.value = 99;
      throw new Error('boom');
    }),
    /boom/u,
  );
  assert.deepEqual(await store.read(), { value: 1 });
});

test('concurrent mutations are serialized', async () => {
  const store = new JsonStateStore(await freshPath());
  await Promise.all(Array.from({ length: 20 }, () => store.mutate((doc) => ({ ...doc, n: (doc.n ?? 0) + 1 }))));
  assert.equal((await store.read()).n, 20);
});

test('a corrupt document is moved aside and replaced by an empty state', async () => {
  const file = await freshPath();
  await writeFile(file, '{ not json');
  const store = new JsonStateStore(file);
  assert.deepEqual(await store.read(), {});
  assert.match(await readFile(`${file}.corrupt`, 'utf8'), /not json/u);
  await store.mutate((doc) => ({ ...doc, ok: true }));
  assert.deepEqual(await store.read(), { ok: true });
});

test('clear removes the document', async () => {
  const file = await freshPath();
  const store = new JsonStateStore(file);
  await store.mutate(() => ({ a: 1 }));
  await store.clear();
  assert.deepEqual(await store.read(), {});
});

test('constructor rejects an empty path', () => {
  assert.throws(() => new JsonStateStore(''), TypeError);
});

test('harness home prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveHarnessHome({ DSH_HOME: 'D:\\dsh-home' }), 'D:\\dsh-home');
  assert.ok(resolveHarnessHome({}).endsWith('.dsh'));
  assert.ok(resolveHarnessHome({ DSH_HOME: '  ' }).endsWith('.dsh'));
});

test('the harness primitives are used when the host provides them', async () => {
  const file = await freshPath();
  const calls = [];
  const store = new JsonStateStore(file, {
    atomicWriter: {
      writeFileAtomic: async (target, content, options) => {
        calls.push({ kind: 'write', target, options, content });
        await writeFile(target, content, { mode: options.mode });
      },
      withFileLock: async (target, operation, options) => {
        calls.push({ kind: 'lock', target, options });
        return await operation();
      },
    },
  });

  await store.mutate((doc) => ({ ...doc, ok: true }));
  assert.deepEqual(calls.map((call) => call.kind), ['lock', 'write'], 'the cycle is locked before it is committed');
  assert.equal(calls[0].target, file);
  assert.equal(calls[0].options.waitMs, LOCK_WAIT_MS);
  assert.deepEqual(calls[1].options, { mode: 0o600, dirMode: 0o700 });
  assert.deepEqual(await store.read(), { ok: true });
  assert.equal(calls.filter((call) => call.kind === 'lock').length, 1, 'a read never takes the writer lock');
});

test('a read-modify-write cycle is serialized across store instances', async () => {
  const file = await freshPath();
  const first = new JsonStateStore(file);
  const second = new JsonStateStore(file);
  const bump = (store) =>
    store.mutate(async (doc) => {
      await sleep(10);
      return { ...doc, n: (doc.n ?? 0) + 1 };
    });

  // Two stores have two independent queues: only the file lock keeps them apart.
  await Promise.all([bump(first), bump(second), bump(first), bump(second)]);
  assert.equal((await first.read()).n, 4, 'no increment was lost');
});

test('the local fallback writes atomically and leaves no temporary behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-flowus-'));
  const file = join(dir, 'oauth.json');
  const store = new JsonStateStore(file, { atomicWriter: null });

  await store.mutate((doc) => ({ ...doc, tokens: { access_token: 'a' } }));
  assert.deepEqual(await store.read(), { tokens: { access_token: 'a' } });
  assert.deepEqual(await readdir(dir), ['oauth.json']);
  assert.deepEqual(await store.pruneLeftovers(), []);
});

test('pruneLeftovers drops temporary and quarantined siblings only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-flowus-'));
  const file = join(dir, 'oauth.json');
  await writeFile(file, '{"ok":true}');
  await writeFile(`${file}.deadbeef.tmp`, 'half-written');
  await writeFile(`${file}.4242.tmp`, 'legacy naming');
  await writeFile(`${file}.corrupt`, '{ broken');
  await writeFile(join(dir, 'other.json'), 'keep me');

  const removed = await new JsonStateStore(file).pruneLeftovers();
  assert.deepEqual(removed.sort(), ['oauth.json.4242.tmp', 'oauth.json.corrupt', 'oauth.json.deadbeef.tmp']);
  assert.deepEqual((await readdir(dir)).sort(), ['oauth.json', 'other.json']);
  assert.deepEqual(await new JsonStateStore(file).read(), { ok: true });
});

test('a corrupt document is quarantined, then prunable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-flowus-'));
  const file = join(dir, 'oauth.json');
  await writeFile(file, 'not json at all');
  const store = new JsonStateStore(file);

  assert.deepEqual(await store.read(), {});
  assert.deepEqual(await readdir(dir), ['oauth.json.corrupt']);
  assert.deepEqual(await store.pruneLeftovers(), ['oauth.json.corrupt']);
  assert.deepEqual(await readdir(dir), []);
  assert.deepEqual(await store.read(), {});
});
