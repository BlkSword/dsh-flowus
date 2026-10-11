# @mars-sea/dsh-flowus

Use FlowUs from DeepSeek Harness (DSH): **browser-based OAuth 2.1 sign-in (PKCE + dynamic client registration)** against the official FlowUs MCP server, FlowUs tools registered as native agent tools, and a `/flowus` command for the human.

- Server URL: `https://mcp.flowus.cn/message` (no token in the URL, ever)
- **No static token anywhere**: nothing to paste, no environment variable; the refresh token lives in a private state file and rotates automatically
- Tool names match the stock DSH MCP bridge: `mcp__flowus__<rawToolName>`

中文文档见 [README.zh-CN.md](./README.zh-CN.md)。

## Why this plugin exists

DSH ships `@deepseek-ai/dsh-mcp-client`, which supports `stdio` and `streamable-http` with static `headers` — but **not MCP OAuth**. FlowUs's official MCP endpoint uses OAuth 2.1 (RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE S256) and explicitly asks clients not to fall back to a static token. This plugin fills that gap: it runs the OAuth client itself inside the host process and bridges the discovered tools onto `ctx.tools`.

## Install

```powershell
# 1. Pack (from this package directory)
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"

# 2. Install (cwd is the profile directory, hence the relative spec)
dsh plugin --profile web add "file:./mars-sea-dsh-flowus-0.1.0.tgz"
```

`dsh plugin add` installs the package, sees its `dsh.bundle.patch`, and **appends `@mars-sea/dsh-flowus` to `dsh.profile.bundles` automatically**. Reload the profile (automatic with `dsh-hmr`, otherwise restart), then type `/flowus status` in the GUI.

> **Windows note:** pnpm mis-resolves absolute `link:D:/...` / `file:D:/...` specs (it creates a junction to `...\profiles\web\D:\...`). Use the tarball + relative-path route above.

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
- If another plugin already owns an `mcp__flowus__*` name, the sync is refused as a whole rather than partially published.

## Development and tests

```powershell
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @modelcontextprotocol/client@2.0.0
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai `
  -Target "$(Split-Path (Get-Command dsh).Source)\..\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

npm test                                                        # 80 offline tests
$env:DSH_FLOWUS_LIVE=1; node --test tests/flowus-live.test.js   # 3 live network smoke tests
```

Coverage: tool-naming contract, `/flowus` grammar, state store (atomicity/serialization/corruption), OAuth provider semantics and invalidation scopes, loopback callback validation (state/code/error/port fallback/abort), shell-free browser launch, MCP JSON Schema → DSH parameter DSL plus the output contract checked with DSH's own schema compiler, a real cordis context load (registration, command surface, disposal), the **shipped** `ToolRuntime` / `CommandRuntime` / `SystemPrompt` services (the command really lands in the registry, the prompt section really survives assembly, a bridged tool really registers and runs the full execution pipeline including argument and output validation), and live discovery/PKCE/unauthorized-connect behaviour against FlowUs.

After editing the source, redistribute with `npm pack` + `dsh plugin --profile web add "file:./..."`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/flowus` is unknown | The plugin is not loaded: check `dsh.profile.bundles` contains `@mars-sea/dsh-flowus`, then reload/restart |
| Authorized but no tools | `/flowus reload`, then read the error line in `/flowus status` |
| Port 42813 busy | It falls back to an ephemeral port, which forces a fresh client registration; better: set a different fixed `callbackPort` |
| Registration throttled (`too_many_requests`) | Wait, then `/flowus login` again — the plugin reuses an existing registration |
| Browser did not open | The command prints the authorization URL; open it manually |
| Tool-name collision | Change `serverName` (e.g. `flowus2`) |

## Known limitations

- Image/audio content blocks are not rendered inline (placeholder text instead); FlowUs tools are text/JSON oriented.
- Tools that require the MCP task extension (`execution.taskSupport === "required"`) are skipped with a log line.
- MCP resources and prompts are not registered — this plugin's scope is tools plus `/flowus`.
- No client-side UI panel (unlike the commandcode provider's settings page): everything is in the `/flowus` command.
- The first authorization needs a human in a browser; that is OAuth, not a gap.

## Layout

```
dsh-flowus/
├─ cordis.patch.yml      # bundle layer: inserts the flowus plugin row + defaults
├─ package.json          # dsh.bundle.patch, peers, publish whitelist
├─ lib/
│  ├─ index.js           # plugin entry: Config, apply, tool publishing, /flowus, prompt section
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
