/**
 * Durable, private state file for the FlowUs OAuth client.
 *
 * One JSON document holds the dynamically registered client identity, the
 * PKCE code verifier of an in-flight authorization, and the current token set
 * (access token, refresh token, expiry). Writes are atomic (temp file +
 * rename) and serialized, so a refresh triggered while a login is in flight
 * can never interleave two read-modify-write cycles. The file is created with
 * mode 0600 where the platform honors it.
 *
 * @module dsh-flowus/store
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
   * @param {string} file absolute path of the state document.
   */
  constructor(file) {
    if (typeof file !== 'string' || file.trim().length === 0) throw new TypeError('state file path is required');
    this.#file = file;
  }

  /** @returns {string} the backing file path. */
  get file() {
    return this.#file;
  }

  /**
   * Read the current document.
   * @returns {Promise<Record<string, unknown>>} the stored object, or `{}`.
   */
  async read() {
    return this.#enqueue(async () => this.#readUnlocked());
  }

  /**
   * Apply one read-modify-write cycle.
   * @param {(draft: Record<string, unknown>) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>} mutate
   *   receives a deep copy of the current document; return the replacement, or
   *   `undefined` to leave the document untouched.
   * @returns {Promise<Record<string, unknown>>} the document after the cycle.
   */
  async mutate(mutate) {
    return this.#enqueue(async () => {
      const current = await this.#readUnlocked();
      const draft = structuredClone(current);
      const next = await mutate(draft);
      if (next === undefined) return current;
      await this.#writeUnlocked(next);
      return structuredClone(next);
    });
  }

  /** Delete the document; a missing file is a no-op. */
  async clear() {
    await this.#enqueue(async () => {
      await rm(this.#file, { force: true });
    });
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
      if (error && error.code === 'ENOENT') return {};
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

  async #writeUnlocked(document) {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, this.#file);
  }
}
