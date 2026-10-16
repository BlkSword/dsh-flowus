/**
 * Durable, private state file for the FlowUs OAuth client.
 *
 * One JSON document holds the dynamically registered client identity, the PKCE
 * code verifier of an in-flight authorization, and the current token set
 * (access token, refresh token, expiry).
 *
 * Writes go through the harness's own file primitives when they are present
 * (`@deepseek-ai/dsh-atomic-write`): a random-suffix sibling opened with
 * exclusive create is renamed over the target, so a reader observes either the
 * old or the new complete document, a symlink planted at the temp path cannot
 * be followed, and the replacement inode carries mode 0600 without a chmod
 * race. The same module's writer lock serializes the read-modify-write cycle
 * across processes, because two DSH processes sharing one `DSH_HOME` could
 * otherwise resurrect a state the other just replaced — a rotated refresh token
 * lost that way signs the user out. Readers stay lock-free either way.
 *
 * Those primitives are optional: without them the store keeps an equivalent
 * local implementation. Either way a crash cannot leave a half-written
 * document, `pruneLeftovers()` drops the temporary and quarantined siblings a
 * failure may have left behind, and the file is created with mode 0600 where
 * the platform honors it.
 *
 * @module dsh-flowus/store
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Resolve the Harness home the same way the CLI does. */
export function resolveHarnessHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

/** Default private state path: `<DSH_HOME>/flowus/oauth.json`. */
export function defaultStatePath(env = process.env) {
  return join(resolveHarnessHome(env), 'flowus', 'oauth.json');
}

/** How long one writer waits for the cross-process lock before failing. */
export const LOCK_WAIT_MS = 10_000;

/** @type {Awaited<ReturnType<typeof loadAtomicWrite>> | undefined} */
let atomicWriteModule;

/**
 * Resolve the harness file primitives once.
 *
 * The import is optional on purpose: a host that does not ship them (or a unit
 * test that wants the local path) must not turn a credential write into a load
 * failure.
 * @returns {Promise<{ writeFileAtomic?: (file: string, content: string, options: { mode: number, dirMode?: number }) => Promise<void>, withFileLock?: (file: string, operation: () => Promise<unknown>, options?: { waitMs?: number }) => Promise<unknown> } | null>}
 */
async function loadAtomicWrite() {
  if (atomicWriteModule === undefined) {
    atomicWriteModule = await import('@deepseek-ai/dsh-atomic-write').catch(() => null);
  }
  return atomicWriteModule;
}

/**
 * Serialized JSON store over one file.
 *
 * Every public method tolerates a missing file (empty state) and a corrupt
 * file (the unreadable document is moved aside to `<file>.corrupt` so the next
 * write starts clean instead of silently discarding the evidence).
 */
export class JsonStateStore {
  /** @type {string} */
  #file;
  /** @type {Promise<unknown>} */
  #queue = Promise.resolve();
  /**
   * Harness primitives: `undefined` resolves them lazily, `null` forces the
   * local implementation, an object is used as given (the test seam).
   * @type {{ writeFileAtomic?: Function, withFileLock?: Function } | null | undefined}
   */
  #atomic;

  /**
   * @param {string} file absolute path of the state document.
   * @param {{ atomicWriter?: { writeFileAtomic?: Function, withFileLock?: Function } | null }} [options]
   */
  constructor(file, options = {}) {
    if (typeof file !== 'string' || file.trim().length === 0) throw new TypeError('state file path is required');
    this.#file = file;
    this.#atomic = options.atomicWriter;
  }

  /** @returns {string} the backing file path. */
  get file() {
    return this.#file;
  }

  /**
   * Read the current document. Readers never take the writer lock: the commit
   * is a rename, so a read sees one complete document or the other.
   * @returns {Promise<Record<string, unknown>>} the stored object, or `{}`.
   */
  async read() {
    return this.#enqueue(async () => this.#readUnlocked());
  }

  /**
   * Apply one read-modify-write cycle.
   *
   * The cycle is serialized in-process by this store's queue and, when the
   * harness lock is available, across processes as well.
   * @param {(draft: Record<string, unknown>) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>} mutate
   *   receives a deep copy of the current document; return the replacement, or
   *   `undefined` to leave the document untouched.
   * @returns {Promise<Record<string, unknown>>} the document after the cycle.
   */
  async mutate(mutate) {
    return this.#enqueue(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const primitives = await this.#primitives();
      const cycle = async () => {
        const current = await this.#readUnlocked();
        const draft = structuredClone(current);
        const next = await mutate(draft);
        if (next === undefined) return current;
        await this.#writeUnlocked(next, primitives);
        return structuredClone(next);
      };
      if (typeof primitives?.withFileLock !== 'function') return cycle();
      return /** @type {Promise<Record<string, unknown>>} */ (
        primitives.withFileLock(this.#file, cycle, { waitMs: LOCK_WAIT_MS })
      );
    });
  }

  /** Delete the document; a missing file is a no-op. */
  async clear() {
    await this.#enqueue(async () => {
      await rm(this.#file, { force: true });
    });
  }

  /**
   * Remove this store's own temporary and quarantined siblings.
   *
   * A failure cleans up after itself, but a crash can leave a scan of the old
   * document behind; logout calls this so the credential directory does not
   * accumulate them. The live document, the cross-process lock and any
   * unrelated file are untouched.
   * @returns {Promise<string[]>} the removed entry names.
   */
  async pruneLeftovers() {
    const dir = dirname(this.#file);
    const base = basename(this.#file);
    /** @type {string[]} */
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return [];
      throw error;
    }
    const doomed = entries.filter((entry) => {
      if (entry === base) return false;
      if (entry === `${base}.corrupt`) return true;
      // `<file>.<random-hex|pid>.tmp` — this module's and the harness primitive's naming.
      return entry.startsWith(`${base}.`) && entry.endsWith('.tmp');
    });
    for (const entry of doomed) await rm(join(dir, entry), { force: true });
    return doomed;
  }

  /**
   * The harness primitives, resolved once; `null` when the host lacks them.
   * @returns {Promise<{ writeFileAtomic?: Function, withFileLock?: Function } | null>}
   */
  async #primitives() {
    if (this.#atomic === undefined) this.#atomic = await loadAtomicWrite();
    return this.#atomic;
  }

  /** @param {() => Promise<T>} task @template T */
  #enqueue(task) {
    const run = this.#queue.then(task, task);
    // Keep the chain alive after a rejection so later operations still run.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Read the document from disk. The file is the single source of truth: an
   * edit made outside this process (another profile, a hand edit, a restored
   * backup) is visible to the next read instead of being masked by a cache.
   * @returns {Promise<Record<string, unknown>>}
   */
  async #readUnlocked() {
    let text;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('state document is not an object');
      return parsed;
    } catch {
      await rename(this.#file, `${this.#file}.corrupt`).catch(() => undefined);
      return {};
    }
  }

  /**
   * Commit one document.
   * @param {Record<string, unknown>} document
   * @param {{ writeFileAtomic?: Function } | null} primitives
   */
  async #writeUnlocked(document, primitives) {
    const content = `${JSON.stringify(document, null, 2)}\n`;
    if (typeof primitives?.writeFileAtomic === 'function') {
      await primitives.writeFileAtomic(this.#file, content, { mode: 0o600, dirMode: 0o700 });
      return;
    }
    await this.#writeFallback(content);
  }

  /**
   * The local replacement for `writeFileAtomic`: a random-suffix sibling opened
   * with exclusive create (so a planted symlink is refused and a fresh inode
   * carries the mode), renamed over the target, removed again on any failure.
   * @param {string} content
   */
  async #writeFallback(content) {
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
