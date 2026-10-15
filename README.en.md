# @blksword/dsh-flowus

English | [中文](./README.md)

A FlowUs integration plugin for DeepSeek Harness (DSH). The plugin performs OAuth 2.1 authorization against the official FlowUs MCP server (`https://mcp.flowus.cn/message`) entirely within the host process — RFC 9728 metadata discovery, RFC 7591 dynamic client registration and PKCE S256 — registers the tools published by that server as native agent tools, and provides a `/flowus` command together with a settings-panel page. The authorization flow does not use a static token.

## Scope

- **Browser authorization.** An OAuth 2.1 authorization-code flow against the official FlowUs MCP server, with a loopback callback listener on `127.0.0.1`. Access and refresh tokens are stored in a plugin-private state file and renewed automatically.
- **Native tools.** Every tool published by the FlowUs MCP server is registered with the DSH tool registry under the same naming convention as the stock MCP bridge, namely `mcp__flowus__<tool>`.
- **`/flowus` command.** Status reporting, authorization, sign-out, tool listing, direct invocation, reconnection and help.
- **Settings page.** A dedicated FlowUs page in the settings panel that reports authorization and connection state and performs authorization, reconnection and sign-out operations.
- **System-prompt section.** The server instructions and the current tool catalogue are contributed to the system prompt, with explicit guidance when the workspace is not yet authorized.

## Background

The DSH package `@deepseek-ai/dsh-mcp-client` supports `stdio` and `streamable-http` with static request headers, but not MCP OAuth. The official FlowUs MCP server uses OAuth 2.1 and requires a client that cannot complete the authorization flow to report that condition rather than fall back to a static token. This plugin implements the OAuth client flow and bridges the discovered tools onto `ctx.tools`.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `0.2.0-rc.2`, `0.2.1-alpha.1` or `0.2.1-alpha.2` (see Compatibility) |
| Node.js | `>= 22` |

## Installation

### From npm

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` performs the following steps:

1. installs the package through pnpm;
2. reads the `dsh.bundle.patch` declaration in the package and appends `@blksword/dsh-flowus` to `dsh.profile.bundles`, so no manual edit of `package.json` is required;
3. resolves the `@deepseek-ai/*` implementations provided by the DSH installation through peer dependencies.

pnpm 11 applies `minimumReleaseAge`, which defaults to 1440 minutes: a version published less than 24 hours ago is skipped when `@latest` is resolved, the resolution falls back to the previous version, and the exit code still reports success. To install a recent release, name the exact version:

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@0.1.1
```

### From GitHub

The repository is public, so the same package can be installed without a registry:

```powershell
dsh plugin --profile web add github:BlkSword/dsh-flowus
```

This path has been verified end to end: pnpm resolves the git dependency, the bundle entry is written to `dsh.profile.bundles`, and the loader composes and imports the plugin row (`dsh --profile <name> --dump-config` and `--dump-config-schema` both succeed). For a reproducible installation, pin a commit with `github:BlkSword/dsh-flowus#<commit-sha>`; subsequent updates are retrieved with `dsh plugin --profile web update @blksword/dsh-flowus`.

### From a local checkout

```powershell
# 1. Pack into the profile directory
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"

# 2. Install from the profile directory (relative specifier)
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.1.tgz"
```

> Windows note: pnpm interprets absolute `link:D:/...` and `file:D:/...` specifiers as relative paths and creates an invalid link pointing at `...\profiles\web\D:\...`. Pack the tarball into the profile directory first, then use the relative `file:` specifier shown above.

### After installation

Restart `dsh web` and reload the browser page. The client entry graph (`window.__DSH_BOOT__`) is composed at process start, and with the default `dsh-hmr` configuration (`root: []`) only explicit configuration watches remain active, so a newly added plugin is not hot-loaded into a running process. Confirm the result with `/flowus status` or through Settings → FlowUs.

## Compatibility

This release supports DSH `0.2.0-rc.2`, `0.2.1-alpha.1` and `0.2.1-alpha.2`, and no other versions. The peer dependencies and the compatibility record name exactly those three releases.

| DSH release | `@deepseek-ai/cordis` | `@deepseek-ai/schemastery` |
| --- | --- | --- |
| `0.2.0-rc.2` | `~4.0.4` | `~3.18.4` |
| `0.2.1-alpha.1` | `~4.0.5-alpha.1` | `~3.18.5-alpha.1` |
| `0.2.1-alpha.2` | `~4.0.5-alpha.1` | `~3.18.5-alpha.1` |

The `@deepseek-ai/dsh-*` peer dependencies use one exact-version disjunction, `0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2`, while `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` use the paired ranges `~4.0.4 || ~4.0.5-alpha.1` and `~3.18.4 || ~3.18.5-alpha.1`. Every `@deepseek-ai/*` package is provided by the active dsh profile and must not be added as a separate dependency.

The matrix above was established by measurement: the offline suite and the live smoke tests were executed against the packages shipped by each of the three runtimes, with no failures, and the named-export sets used by the plugin are identical across all three. The alpha range clauses are required rather than cosmetic: a prerelease version satisfies a range only when a comparator carries a prerelease identifier on the same `major.minor.patch`, so `~4.0.4` does not accept `4.0.5-alpha.1`, and `0.2.0-rc.2` does not accept `0.2.1-alpha.1`.

## First authorization

```
/flowus login
```

1. The plugin opens a one-shot callback listener on `127.0.0.1:42813/callback`.
2. The default browser is opened on the FlowUs authorization page. If it cannot be opened automatically, the full authorization URL is printed by the command and shown on the settings page.
3. After the user approves the request, the browser is redirected to the callback address.
4. The plugin exchanges the authorization code together with the PKCE verifier for a token set, then connects to the MCP server, discovers the tools and registers them.
5. The command reports the number of registered tools.

Once authorization has completed, FlowUs tasks can be requested from the agent in plain language.

## Commands

| Command | Effect |
| --- | --- |
| `/flowus` or `/flowus status` | Authorization state, connection state, credential-file path and the registered tool list |
| `/flowus login` | Browser authorization followed by a tool synchronization |
| `/flowus logout` | Deletes the tokens while keeping the dynamic client registration, which avoids the registration rate limit |
| `/flowus tools` | Lists the FlowUs tools registered for the model |
| `/flowus call <tool> [json]` | Invokes one tool directly, for example `/flowus call search_pages {"query":"weekly report"}` |
| `/flowus reload` | Reconnects and re-synchronizes the tool list |
| `/flowus help` | Usage |

## Settings page

The plugin contributes a dedicated page to the settings panel through the `settings.section` slot (`id: flowus`). The page reports state and performs the authorization-related operations:

- **State indicator.** Not authorized, waiting for the browser, authorized but not connected, or connected (with the tool count), rendered with `StateDot` and `Tag`.
- **State details.** MCP endpoint, tool namespace, credential-file path, granted scope, token expiry, whether a refresh token is stored, last synchronization time and the most recent error.
- **Actions.** Sign in (when unauthorized), re-authorize (when authorized), cancel (while an authorization is in progress), reconnect, sign out and refresh.
- **Tool list.** The `mcp__flowus__*` tools currently registered for the model, with their short descriptions.

Page data is read from the host route `GET /flowus/api/status`; the buttons post to `/flowus/api/login`, `/flowus/api/login-cancel`, `/flowus/api/logout` and `/flowus/api/reload` respectively. Every response carries the same status snapshot (`{ ok, snapshot }`), so a single rendering path covers all operations.

These routes behave like every other DSH web surface: each request first passes the connection service's trust fence (Host/Origin validation and the login-token cookie). An unauthenticated request receives 401 and can neither read state nor start an authorization.

Authorization uses a start-then-poll pattern: `POST /flowus/api/login` returns immediately while the browser flow runs in the background, bounded by `loginTimeoutMs`; the page refreshes its status every 1.5 seconds while waiting, so no HTTP request is held open for an extended period.

## Configuration

Configuration is supplied by a profile patch layer (`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- id: flowus
  config:
    callbackPort: 42813
    toolCallTimeoutMs: 60000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `serverUrl` | `https://mcp.flowus.cn/message` | FlowUs MCP resource URL |
| `serverName` | `flowus` | Tool namespace (`mcp__<serverName>__*`) |
| `scope` | `all` | Requested OAuth scope (FlowUs publishes `all`) |
| `autoConnect` | `true` | Connect and publish tools at startup when a usable token exists |
| `failOnStartupError` | `false` | Whether a failed initial connection or tool synchronization fails plugin activation |
| `statePath` | empty → `<DSH_HOME>/flowus/oauth.json` | Credential and registration state file |
| `clientName` | `DeepSeek Harness` | Client name shown on the authorization page |
| `callbackHost` | `127.0.0.1` | Callback listener host |
| `callbackPort` | `42813` | Callback port; a fixed port allows one client registration to be reused |
| `callbackPath` | `/callback` | Callback path |
| `loginTimeoutMs` | `300000` | Upper bound for waiting on the browser |
| `openBrowser` | `true` | Whether to open the default browser automatically |
| `toolCallTimeoutMs` | `60000` | Timeout for a single tool call |
| `maxTools` | `128` | Upper bound on published tools (`0` disables the bound) |
| `promptSection` | `true` | Whether to contribute the FlowUs guidance and server instructions to the system prompt |

## Credentials and security

- The state file is located at `%DSH_HOME%\flowus\oauth.json` (by default `C:\Users\<user>\.dsh\flowus\oauth.json`) and contains the dynamically registered `client_id`, the token set, the PKCE verifier and the discovery cache. Writes use atomic replacement (temporary file followed by rename) and set permissions to `0600` where the platform supports it.
- The client is a public client: `token_endpoint_auth_method = "none"` together with PKCE S256, and no client secret exists. The refresh token is the only long-lived credential.
- `logout` removes the tokens and the verifier while retaining the dynamic client registration. The registration endpoint is rate-limited (an observed `X-RateLimit-Limit` of 3), so reusing the registration avoids throttling on subsequent sign-ins.
- Network endpoints in use: `mcp.flowus.cn` (resource metadata and the MCP data plane) and `api.flowus.cn` (authorization, token and registration).
- To revoke access, revoke the application authorization on the FlowUs side and then run `/flowus logout` locally.

## Implementation

```
/flowus login
  ├─ open a one-shot listener on 127.0.0.1:42813/callback (state generated first)
  ├─ auth(provider, { serverUrl, scope })          ← driven by the MCP SDK
  │    ├─ RFC 9728 discovery  /.well-known/oauth-protected-resource
  │    ├─ RFC 8414 discovery  /.well-known/oauth-authorization-server
  │    ├─ RFC 7591 dynamic client registration when nothing is stored
  │    │  (loopback redirect, native application type)
  │    └─ build the PKCE(S256) authorization URL → redirectToAuthorization → browser
  ├─ browser approval → redirect carries ?code&state (a state mismatch is rejected)
  ├─ auth(provider, { serverUrl, authorizationCode, iss })
  │    └─ exchange for the token set (access + refresh) and persist it
  └─ MCP initialize → tools/list → register each tool with DSH (mcp__flowus__*)
```

- **Token renewal.** On a runtime 401 the SDK refreshes the token with the stored refresh token and retries once; if the retry still fails, the plugin reports an explicit "re-authorization required" error. The plugin records the acquisition time and lifetime of the token set and refreshes before connecting when the access token is already stale, so the first request does not have to fail with 401.
- **Tool-list changes.** `notifications/tools/list_changed` triggers a re-synchronization. Synchronization replaces the whole generation, and a failed synchronization keeps the previous generation in place.
- **Serialized invocation.** The FlowUs server permits only one in-flight tool call per MCP session; a concurrent call is answered with JSON-RPC `-32002`. The plugin therefore executes calls through a single serial queue and additionally retries a concurrency rejection with bounded backoff, so parallel read-only scheduling by the model does not fail (measured: five concurrent calls, all successful).
- **Naming conflicts.** If an `mcp__flowus__*` name is already owned by another plugin, the entire synchronization is refused and no partial generation is published.
- **Settings page.** The host half registers `/flowus/api/*` through `ctx.webServer.register`; the client half is a `window.__ModuleLoader__` classic script (`lib/client.js`, with no build step) registered into the `settings.section` slot. The two halves communicate through `fetch` and JSON snapshots; no custom RPC protocol is introduced.

## Development and testing

Local development requires the following two prerequisites (`node_modules` is not tracked):

```powershell
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @modelcontextprotocol/client@^2.2.0
# Let node --test load the real dsh-tools / schemastery: point the junction at the DSH installation
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai `
  -Target "$(Split-Path (Get-Command dsh).Source)\..\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

npm test                                            # offline suite: 115 tests, 112 passed, 3 live tests skipped
$env:DSH_FLOWUS_LIVE=1; node --test tests/flowus-live.test.js   # live smoke tests: 3
```

> **The order matters.** Run `npm install` first and create the junction afterwards: npm treats the `@deepseek-ai/*` packages inside the junction as extraneous and unlinks them out of the DSH installation. To update dependencies while the junction exists, detach it first with `cmd /c rmdir node_modules\@deepseek-ai` and recreate it afterwards.

Test coverage:

| File | Coverage |
| --- | --- |
| `tests/tool-names.test.js` | Tool-naming contract (identical to the stock MCP bridge) |
| `tests/command-grammar.test.js` | `/flowus` grammar |
| `tests/store.test.js` | Atomic writes, serialization and corruption handling for the state file |
| `tests/oauth-provider.test.js` | `OAuthClientProvider` semantics, the issuer binding (a credential is never presented to another authorization server) and state invalidation scopes |
| `tests/callback-server.test.js` | Callback validation (state, code, error, port fallback, abort) |
| `tests/browser.test.js` | Shell-free browser launch and candidate fallback |
| `tests/tool-bridge.test.js` | MCP JSON Schema to DSH parameter DSL, plus the output contract checked with DSH's own schema compiler |
| `tests/http-api.test.js` | Settings-page host API: trust fence, method guard, `{ ok, snapshot }` envelope, error path |
| `tests/client-bundle.test.js` | Browser half: `__ModuleLoader__` registration contract, dictionary key parity, slot registration, host-route path cross-check, view-model branches and one full render |
| `tests/mcp-session.test.js` | Result normalization, concurrency-rejection detection, the serial queue (ordering, concurrency bound, failure isolation) and authorization-error classification |
| `tests/plugin-apply.test.js` | Activation in a real cordis context, the command surface and disposal |
| `tests/plugin-real-services.test.js` | Activation against the shipped `ToolRuntime`, `CommandRuntime` and `SystemPrompt`: command registration, prompt-section assembly, tool registration and the full execution pipeline (argument validation, output contract, error path) |
| `tests/flowus-live.test.js` | Metadata discovery against the live endpoint, the PKCE authorization URL and the error mapping for an unauthorized connection |

Distribution from a modified checkout:

```powershell
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.1.tgz"
```

Formal publication is described under Releasing.

### Verifying against another runtime

The suite resolves `@deepseek-ai/*` through the `node_modules\@deepseek-ai` junction. To verify a different runtime, point that junction at the target release's package directory and re-run `node --test` and the live smoke tests from a copy of the repository. Two differences between releases are relevant:

- **Dependency layout.** `0.2.0-rc.2` nests its dependencies under `<dsh>\node_modules\@deepseek-ai\...`, whereas `0.2.1-alpha.1` and `0.2.1-alpha.2` hoist them to `<runtime>\node_modules\@deepseek-ai\...`, with no nested directory. Tooling that assumes the rc.2 layout requires a fallback.
- **`./invariant` subpaths were removed.** `@deepseek-ai/dsh-tools/invariant`, `dsh-commands/invariant` and `dsh-system-prompt/invariant` (and their `lib/invariant.js` files) exist in `0.2.0-rc.2` and were removed in `0.2.1-alpha.1`. This plugin imports package roots only; such deep imports must not be added.

## Releasing

```powershell
npm login                      # once per machine; the @blksword scope must belong to the account
npm publish --access public    # prepublishOnly runs the offline suite first
npm view @blksword/dsh-flowus version

# End-to-end check of the published artifact
dsh plugin --profile web remove @blksword/dsh-flowus
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` is the only supported installation path: the loader resolves the package from the profile's `node_modules`, and the client half is served from the package's `exports["./client"]`.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| The `/flowus` command is unknown | The plugin is not loaded. Verify that `dsh.profile.bundles` contains `@blksword/dsh-flowus`, then restart `dsh web` |
| No FlowUs page in the settings panel | Same cause: the client entry graph is composed at process start. Restart `dsh web` and reload the browser page |
| A settings-page action returns 401 | Page requests require the login cookie. Open the GUI from the `?token=` URL printed by `dsh web` |
| No tools after authorization | Run `/flowus reload`, then inspect the error line in `/flowus status` or on the settings page |
| Port 42813 is in use | The plugin falls back to an ephemeral port, which requires a new client registration and may reach the registration rate limit. Configure a different fixed `callbackPort` |
| Registration throttled (`too_many_requests`) | Retry the authorization later. The plugin reuses an existing registration, so registration is normally required only once |
| The browser did not open | The authorization URL is printed by the command and displayed on the settings page and can be opened manually |
| Tool-name conflict | Change `serverName` (for example to `flowus2`); the tool namespace changes accordingly |

## Known limitations

- Image and audio content blocks are not rendered inline; they are presented as placeholder text. FlowUs tools are predominantly text- and JSON-oriented.
- The MCP task extension is not supported: tools declaring `execution.taskSupport === "required"` are skipped and the reason is logged.
- MCP resources and prompts are not registered; the scope of this plugin is tools, the command and the settings page.
- The settings page provides state reporting and authorization/connection operations only. There is no per-tool enable switch; tool visibility is currently bounded only by `maxTools` and the naming-conflict guard.
- The first authorization must be confirmed by a user in a browser, which is inherent to the OAuth authorization-code flow.

## Repository layout

```
dsh-flowus/
├─ cordis.patch.yml      # bundle layer: inserts the flowus plugin row and defaults
├─ package.json          # dsh.bundle.patch, dsh.client, peer dependencies, publish whitelist
├─ icon.svg
├─ locale/               # display name and summary for the plugin list (en/zh)
│  ├─ en.json
│  └─ zh.json
├─ lib/
│  ├─ index.js           # plugin entry: Config, apply, tool publishing, /flowus, prompt section, page routes
│  ├─ http-api.js        # settings-page host JSON API (/flowus/api/*, behind the connection trust fence)
│  ├─ client.js          # browser half: __ModuleLoader__ bundle registering the settings page
│  ├─ login.js           # two-leg authorization-code orchestration
│  ├─ oauth-provider.js  # the SDK's OAuthClientProvider implementation, token summary and expiry checks
│  ├─ callback-server.js # one-shot loopback redirect receiver
│  ├─ browser.js         # shell-free browser launch with Windows candidate fallback
│  ├─ mcp-session.js     # MCP session: connect, discover, call and normalize results
│  ├─ tool-bridge.js     # MCP JSON Schema to DSH defineTool conversions
│  ├─ tool-names.js      # mcp__<server>__<raw> naming contract
│  ├─ command-grammar.js # /flowus grammar
│  └─ store.js           # private state file (atomic, serialized)
└─ tests/                # offline tests and optional live smoke tests
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
