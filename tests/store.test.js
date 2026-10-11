import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonStateStore, resolveHarnessHome } from '../lib/store.js';

/** @returns {Promise<string>} a fresh temporary file path */
const freshPath = async () => join(await mkdtemp(join(tmpdir(), 'dsh-flowus-')), 'oauth.json');

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
