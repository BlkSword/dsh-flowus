# @blksword/dsh-flowus

Use FlowUs from DeepSeek Harness (DSH): **browser-based OAuth 2.1 sign-in (PKCE + dynamic client registration)** against the official FlowUs MCP server, FlowUs tools registered as native agent tools, a `/flowus` command for the human, and a **dedicated FlowUs page in the settings panel** for authorization and state.

- Server URL: `https://mcp.flowus.cn/message` (no token in the URL, ever)
- **No static token anywhere**: nothing to paste, no environment variable; the refresh token lives in a private state file and rotates automatically
- Tool names match the stock DSH MCP bridge: `mcp__flowus__<rawToolName>`

中文文档见 [README.zh-CN.md](./README.zh-CN.md)。

## Why this plugin exists

DSH ships `@deepseek-ai/dsh-mcp-client`, which supports `stdio` and `streamable-http` with static `headers` — but **not MCP OAuth**. FlowUs's official MCP endpoint uses OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE S256) and explicitly asks clients not to fall back to a static token. This plugin fills that gap: it runs the OAuth client itself inside the host process and bridges the discovered tools onto `ctx.tools`.

## Install

This release supports dsh 0.2.0-rc.2, dsh 0.2.1-alpha.1 and dsh 0.2.1-alpha.2, and nothing else — the plugin's peer range is exactly those three verified versions, and its compatibility records name them alone. 0.2.0-rc.2 is what `npm i -g @deepseek-ai/dsh@latest` and the official desktop build ship, so it is the version most users are on; 0.2.1-alpha.2 is the upstream alpha channel today, and 0.2.1-alpha.1 stays in the range because it was already verified, so a profile pinned to it keeps working:

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

Every `@deepseek-ai/dsh-*` package the plugin touches is declared as a Host peer, so the active dsh profile remains their owner — never add a separate dependency for one. The `@deepseek-ai/dsh-*` peers share one exact-version disjunction; `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` carry the paired ranges `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1` instead, because those are the versions each runtime ships alongside.

`dsh plugin add` installs the package, sees its `dsh.bundle.patch`, and **appends `@blksword/dsh-flowus` to `dsh.profile.bundles` automatically**. Then **restart `dsh web` and reload the browser page**: the client entry graph (`window.__DSH_BOOT__`) is composed at boot, and with the default `dsh-hmr` config (`root: []`) only explicit configuration watches are live, so adding a plugin does not hot-load into a running process. Afterwards type `/flowus status` in the GUI or open Settings → FlowUs.

**pnpm 11 holds back new releases.** Its `minimumReleaseAge` defaults to 1440 minutes, so a version published less than a day ago is skipped and `@latest` resolves to the previous release — silently, with a success exit code. To install a release from the last 24 hours, name it exactly:

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@0.1.0
```

The same applies to every profile you install into.

### Installing from a checkout instead of the registry

```powershell
# 1. Pack (from this package directory)
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"

# 2. Install (cwd is the profile directory, hence the relative spec)
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.0.tgz"
```

> **Windows note:** pnpm mis-resolves absolute `link:D:/...` / `file:D:/...` specs (it creates a junction to `...\profiles\web\D:\...`). Pack the tarball into the profile directory and use the relative `file:` spec above.

## Releasing (maintainers)

```powershell
npm login                      # once per machine; the scope @blksword must belong to the account
npm publish --access public    # prepublishOnly runs the offline suite first
npm view @blksword/dsh-flowus version

# End-to-end check of the published artifact:
dsh plugin --profile web remove @blksword/dsh-flowus
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` is the only supported install path: the loader resolves the package from the profile's `node_modules`, and the client half is served from the package's `exports["./client"]`.

## First sign-in

```
/flowus login
```

The plugin starts a one-shot loopback listener on `127.0.0.1:42813/callback`, opens your browser on the FlowUs authorization page (printing the URL when it cannot), validates the `state` on the redirect, exchanges the code with PKCE, then connects, discovers and registers the tools. Afterwards just ask the agent for FlowUs work in plain language.

## Commands

| Command | Effect |
| --- | --- |
| `/flowus` (`/flowus status`) | Authorization, connection, state-file path, registered tools |
| `/flowus login` | Browser authorization + tool sync |
| `/flowus logout` | Delete tokens (keeps the client registration to avoid the registration rate limit) |
| `/flowus tools` | List the tools visible to the model |
| `/flowus call <tool> [json]` | Call one tool directly, e.g. `/flowus call search_pages {"query":"weekly"}` |
| `/flowus reload` | Reconnect and re-sync the tool list |
| `/flowus help` | Usage |

## Settings page (Settings → FlowUs)

The plugin contributes one page to the settings panel through the `settings.section` slot (`id: flowus`):

- **Status badge** — not authorized / waiting for the browser / authorized but not connected / connected (with the tool count), rendered with `StateDot` and `Tag`.
- **Facts** — MCP endpoint, tool namespace, credential-file path, granted scope, expiry, whether a refresh token is stored, last sync time, last error.
- **Actions** — `Sign in with FlowUs` (or `Re-authorize`), `Cancel` while waiting, `Reconnect`, `Sign out`, `Refresh`.
- **Tools** — the `mcp__flowus__*` tools currently published to the model, with their one-line description.

The page reads `GET /flowus/api/status` and posts to `/flowus/api/login`, `/flowus/api/login-cancel`, `/flowus/api/logout` and `/flowus/api/reload`. Every response is the **same status snapshot** (`{ ok, snapshot }`), so one render path covers every action.

Those routes sit behind the same trust fence as every other DSH web surface (`ctx.connection.requestRejection`: Host/Origin check plus the login-token cookie) — an unauthenticated request gets 401 and can neither read state nor start a login.

Sign-in is start-then-poll: `POST /flowus/api/login` returns immediately and runs the browser flow in the background (bounded by `loginTimeoutMs`), while the page refreshes its status every 1.5 s. No HTTP request is held open for minutes.

## Configuration

Override as a profile patch layer (`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: flowus
  config:
    callbackPort: 42813
    toolCallTimeoutMs: 60000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `serverUrl` | `https://mcp.flowus.cn/message` | MCP resource URL |
| `serverName` | `flowus` | Tool namespace (`mcp__<serverName>__*`) |
| `scope` | `all` | Requested OAuth scope |
| `autoConnect` | `true` | Connect and publish tools at startup when a usable token exists |
| `failOnStartupError` | `false` | Reject plugin activation on initial failure |
| `statePath` | `''` → `<DSH_HOME>/flowus/oauth.json` | Private credential/registration file |
| `clientName` | `DeepSeek Harness` | `client_name` on the authorization page |
| `callbackHost` | `127.0.0.1` | Loopback host |
| `callbackPort` | `42813` | Loopback port (stable ⇒ one reusable registration) |
| `callbackPath` | `/callback` | Loopback path |
| `loginTimeoutMs` | `300000` | Browser wait budget for `/flowus login` |
| `openBrowser` | `true` | Launch the default browser automatically |
| `toolCallTimeoutMs` | `60000` | Per-call timeout |
| `maxTools` | `128` | Published-tool cap (`0` disables) |
| `promptSection` | `true` | Add FlowUs guidance + server instructions to the system prompt |

## Credentials and safety

- State file: `%DSH_HOME%\flowus\oauth.json` (default `C:\Users\<you>\.dsh\flowus\oauth.json`) — dynamic `client_id`, token set, PKCE verifier and discovery cache. Writes are atomic (temp file + rename) with `0600` where the platform honors it.
- **Public client**: `token_endpoint_auth_method: "none"` + PKCE S256, no client secret; the refresh token is the only long-lived credential.
- `logout` drops tokens and the verifier but **keeps the dynamic registration** — the registration endpoint is tightly rate-limited (observed `X-RateLimit-Limit: 3`), so reusing it keeps a later login from being throttled.
- Endpoints: `mcp.flowus.cn` (resource metadata + MCP data plane), `api.flowus.cn` (authorize / token / register).

## How it works

```
/flowus login
  ├─ loopback listener on 127.0.0.1:42813/callback (state generated first)
  ├─ auth(provider, {serverUrl, scope})
  │    ├─ RFC 9728 discovery, RFC 8414 metadata
  │    ├─ RFC 7591 dynamic registration when nothing is stored
  │    └─ PKCE(S256) URL → redirectToAuthorization → browser
  ├─ browser approval → redirect carries ?code&state (state mismatch is rejected)
  ├─ auth(provider, {serverUrl, authorizationCode, iss}) → token exchange → persisted
  └─ MCP initialize → tools/list → registered as mcp__flowus__* on ctx.tools
```

- A 401 at runtime makes the SDK refresh once and retry; a still-unauthorized call reports "run `/flowus login`" instead of a raw transport error.
- Tokens carry their issue time, so the plugin refreshes *before* connecting when the access token is already stale.
- `notifications/tools/list_changed` triggers a whole-generation re-sync; a failed sync keeps the previous generation.
- **One tool call at a time:** the FlowUs server allows a single in-flight call per MCP session (a second one gets JSON-RPC `-32002`). The session serializes calls and retries a concurrency rejection with bounded backoff, so the harness may schedule read-only tools in parallel without failures (measured: 5/5 concurrent calls succeeded).
- If another plugin already owns an `mcp__flowus__*` name, the sync is refused as a whole rather than partially published.

## Development and tests

```powershell
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @modelcontextprotocol/client@2.0.0
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai `
  -Target "$(Split-Path (Get-Command dsh).Source)\..\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

npm test                                                        # 109 offline tests
$env:DSH_FLOWUS_LIVE=1; node --test tests/flowus-live.test.js   # 3 live network smoke tests
```

Coverage: tool-naming contract, `/flowus` grammar, state store (atomicity/serialization/corruption), OAuth provider semantics and invalidation scopes, loopback callback validation (state/code/error/port fallback/abort), shell-free browser launch, MCP JSON Schema → DSH parameter DSL plus the output contract checked with DSH's own schema compiler, MCP result normalization with the concurrency lane that keeps the server's one-call-at-a-time rule, the settings-page host API (trust fence, method guard, envelope, error path), the browser bundle (registration contract, dictionary parity, `settings.section` registration, host-route path cross-check, view-model branches and one full render), a real cordis context load (registration, command surface, disposal), the **shipped** `ToolRuntime` / `CommandRuntime` / `SystemPrompt` services (the command really lands in the registry, the prompt section really survives assembly, a bridged tool really registers and runs the full execution pipeline including argument and output validation), and live discovery/PKCE/unauthorized-connect behaviour against FlowUs.

After editing the source, redistribute with `npm pack` + `dsh plugin --profile web add "file:./..."`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/flowus` is unknown | The plugin is not loaded: check `dsh.profile.bundles` contains `@blksword/dsh-flowus`, then **restart `dsh web`** |
| No FlowUs page in Settings | Same cause: the client entry graph is composed at boot — restart `dsh web` and reload the page |
| A button on the settings page answers 401 | Page requests need the login cookie: open the GUI from the `?token=...` URL that `dsh web` printed |
| Authorized but no tools | `/flowus reload`, then read the error line in `/flowus status` or on the settings page |
| Port 42813 busy | It falls back to an ephemeral port, which forces a fresh client registration; better: set a different fixed `callbackPort` |
| Registration throttled (`too_many_requests`) | Wait, then sign in again — the plugin reuses an existing registration |
| Browser did not open | The command output and the settings page both show the authorization URL; open it manually |
| Tool-name collision | Change `serverName` (e.g. `flowus2`) |

## Known limitations

- Image/audio content blocks are not rendered inline (placeholder text instead); FlowUs tools are text/JSON oriented.
- Tools that require the MCP task extension (`execution.taskSupport === "required"`) are skipped with a log line.
- MCP resources and prompts are not registered — this plugin's scope is tools, `/flowus` and the settings page.
- The settings page shows state and drives authorization/connection; it has no per-tool switches (visibility is bounded only by `maxTools` and the collision guard).
- The first authorization needs a human in a browser; that is OAuth, not a gap.

## Layout

```
dsh-flowus/
├─ cordis.patch.yml      # bundle layer: inserts the flowus plugin row + defaults
├─ package.json          # dsh.bundle.patch, dsh.client, peers, publish whitelist
├─ icon.svg
├─ locale/               # display name and summary for the Plugins list (en/zh)
│  ├─ en.json
│  └─ zh.json
├─ lib/
│  ├─ index.js           # plugin entry: Config, apply, tool publishing, /flowus, prompt section, page routes
│  ├─ http-api.js        # host JSON API for the settings page (/flowus/api/*, behind the trust fence)
│  ├─ client.js          # browser half: __ModuleLoader__ bundle registering Settings → FlowUs
│  ├─ login.js           # two-leg authorization-code orchestration
│  ├─ oauth-provider.js  # the SDK's OAuthClientProvider implementation
│  ├─ callback-server.js # one-shot loopback redirect receiver
│  ├─ browser.js         # shell-free browser launch with Windows fallbacks
│  ├─ mcp-session.js     # MCP session: connect, discover, call, normalize results
│  ├─ tool-bridge.js     # MCP JSON Schema → DSH defineTool definitions
│  ├─ tool-names.js      # mcp__<server>__<raw> naming contract
│  ├─ command-grammar.js # /flowus grammar
│  └─ store.js           # private state file (atomic, serialized)
└─ tests/                # offline unit tests + optional live smoke tests
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
