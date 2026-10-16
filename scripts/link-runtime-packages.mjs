#!/usr/bin/env node
/**
 * Link the DSH packages this plugin peer-depends on into the checkout, so
 * `node --test` and `npm run typecheck` resolve the real harness
 * implementations.
 *
 * The published `latest` tag of `@deepseek-ai/dsh-tools` points at an unrelated
 * `0.0.1` line, so an implicit install is never the right answer: the harness
 * copy that matches the configured DSH release is.
 *
 * Usage:
 *   node scripts/link-runtime-packages.mjs                 # node_modules/@deepseek-ai/dsh
 *   node scripts/link-runtime-packages.mjs <runtime-dir>   # any installed DSH runtime
 *
 * ORDER MATTERS. Run this AFTER the last npm/pnpm command in a checkout: npm
 * treats the links as extraneous and removes them *through* the link, which
 * deletes the packages out of the runtime (that is how one DSH installation was
 * destroyed). `npm ci` deletes node_modules outright, so re-run this script
 * afterwards. Nothing here ever deletes a real directory: an existing package
 * that is not a link stops the run instead.
 */

import { mkdir, readdir, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const runtimeDir = resolve(projectRoot, process.argv[2] ?? join('node_modules', '@deepseek-ai', 'dsh'));
const linkRoot = join(projectRoot, 'node_modules', '@deepseek-ai');

/** @param {string} path */
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // A single junction for the whole scope (the layout an earlier README
  // described) already resolves every package. Per-package links are preferred
  // because npm deletes the links, not the packages they point at.
  if (await exists(linkRoot)) {
    const rootStat = await lstat(linkRoot);
    if (rootStat.isSymbolicLink()) {
      console.log(`${linkRoot} already links the whole @deepseek-ai scope; nothing to do`);
      return;
    }
  }

  const runtimeManifest = join(runtimeDir, 'package.json');
  if (!(await exists(runtimeManifest))) {
    throw new Error(`no DSH runtime at ${runtimeDir}; install one first (npm install --no-save @deepseek-ai/dsh@<release>)`);
  }
  const runtime = JSON.parse(await readFile(runtimeManifest, 'utf8'));

  // 0.2.0-rc.2 nests its dependencies under <dsh>/node_modules; the 0.2.1 alphas
  // hoist them next to the runtime package (README, "verifying on another runtime").
  const nested = join(runtimeDir, 'node_modules', '@deepseek-ai');
  const bundled = (await exists(nested)) ? nested : dirname(runtimeDir);
  const entries = (await readdir(bundled, { withFileTypes: true }))
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== 'dsh')
    .map((entry) => entry.name);

  if (entries.length === 0) throw new Error(`no @deepseek-ai packages found under ${bundled}`);

  await mkdir(linkRoot, { recursive: true });
  const linked = [];
  for (const name of entries) {
    const link = join(linkRoot, name);
    if (await exists(link)) {
      const current = await lstat(link);
      if (!current.isSymbolicLink()) {
        throw new Error(`${link} exists and is not a link; move it aside, then re-run (nothing was deleted)`);
      }
      await rm(link, { force: true });
    }
    await symlink(join(bundled, name), link, process.platform === 'win32' ? 'junction' : 'dir');
    linked.push(name);
  }

  console.log(`linked ${linked.length} packages from ${runtime.name}@${runtime.version} (${bundled})`);
  console.log('re-run this script after any npm/pnpm command in this checkout');
}

main().catch((error) => {
  console.error(`link-runtime-packages: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
