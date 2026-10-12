# @blksword/dsh-flowus

在 DeepSeek Harness（DSH）里使用 FlowUs 的官方 MCP 服务器：**浏览器一键授权（OAuth 2.1 + PKCE + 动态客户端注册）**，把 FlowUs 的工具注册成 Agent 原生工具，提供 `/flowus` 斜杠命令，并在**设置面板里有一个独立的 FlowUs 页面**用来查看状态与完成授权。

- 服务器地址：`https://mcp.flowus.cn/message`（官方 MCP 端点，无需在 URL 里放 token）
- 全程**没有静态 token**：不改配置、不粘贴密钥，refresh token 由插件私有保存并自动续期
- 工具命名与 DSH 自带 MCP 桥一致：`mcp__flowus__<原始工具名>`

---

## 为什么需要这个插件

DSH 自带的 `@deepseek-ai/dsh-mcp-client` 只支持 `stdio` 与 `streamable-http + headers` 两种接入方式，**不支持 MCP OAuth**。而 FlowUs 官方 MCP 使用 OAuth 2.1（RFC 9728 发现 + RFC 7591 动态注册 + PKCE S256），官方也明确要求不要退回静态 token。本插件补上了这一段：自己在宿主进程里完成 OAuth 客户端流程，再把远端工具桥接进 `ctx.tools`。

## 安装

本版本支持 dsh 0.2.0-rc.2、dsh 0.2.1-alpha.1 与 dsh 0.2.1-alpha.2，不支持其它版本——peer 范围就是这三个已验证版本，兼容性记录也只写这三个。0.2.0-rc.2 是 `npm i -g @deepseek-ai/dsh@latest` 与官方桌面版当前发布的版本，多数用户在它上面；0.2.1-alpha.2 是上游 alpha 通道的当前版本；0.2.1-alpha.1 因为在范围内且已验证过，所以固定在它的 profile 不会被拦：

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

插件用到的每个 `@deepseek-ai/dsh-*` 包都声明为 Host peer，**由当前 dsh profile 作为唯一持有者**——不要为它们再单独加依赖。`@deepseek-ai/dsh-*` 共用一个精确版本析取；`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 用成对范围 `~4.0.4 || ~4.0.5-alpha.1`、`~3.18.4 || ~3.18.5-alpha.1`，因为这两个版本分别与对应运行时一起发布。

这份矩阵是**实测**出来的，不是猜的：离线套件（109 项）与联网冒烟（3 项）分别在三个运行时自带的包上跑过——0.2.0-rc.2、0.2.1-alpha.1、0.2.1-alpha.2——**零失败**，且插件用到的具名导出集合在三者间逐个一致。alpha 的 OR 分支是必需的、不是装饰：prerelease 只有在比较符于同一 `major.minor.patch` 上带 prerelease 时才满足范围，所以单写 `~4.0.4` 不接受 `4.0.5-alpha.1`，单写 `0.2.0-rc.2` 也不接受 `0.2.1-alpha.1`。

`dsh plugin add` 会：

1. 通过 pnpm 安装该包；
2. 发现它声明了 `dsh.bundle.patch`，于是**自动把 `@blksword/dsh-flowus` 追加到 `dsh.profile.bundles`**（无需手改 `package.json`）；
3. 通过 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 等 peer 依赖解析到 DSH 安装内的实现。

装好后**重启 `dsh web` 并刷新浏览器页面**：客户端半的入口图（`window.__DSH_BOOT__`）在启动时组装，默认配置下 `dsh-hmr` 的 `root: []` 只保留显式配置监视点，所以「新增一个插件」一般不会热加载进正在运行的进程。重启后在 GUI 输入 `/flowus status`，或打开「设置 → FlowUs」确认。

**pnpm 11 会压住新版本**：它的 `minimumReleaseAge` 默认 1440 分钟，发布不足一天的版本会被跳过，`@latest` 静默解析到上一个版本（退出码还是成功）。要装最近 24 小时内发布的版本，就写确切版本号：

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@0.1.0
```

装进任何 profile 都是同样的规则。

### 不用 registry，从本地检出安装

```powershell
# 1. 打包（在插件目录里执行；<profileDir> 例如 C:\Users\<你>\.dsh\profiles\web）
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"

# 2. 安装（cwd 是 profile 目录，所以用相对路径）
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.0.tgz"
```

> **Windows 提示**：pnpm 会把 `link:D:/...`、`file:D:/...` 这类绝对路径当成相对路径（生成指向 `...\profiles\web\D:\...` 的坏链接）。所以把 tarball 打到 profile 目录里，再用上面的相对路径 `file:` 安装。

## 发布（维护者）

```powershell
npm login                      # 每台机器一次；@blksword 这个 scope 必须属于该账号
npm publish --access public    # prepublishOnly 会先跑一遍离线测试
npm view @blksword/dsh-flowus version

# 对发布产物做一次端到端校验：
dsh plugin --profile web remove @blksword/dsh-flowus
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` 是唯一受支持的安装路径：加载器从 profile 的 `node_modules` 解析该包，客户端半则由包内 `exports["./client"]` 提供。

## 首次授权

```
/flowus login
```

1. 插件在本机 `127.0.0.1:42813/callback` 起一个一次性回调监听；
2. 自动打开浏览器到 FlowUs 授权页（未自动打开时会打印完整授权 URL）；
3. 你在 FlowUs 页面确认授权后，浏览器回到回调地址；
4. 插件用授权码 + PKCE 换取 token，随后连接 MCP、发现工具并注册；
5. 命令返回已注册的工具数量。之后直接对 Agent 说「把 FlowUs 里最近的会议记录整理成周报」之类即可。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/flowus` 或 `/flowus status` | 授权状态、连接状态、凭据文件位置、已注册工具列表 |
| `/flowus login` | 打开浏览器完成授权，并同步工具 |
| `/flowus logout` | 删除 token（保留已注册的客户端，避免再次注册触发限流） |
| `/flowus tools` | 列出已注册到模型侧的 FlowUs 工具 |
| `/flowus call <工具> [JSON]` | 直接调用某个工具，例如 `/flowus call search_pages {"query":"周报"}` |
| `/flowus reload` | 重连并重新同步工具列表 |
| `/flowus help` | 用法 |

## 设置页（设置 → FlowUs）

插件用 `settings.section` 槽位（`id: flowus`）向设置面板贡献一个独立页面，专门用于查看与操作本插件：

- **状态徽标**：未授权 / 等待浏览器授权 / 已授权未连接 / 已连接（含工具数），并用 `StateDot` 与 `Tag` 呈现（ongoing / warning / done）。
- **事实行**：MCP 地址、工具命名空间、凭据文件路径、授权 scope、过期时间、是否含 refresh token、上次同步时间、最近错误。
- **操作**：`登录 FlowUs`（未授权时）/ `重新授权`（已授权时）、`取消`（登录中）、`重新连接`、`退出登录`、`刷新`。
- **工具列表**：当前注册给模型的 `mcp__flowus__*` 工具及其一句话说明。

页面数据来自宿主路由 `GET /flowus/api/status`；按钮分别 POST 到 `/flowus/api/login`、`/flowus/api/login-cancel`、`/flowus/api/logout`、`/flowus/api/reload`。所有响应都是**同一份状态快照**（`{ ok, snapshot }`），所以一个渲染路径覆盖所有操作。

这些路由和 DSH 其它 Web 接口一样，先经过连接服务的信任栅栏（Host/Origin 校验 + 登录令牌 Cookie）：未认证请求直接 401，不会被读取状态或触发登录。

登录采用「先返回、再轮询」：`POST /flowus/api/login` 立刻返回并在后台跑浏览器授权（上限 `loginTimeoutMs`），页面在等待期间每 1.5 秒刷新一次状态，因此不会把 HTTP 请求挂住几分钟。

## 配置

作为 profile 补丁层覆盖（`$DSH_HOME/profiles/web/cordis.patch.yml`），例如：

```yaml
- id: flowus
  config:
    callbackPort: 42813
    toolCallTimeoutMs: 60000
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `serverUrl` | `https://mcp.flowus.cn/message` | FlowUs MCP 资源地址 |
| `serverName` | `flowus` | 工具命名空间（`mcp__<serverName>__*`） |
| `scope` | `all` | 请求的 OAuth scope（FlowUs 公布 `all`） |
| `autoConnect` | `true` | 启动时若已有可用 token 就连接并发布工具 |
| `failOnStartupError` | `false` | 初始连接失败时是否让插件激活失败 |
| `statePath` | 空 → `<DSH_HOME>/flowus/oauth.json` | 凭据/注册信息文件 |
| `clientName` | `DeepSeek Harness` | 授权页显示的客户端名 |
| `callbackHost` | `127.0.0.1` | 回调监听地址 |
| `callbackPort` | `42813` | 回调端口（固定端口可复用同一次客户端注册） |
| `callbackPath` | `/callback` | 回调路径 |
| `loginTimeoutMs` | `300000` | `/flowus login` 等待浏览器的上限 |
| `openBrowser` | `true` | 是否自动打开浏览器 |
| `toolCallTimeoutMs` | `60000` | 单次工具调用超时 |
| `maxTools` | `128` | 最多发布多少个工具（`0` 不限制） |
| `promptSection` | `true` | 是否向系统提示词加入 FlowUs 说明与服务器 instructions |

## 凭据与安全

- 凭据文件：`%DSH_HOME%\flowus\oauth.json`（默认 `C:\Users\<你>\.dsh\flowus\oauth.json`），内容为动态注册的 `client_id`、token 集合、PKCE verifier 与 discovery 缓存；写入用「临时文件 + rename」原子替换，权限尽力设为 `0600`。
- **public client**：`token_endpoint_auth_method = "none"` + PKCE S256，没有 client secret；refresh token 是唯一的长期凭据。
- `logout` 只清除 token 与 verifier，**保留动态客户端注册**——注册端点的限流很紧（实测 `X-RateLimit-Limit: 3`），复用注册可以避免再次登录被限流。
- 网络端点：`mcp.flowus.cn`（资源元数据 + MCP 数据面）、`api.flowus.cn`（授权 / 令牌 / 注册）。
- 撤销授权：在 FlowUs 侧撤销该应用授权，然后本地 `/flowus logout`。

## 工作原理

```
/flowus login
  ├─ 启动 127.0.0.1:42813/callback 监听（先生成 state）
  ├─ auth(provider, {serverUrl, scope})            ← SDK 驱动
  │    ├─ RFC 9728 发现  /.well-known/oauth-protected-resource
  │    ├─ RFC 8414 发现  /.well-known/oauth-authorization-server
  │    ├─ 无注册则 RFC 7591 动态客户端注册（loopback redirect + native）
  │    └─ 生成 PKCE(S256) 授权 URL → redirectToAuthorization → 打开浏览器
  ├─ 浏览器授权 → 回调带 ?code&state（state 校验不过直接拒绝）
  ├─ auth(provider, {serverUrl, authorizationCode, iss})
  │    └─ 换 token（access + refresh）→ 落盘
  └─ MCP initialize → tools/list → 逐个注册为 DSH 工具（mcp__flowus__*）
```

- 运行时 401：SDK 自动用 refresh token 续期并重试一次；仍失败则报「需要 `/flowus login`」，不会静默失败。
- 主动续期：插件记录了 token 的获取时间与有效期，连接前若已过期会先刷新，避免先撞 401。
- 工具列表变化：MCP 的 `notifications/tools/list_changed` 会触发重新同步（整代替换，失败保留旧的一代）。
- **一次一个工具调用**：FlowUs 服务端限制同一 MCP 会话同时只能有一个工具调用（并发会返回 JSON-RPC `-32002`）。插件在会话内做了串行队列，并对并发拒绝做有限次退避重试，所以模型并行发起多个只读调用不会失败（实测 5 个并发调用 5/5 成功）。
- 命名冲突：若 `mcp__flowus__*` 已被别的插件占用，则本次同步整体拒绝，不会半发布。
- 设置页：宿主半用 `ctx.webServer.register` 注册 `/flowus/api/*`，客户端半是 `window.__ModuleLoader__` classic script（`lib/client.js`，无需构建步骤），注册进 `settings.section` 槽位；两者通过 `fetch` + JSON 快照通信（没有自建 RPC 协议）。

## 开发与测试

```powershell
# 本地联调所需的两个前提（node_modules 不入库）
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @modelcontextprotocol/client@2.0.0
# 让 node --test 能加载真实的 dsh-tools / schemastery：指向 DSH 安装内的同名目录
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai `
  -Target "$(Split-Path (Get-Command dsh).Source)\..\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

npm test                                            # 离线测试（109 项）
$env:DSH_FLOWUS_LIVE=1; node --test tests/flowus-live.test.js   # 联网冒烟（3 项）
```

测试构成：

- `tests/tool-names.test.js` 命名契约（与官方 MCP 桥一致）
- `tests/command-grammar.test.js` `/flowus` 语法
- `tests/store.test.js` 原子写入 / 串行化 / 损坏文件处理
- `tests/oauth-provider.test.js` OAuthClientProvider 语义与状态裁剪
- `tests/callback-server.test.js` 回调校验（state / code / error / 端口回退 / abort）
- `tests/browser.test.js` 无 shell 的浏览器启动与候选回退
- `tests/tool-bridge.test.js` MCP JSON Schema → DSH 参数 DSL、输出契约（用 DSH 自己的 schema 编译器校验）
- `tests/http-api.test.js` 设置页宿主 API：信任栅栏、方法守卫、`{ok, snapshot}` 封装、错误路径
- `tests/client-bundle.test.js` 浏览器半：`__ModuleLoader__` 注册契约、中英文字典键一致性、`settings.section` 注册、与宿主路由的路径交叉校验、视图模型分支、一次完整渲染
- `tests/mcp-session.test.js` 结果归一化（文本/图片/资源/结构化内容）、并发拒绝识别、串行队列（顺序、并发上限、失败不断链）、授权错误分类
- `tests/plugin-apply.test.js` 真 cordis 上下文装载、命令面、释放
- `tests/plugin-real-services.test.js` 装真实的 `ToolRuntime` / `CommandRuntime` / `SystemPrompt`：命令真的进了注册表、提示词段真的进了 assembly、桥接工具真的注册并跑完整执行管线（参数校验、输出契约校验、错误路径）
- `tests/flowus-live.test.js` 真实端点发现、PKCE 授权 URL、未授权连接的错误映射

改动源码后重新分发（本地检出方式）：

```powershell
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.0.tgz"
```

正式发布走 `npm publish --access public`（见上面的「发布（维护者）」）。

### 在另一个运行时上验证

测试通过 `node_modules\@deepseek-ai` 这个 junction 解析 `@deepseek-ai/*`，所以换运行时验证就是：把 junction 指向那个版本的包目录，在仓库副本上重跑 `node --test`（以及联网冒烟）。两个版本差异值得记住：

- **依赖布局**：`0.2.0-rc.2` 把依赖嵌在 `<dsh>\node_modules\@deepseek-ai\...`；`0.2.1-alpha.1` 与 `0.2.1-alpha.2` 则**提升**到 `<runtime>\node_modules\@deepseek-ai\...`（根本没有嵌套目录）。任何假定 rc.2 布局的脚本都要加回退。
- **`./invariant` 子路径被移除**：`@deepseek-ai/dsh-tools/invariant`、`dsh-commands/invariant`、`dsh-system-prompt/invariant`（及其 `lib/invariant.js`）在 `0.2.0-rc.2` 存在，`0.2.1-alpha.1` 起被删。本插件只 import 包根——不要新增这类深路径引用。

已验证矩阵（三个版本都跑过离线套件 + 联网冒烟，零失败）：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`。

## 排错

| 现象 | 处理 |
| --- | --- |
| `/flowus` 命令不存在 | 插件没加载：确认 `dsh.profile.bundles` 里有 `@blksword/dsh-flowus`，然后**重启 `dsh web`** |
| 设置里没有 FlowUs 页面 | 同上：客户端入口图在启动时组装；重启 `dsh web` 并刷新浏览器页面 |
| 设置页里点按钮报 401 | 页面请求需要带登录 Cookie；请从 `dsh web` 打印的带 `?token=` 的地址打开 GUI |
| 授权后没有工具 | `/flowus reload`；再看 `/flowus status` 或设置页的错误行 |
| 端口 42813 被占用 | 会自动改用临时端口，但会重新做一次客户端注册（可能触发注册限流）；建议在配置里换一个固定 `callbackPort` |
| 注册被限流（`too_many_requests`） | 等一会儿再登录；插件会复用已注册客户端，通常只需注册一次 |
| 浏览器没打开 | 命令结果或设置页里会显示授权 URL，手动打开即可 |
| 工具名冲突 | 改 `serverName`（例如 `flowus2`），命名空间随之变化 |

## 已知限制

- 图片 / 音频等富内容块不内联渲染（以占位文本呈现）；FlowUs 的页面/数据库/搜索以文本和 JSON 为主。
- 不支持 MCP 任务扩展：`execution.taskSupport === "required"` 的工具会被跳过并在日志里说明。
- 不注册 MCP resources / prompts（本插件的范围就是工具 + 命令 + 设置页）。
- 设置页只做状态展示与授权/连接操作，没有细粒度的「按工具开关」；工具可见性目前只有 `maxTools` 上限与命名冲突保护。
- 首次授权必须由人在浏览器确认（这是 OAuth 的设计，不是缺陷）。

## 目录结构

```
dsh-flowus/
├─ cordis.patch.yml      # bundle 层：插入 flowus 插件行与默认配置
├─ package.json          # dsh.bundle.patch / dsh.client / peers / 打包白名单
├─ icon.svg
├─ locale/               # 插件列表里的显示名与简介（en/zh）
│  ├─ en.json
│  └─ zh.json
├─ lib/
│  ├─ index.js           # 插件入口：Config、apply、工具发布、/flowus 命令、提示词段、设置页路由
│  ├─ http-api.js        # 设置页的宿主 JSON API（/flowus/api/*，走连接信任栅栏）
│  ├─ client.js          # 浏览器半：__ModuleLoader__ bundle，注册 Settings → FlowUs 页面
│  ├─ login.js           # 两段式授权码流程编排
│  ├─ oauth-provider.js  # SDK 的 OAuthClientProvider 实现 + token 摘要/过期判断
│  ├─ callback-server.js # 一次性 loopback 回调监听
│  ├─ browser.js         # 无 shell 的默认浏览器打开（含 Windows 候选回退）
│  ├─ mcp-session.js     # MCP 会话：连接、发现、调用、结果归一化
│  ├─ tool-bridge.js     # MCP JSON Schema → DSH defineTool 定义
│  ├─ tool-names.js      # mcp__<server>__<raw> 命名契约
│  ├─ command-grammar.js # /flowus 语法解析
│  └─ store.js           # 私有状态文件（原子写、串行化）
└─ tests/                # 离线单测 + 可选联网冒烟
```

## License

Apache-2.0，见 [LICENSE](./LICENSE)。
