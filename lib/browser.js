/**
 * Open an authorization URL in the user's default browser.
 *
 * The harness ships no public host-side "open this URL" helper: its native
 * openers take filesystem paths (on Windows everything is routed through
 * `explorer.exe` with a `file://` URI, which would turn an `https:` URL into a
 * bogus path). This module therefore uses a shell-free `child_process` launch
 * with a per-platform candidate list — the URL always travels as one argv
 * element, so an `&` or a quote inside it can never be re-parsed as a command.
 *
 * Failure is reported, never thrown: `/flowus login` prints the URL when no
 * launcher can be started.
 *
 * @module dsh-flowus/browser
 */

import { spawn } from 'node:child_process';

/**
 * Ordered launcher candidates for one URL.
 * @param {string} url - absolute authorization URL.
 * @param {NodeJS.Platform} platform - `process.platform` (injectable for tests).
 * @returns {Array<{ command: string, args: string[] }>}
 */
export function browserCandidates(url, platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return [{ command: 'open', args: [url] }];
    case 'win32':
      return [
        // url.dll's protocol handler: one argv element, no shell.
        { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
        // Explorer hands an http(s) URL to the default browser.
        { command: 'explorer.exe', args: [url] },
        // Last resort: quoted so `cmd` cannot split the URL at `&`.
        { command: 'cmd', args: ['/c', 'start', '', `"${url}"`] },
      ];
    default:
      return [
        { command: 'xdg-open', args: [url] },
        { command: 'gio', args: ['open', url] },
      ];
  }
}

/**
 * Start one launcher and report whether it spawned.
 * @param {{ command: string, args: string[] }} candidate
 * @param {typeof spawn} spawnImpl
 * @returns {Promise<{ ok: true } | { ok: false, detail: string }>}
 */
function tryLaunch(candidate, spawnImpl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawnImpl(candidate.command, candidate.args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', (error) => done({ ok: false, detail: `${candidate.command}: ${error?.message ?? String(error)}` }));
      child.once('spawn', () => {
        child.unref?.();
        done({ ok: true });
      });
    } catch (error) {
      done({ ok: false, detail: `${candidate.command}: ${error?.message ?? String(error)}` });
    }
  });
}

/**
 * Launch the default browser for `url`, trying each candidate in order.
 * @param {string} url - absolute http(s) URL.
 * @param {{ platform?: NodeJS.Platform, spawnImpl?: typeof spawn }} [options]
 * @returns {Promise<{ opened: boolean, command?: string, detail?: string }>}
 */
export async function openInBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  let detail;
  for (const candidate of browserCandidates(url, platform)) {
    const result = await tryLaunch(candidate, spawnImpl);
    if (result.ok) return { opened: true, command: candidate.command };
    detail = detail ? `${detail}; ${result.detail}` : result.detail;
  }
  return { opened: false, detail: detail ?? 'no launcher available' };
}
