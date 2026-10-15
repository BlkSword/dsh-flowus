# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1

### Security

- **Raised the MCP client floor to `^2.2.0`** (`@modelcontextprotocol/client`,
  previously pinned to `2.0.0`). [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
  / CVE-2026-104850 (high, CVSS 7.5) covers `>=2.0.0 <2.2.0`: the OAuth client
  did not tie saved credentials to the authorization server they belong to, so a
  malicious or compromised MCP server could name its own authorization server
  and receive the stored `refresh_token` and `client_secret` with no user
  interaction. The client now records the authorization server as `issuer` on
  saved credentials and refuses to present them elsewhere (SEP-2352). No source
  change was needed for the upgrade: the offline suite and the live smoke tests
  pass unchanged against `2.3.1`.
- **The provider refuses cross-issuer credentials itself.** `tokens()` and
  `clientInformation()` now return nothing when the requested authorization
  server disagrees with the `issuer` recorded on the stored credential, so the
  binding holds even for a caller that drives the provider with an SDK version
  predating the fix. The user is asked to sign in again instead of leaking a
  refresh token to a different authorization server.

### Compatibility

- Unchanged: DSH `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`; the same peer
  ranges as `0.1.0`.

## 0.1.0

First public release.

### Added

- **Browser OAuth against the official FlowUs MCP server**
  (`https://mcp.flowus.cn/message`): RFC 9728 resource discovery, RFC 8414
  authorization-server metadata, RFC 7591 dynamic client registration and PKCE
  S256, with a one-shot loopback callback (`127.0.0.1:42813/callback`) and a
  `state` check on the redirect. No static token is ever requested or stored.
- **FlowUs tools as native agent tools**, named `mcp__flowus__<rawName>` exactly
  like the stock MCP bridge, with the server's JSON Schema lowered onto the
  harness parameter DSL and the canonical output contract enforced.
- **`/flowus` command**: `status`, `login`, `logout`, `tools`,
  `call <tool> [json]`, `reload`, `help`.
- **Settings → FlowUs page**: load/authorization/connection state, the
  credential-file path, scope, expiry and refresh-token facts, the published
  tools, and buttons for sign-in, cancel, reconnect, sign-out and refresh. The
  page is a build-free `window.__ModuleLoader__` bundle; it reads the host
  through `/flowus/api/*`, guarded by the composition's connection trust fence.
- **System-prompt section** carrying the server's instructions and the tool
  catalog, plus an explicit "not connected yet, run /flowus login" hint.
- **Private OAuth state file** at `<DSH_HOME>/flowus/oauth.json` with atomic,
  serialized writes; logout drops tokens while keeping the dynamic
  registration, which the rate-limited registration endpoint rewards.

### Fixed during pre-release verification against a live workspace

- **Tool calls are serialized per MCP session.** FlowUs answers a second
  in-flight call on one session with JSON-RPC `-32002` ("MCP session has too
  many concurrent tool calls"), so a parallel batch of read-only calls lost
  one. Calls now queue on one lane and a concurrency rejection additionally
  retries with bounded backoff (verified: 5 concurrent calls, 5/5 ok).

### Compatibility

- Supported DSH releases: `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-alpha.2`.
- Peer ranges match those runtimes: `@deepseek-ai/dsh-*` share one exact-version
  disjunction, while `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` carry
  `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1`.
