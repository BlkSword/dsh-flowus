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

- **A loopback callback request can no longer cancel a login.** The listener now
  validates the login attempt's `state` *before* it looks at `error` (constant
  time, exactly one value), accepts `GET` only, ignores a callback it cannot
  prove is its own instead of settling on it, and echoes server-supplied error
  text into the browser page escaped and truncated. Binding is restricted to a
  loopback host (RFC 8252 §7.3), and `callbackHost` is validated as such.
- **Stored credentials are bound to the resource they were issued for.** The
  resource URL recorded at authorization is compared with the configured
  `serverUrl` before any connection is opened; a mismatch refuses and asks for
  re-authorization rather than presenting the FlowUs bearer token to whatever
  endpoint the configuration now names. `sameResourceUrl` tolerates a path
  ancestor and a trailing slash, and never confuses a look-alike host or a
  sibling path.
- **The server does not get to size the system prompt.** Its instructions are
  bounded by `maxInstructionChars` (default 32,000, the same ceiling the stock
  MCP bridge applies at 32 KiB), truncating with a stated omission and a warning
  instead of letting a hostile or broken server exhaust the context window; the
  section that carries them now labels them as server-provided data.

### Added

- **A bound on what one result forwards.** `maxResultChars` (default 32,000)
  keeps the head and the tail of an oversized result and states exactly how much
  was dropped, so a reader can tell truncation from a short answer and ask for a
  narrower query; the structured-content projection is bounded the same way, and
  an oversized inline payload (a base64 image or blob) is replaced by its size in
  the stored raw blocks. `0` disables the bound.
- **Readable call cards.** Every published tool now supplies `presentCall`: the
  card kind separates searches and reads from the calls that change the
  workspace, and the title names the subject of the call instead of dumping its
  arguments.
- **`deferToolLoading` (off by default).** Publishes the tools with the
  harness's deferred-loading flag, which the DeepSeek route forwards as
  `defer_loading`; a route without tool-update support strips the flag and sends
  the full list, so enabling it can never be worse than the current behaviour.
  The measured catalogue payload it covers: 41 tools, 20,393 characters, about
  8,424 estimated tokens per request.

### Fixed

- **A lost MCP session heals itself.** The FlowUs server forgets a session it no
  longer holds and answers `-32001 Session not found`; the plugin now
  reconnects once, re-registers the tool list and replays the call (or the
  discovery request) in flight, instead of failing every tool until a human ran
  `/flowus reload`. Verified against the live server by poisoning a real session
  id: the call was replayed after a reconnect and returned real data.
- **`tools/list_changed` now re-registers the published generation.** The
  notification previously updated a cached list nothing read, while the README
  claimed a re-sync; the session now hands the refreshed list to the plugin,
  which replaces the generation through the same path as `/flowus reload`.

### Changed

- **Settings page.** The authorized-but-disconnected state explains the missing
  session instead of reusing the credential copy; the tool catalogue is
  searchable by name or description and labels each tool read-only or write; the
  credential path and the authorization URL have copy buttons; the last sync and
  a pending login show a relative time; the server version is displayed; a
  hidden tab stops polling and regaining focus refreshes immediately; the
  pending banner and the error line are announced through `aria-live`/`alert`.
  The host snapshot's tool entries now carry `readOnly`.

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
