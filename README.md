# @blksword/dsh-flowus

[English](./README.en.md) | 中文

DeepSeek Harness（DSH）的 FlowUs 集成插件。该插件在宿主进程内完成面向 FlowUs 官方 MCP 服务器（`https://mcp.flowus.cn/message`）的 OAuth 2.1 授权（RFC 9728 元数据发现、RFC 7591 动态客户端注册、PKCE S256），将服务器公布的工具注册为 Agent 原生工具，并提供 `/flowus` 命令与设置面板页面。授权过程不使用静态令牌。

## 功能范围

- **浏览器授权。** 面向 FlowUs 官方 MCP 服务器完成 OAuth 2.1 授权码流程，回调地址为 `127.0.0.1` 上的 loopback 监听。访问令牌与刷新令牌保存在插件私有状态文件中，由插件自动续期。
- **原生工具。** 将 FlowUs MCP 服务器公布的工具注册至 DSH 工具注册表，命名规则与 DSH 内置 MCP 桥一致，即 `mcp__flowus__<工具名>`。
- **`/flowus` 命令。** 提供状态查询、授权、登出、工具列表、直接调用、重连与帮助。
- **设置面板页面。** 设置面板中的独立 FlowUs 页面：授权与连接状态、服务器版本、工具目录（可按名称或描述搜索，并标注只读/写入），以及授权、重连、登出、刷新操作；凭据路径与授权地址可一键复制，登录等待期间自动轮询，切回标签页时立即刷新。
- **系统提示词段落。** 将服务器 instructions 与当前工具目录并入系统提示词；未授权时给出明确的操作指引。

## 背景

DSH 内置的 `@deepseek-ai/dsh-mcp-client` 支持 `stdio` 与 `streamable-http`（自定义请求头）两种接入方式，不支持 MCP OAuth。FlowUs 官方 MCP 服务器采用 OAuth 2.1，并要求客户端在无法完成授权流程时明确报告，而非退回静态令牌。本插件实现该 OAuth 客户端流程，并将发现的工具桥接至 `ctx.tools`。

## 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`（见“兼容性”） |
| Node.js | `>= 22` |

## 安装

### 从 npm 安装

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` 的执行过程如下：

1. 通过 pnpm 安装该包；
2. 识别包内声明的 `dsh.bundle.patch`，并将 `@blksword/dsh-flowus` 追加至 `dsh.profile.bundles`（无需手工编辑 `package.json`）；
3. 通过 peer 依赖解析到 DSH 安装内提供的 `@deepseek-ai/*` 实现。

pnpm 11 的 `minimumReleaseAge` 默认值为 1440 分钟：发布不足 24 小时的版本在解析 `@latest` 时会被跳过，解析结果回退至上一版本，且退出码仍为成功。安装最新发布时应指定确切版本号：

```powershell
dsh plugin --profile web add @blksword/dsh-flowus@0.1.1
```

### 从 GitHub 安装

仓库为公开仓库，可不经 registry 直接安装：

```powershell
dsh plugin --profile web add github:BlkSword/dsh-flowus
```

该路径已完成端到端验证：pnpm 可解析 git 依赖，bundle 条目写入 `dsh.profile.bundles`，加载器完成组合与导入（`dsh --profile <名称> --dump-config` 与 `--dump-config-schema` 均通过）。如需可复现的安装，可使用 `github:BlkSword/dsh-flowus#<commit-sha>` 指定提交；后续通过 `dsh plugin --profile web update @blksword/dsh-flowus` 获取更新。

### 从本地检出安装

```powershell
# 1. 打包至 profile 目录
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"

# 2. 在 profile 目录中安装（使用相对路径）
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.1.tgz"
```

> Windows 说明：pnpm 会将 `link:D:/...`、`file:D:/...` 形式的绝对路径按相对路径解析，从而生成指向 `...\profiles\web\D:\...` 的无效链接。因此应先将 tarball 打包至 profile 目录，再使用上述相对 `file:` 说明符。

### 安装后操作

重启 `dsh web` 并刷新浏览器页面。客户端入口图（`window.__DSH_BOOT__`）在进程启动时组装，默认配置下 `dsh-hmr` 的 `root: []` 仅保留显式配置监视点，因此新增插件不会热加载进正在运行的进程。重启后可通过 `/flowus status` 或“设置 → FlowUs”确认加载结果。

## 兼容性

本版本支持的 DSH 版本为 `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`，不支持其他版本。peer 依赖与兼容性记录仅声明这三个版本。

| DSH 版本 | `@deepseek-ai/cordis` | `@deepseek-ai/schemastery` |
| --- | --- | --- |
| `0.2.0-rc.2` | `~4.0.4` | `~3.18.4` |
| `0.2.1-alpha.1` | `~4.0.5-alpha.1` | `~3.18.5-alpha.1` |
| `0.2.1-alpha.2` | `~4.0.5-alpha.1` | `~3.18.5-alpha.1` |

peer 依赖声明方式：`@deepseek-ai/dsh-*` 采用精确版本析取 `0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-alpha.2`；`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 采用成对范围 `~4.0.4 || ~4.0.5-alpha.1` 与 `~3.18.4 || ~3.18.5-alpha.1`。上述 `@deepseek-ai/*` 包均由当前 dsh profile 提供，不应另行添加依赖。

该矩阵经实测确认：离线套件与联网冒烟测试分别在三个运行时自带的包上执行，均无失败；插件涉及的具名导出集合在三个版本间完全一致。alpha 版本的范围分支为必需项：预发布版本仅在比较符于同一 `major.minor.patch` 上带预发布标识时才满足范围，因此 `~4.0.4` 不接受 `4.0.5-alpha.1`，`0.2.0-rc.2` 亦不接受 `0.2.1-alpha.1`。

## 首次授权

```
/flowus login
```

1. 插件在本机 `127.0.0.1:42813/callback` 建立一次性回调监听；
2. 打开默认浏览器至 FlowUs 授权页；若无法自动打开，命令输出与设置页均会显示完整授权 URL；
3. 用户在 FlowUs 页面确认授权后，浏览器重定向至回调地址；
4. 插件以授权码与 PKCE verifier 换取令牌，随后连接 MCP 服务器、发现工具并完成注册；
5. 命令返回已注册的工具数量。

授权完成后可直接以自然语言向 Agent 提出 FlowUs 相关任务。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/flowus` 或 `/flowus status` | 显示授权状态、连接状态、凭据文件路径与已注册工具列表 |
| `/flowus login` | 打开浏览器完成授权，并同步工具列表 |
| `/flowus logout` | 删除令牌，保留动态客户端注册（避免重复注册触发限流） |
| `/flowus tools` | 列出已注册至模型侧的 FlowUs 工具 |
| `/flowus call <工具> [JSON]` | 直接调用指定工具，例如 `/flowus call search_pages {"query":"周报"}` |
| `/flowus reload` | 重新连接并同步工具列表 |
| `/flowus help` | 显示用法 |

## 设置页

插件通过 `settings.section` 槽位（`id: flowus`）向设置面板贡献一个独立页面，用于查看状态并执行授权相关操作：

- **状态指示**：未授权、等待浏览器授权、已授权未连接、已连接（含工具数量）四种状态，使用 `StateDot` 与 `Tag` 呈现。
- **状态明细**：MCP 地址、工具命名空间、凭据文件路径、授权 scope、令牌过期时间、是否包含刷新令牌、上次同步时间、最近错误。
- **操作按钮**：登录（未授权时）、重新授权（已授权时）、取消（授权进行中）、重新连接、退出登录、刷新。
- **工具列表**：当前注册至模型侧的 `mcp__flowus__*` 工具及其简述。

页面数据来自宿主路由 `GET /flowus/api/status`；按钮分别向 `/flowus/api/login`、`/flowus/api/login-cancel`、`/flowus/api/logout`、`/flowus/api/reload` 发送 POST 请求。全部响应均为同一份状态快照（`{ ok, snapshot }`），因此单一渲染路径即可覆盖所有操作。

上述路由与 DSH 其他 Web 接口一致，先经由连接服务的信任栅栏（Host/Origin 校验与登录令牌 Cookie）：未认证请求直接返回 401，无法读取状态或触发授权。

授权采用先返回后轮询的方式：`POST /flowus/api/login` 立即返回，浏览器授权在后台执行（上限为 `loginTimeoutMs`）；页面在等待期间每 1.5 秒刷新一次状态，因此不会长时间占用 HTTP 请求。

## 配置

配置通过 profile 补丁层覆盖（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

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
| `autoConnect` | `true` | 启动时若已有可用令牌，则连接并发布工具 |
| `failOnStartupError` | `false` | 初始连接或工具同步失败时，是否使插件激活失败 |
| `statePath` | 空 → `<DSH_HOME>/flowus/oauth.json` | 凭据与注册信息文件路径 |
| `clientName` | `DeepSeek Harness` | 授权页显示的客户端名称 |
| `callbackHost` | `127.0.0.1` | 回调监听地址 |
| `callbackPort` | `42813` | 回调端口（固定端口可复用同一次客户端注册） |
| `callbackPath` | `/callback` | 回调路径 |
| `loginTimeoutMs` | `300000` | 等待浏览器完成授权的上限 |
| `openBrowser` | `true` | 是否自动打开默认浏览器 |
| `toolCallTimeoutMs` | `60000` | 单次工具调用超时 |
| `maxTools` | `128` | 发布工具的数量上限（`0` 表示不限制） |
| `maxResultChars` | `32000` | 单次工具结果转发给模型的字符上限，超出时保留首尾并注明省略量（`0` 表示不限制） |
| `deferToolLoading` | `false` | 以「延迟加载」发布 FlowUs 工具：在支持该能力的路由上，schema 以 `defer_loading` 声明而不进入常驻上下文；不支持的路由会自动忽略该标记 |
| `maxInstructionChars` | `32000` | 服务器 instructions 进入系统提示词前的字符上限，超出部分截断并在日志中提示（`0` 表示不限制） |
| `promptSection` | `true` | 是否将 FlowUs 说明与服务器 instructions 并入系统提示词 |

## 凭据与安全

- 凭据文件位于 `%DSH_HOME%\flowus\oauth.json`（默认 `C:\Users\<用户名>\.dsh\flowus\oauth.json`），内容包括动态注册的 `client_id`、令牌集合、PKCE verifier 与 discovery 缓存。写入采用“临时文件 + rename”的原子替换方式，权限按平台能力设置为 `0600`。
- 客户端类型为 public client：`token_endpoint_auth_method = "none"`，配合 PKCE S256，不存在 client secret；刷新令牌是唯一的长期凭据。
- `logout` 仅清除令牌与 verifier，保留动态客户端注册。注册端点限流较严格（实测响应头 `X-RateLimit-Limit: 3`），复用注册可避免重复登录时触发限流。
- 涉及的网络端点：`mcp.flowus.cn`（资源元数据与 MCP 数据面）、`api.flowus.cn`（授权、令牌、注册）。
- 撤销授权：先在 FlowUs 侧撤销该应用授权，再于本地执行 `/flowus logout`。

## 实现

```
/flowus login
  ├─ 建立 127.0.0.1:42813/callback 一次性监听（先生成 state）
  ├─ auth(provider, { serverUrl, scope })          ← 由 MCP SDK 驱动
  │    ├─ RFC 9728 发现  /.well-known/oauth-protected-resource
  │    ├─ RFC 8414 发现  /.well-known/oauth-authorization-server
  │    ├─ 无注册信息时执行 RFC 7591 动态客户端注册（loopback redirect + native）
  │    └─ 生成 PKCE(S256) 授权 URL → redirectToAuthorization → 打开浏览器
  ├─ 浏览器授权 → 回调携带 ?code&state（state 不匹配则拒绝）
  ├─ auth(provider, { serverUrl, authorizationCode, iss })
  │    └─ 换取令牌（access + refresh）并持久化
  └─ MCP initialize → tools/list → 逐项注册为 DSH 工具（mcp__flowus__*）
```

- **令牌续期。** 运行时收到 401 时，SDK 使用刷新令牌续期并重试一次；仍失败则以“需要重新授权”的明确错误报告。插件记录令牌的获取时间与有效期，在连接前若判定已过期即先行刷新，以避免首次请求即返回 401。
- **工具列表变更。** MCP 的 `notifications/tools/list_changed` 触发重新同步：插件接管新列表并以整代替换重新注册，失败时保留上一代。
- **会话自愈。** 服务器遗忘会话时（JSON-RPC `-32001`，或会话端点 404），插件自动重连一次、重新注册工具列表并重放当前调用，无需人工执行 `/flowus reload`。
- **结果上界与调用卡片。** 单个结果转发给模型前按 `maxResultChars` 截断：保留首尾并注明省略了多少字符，结构化内容同样受限，超大内联负载（base64 图片/blob）在保存的原始块中以大小占位。每个工具还提供调用卡片：`kind` 区分读取/搜索与写入，标题给出本次调用的对象。
- **调用串行化。** FlowUs 服务端限制同一 MCP 会话同时仅允许一个工具调用（并发调用返回 JSON-RPC `-32002`）。插件在会话内以串行队列执行调用，并对并发拒绝执行有限次退避重试，因此模型并行发起多个只读调用不会失败（验证结果：5 个并发调用全部成功）。
- **命名冲突。** 若 `mcp__flowus__*` 已被其他插件占用，则该次同步整体拒绝，不产生部分发布。
- **回调校验。** 回调监听只接受 `GET`，并要求唯一且匹配的 `state`（常量时间比较）；不满足者只作答、不结束登录，因此本机任意进程或页面无法取消进行中的授权。监听地址强制为 loopback（RFC 8252 §7.3），帮助页回显的服务器文本经转义并截断。
- **凭据绑定。** 存储的凭据记录其所属资源 URL；当配置的 `serverUrl` 指向另一资源时，插件拒绝出示令牌并提示重新授权，而不会把 FlowUs 令牌发给第三方端点。
- **设置页实现。** 宿主侧通过 `ctx.webServer.register` 注册 `/flowus/api/*`；客户端侧为 `window.__ModuleLoader__` 形式的 classic script（`lib/client.js`，无需构建步骤），注册至 `settings.section` 槽位；两侧通过 `fetch` 与 JSON 快照通信，未引入自定义 RPC 协议。

## 开发与测试

本地开发需具备以下两项前提（`node_modules` 不入库）：

```powershell
npm install --no-save --no-package-lock --legacy-peer-deps --ignore-scripts @modelcontextprotocol/client@^2.2.0
# 使 node --test 能够加载真实的 dsh-tools / schemastery：指向 DSH 安装内的同名目录
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai `
  -Target "$(Split-Path (Get-Command dsh).Source)\..\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"

npm test                                            # 离线套件：150 项用例，147 项通过，3 项联网用例跳过
$env:DSH_FLOWUS_LIVE=1; node --test tests/flowus-live.test.js   # 联网冒烟：3 项
```

> **顺序不能颠倒。** 必须先执行 `npm install`，再建 junction：npm 会把 junction 内的 `@deepseek-ai/*` 当作多余依赖，顺着链接把它们从 DSH 安装里删掉。已有 junction 时要更新依赖，先 `cmd /c rmdir node_modules\@deepseek-ai` 摘掉链接，装完再重建。

测试构成：

| 文件 | 覆盖范围 |
| --- | --- |
| `tests/tool-names.test.js` | 工具命名契约（与官方 MCP 桥一致） |
| `tests/command-grammar.test.js` | `/flowus` 语法解析 |
| `tests/store.test.js` | 状态文件的原子写入、串行化与损坏处理 |
| `tests/oauth-provider.test.js` | `OAuthClientProvider` 语义、issuer 绑定（凭据不跨授权服务器出示）与状态裁剪 |
| `tests/callback-server.test.js` | 回调校验（state、code、error、端口回退、abort） |
| `tests/browser.test.js` | 不依赖 shell 的浏览器启动与候选回退 |
| `tests/tool-bridge.test.js` | MCP JSON Schema 至 DSH 参数 DSL 的转换与输出契约（以 DSH 自身的 schema 编译器校验） |
| `tests/http-api.test.js` | 设置页宿主 API：信任栅栏、方法校验、`{ ok, snapshot }` 封装与错误路径 |
| `tests/client-bundle.test.js` | 浏览器半：`__ModuleLoader__` 注册契约、中英文字典键一致性、槽位注册、与宿主路由的路径交叉校验、视图模型分支与完整渲染 |
| `tests/mcp-session.test.js` | 结果归一化、并发拒绝识别、串行队列（顺序、并发上限、失败不影响后续）与授权错误分类 |
| `tests/plugin-apply.test.js` | 真实 cordis 上下文中的装载、命令面与释放 |
| `tests/plugin-real-services.test.js` | 装载真实的 `ToolRuntime`、`CommandRuntime`、`SystemPrompt`：命令注册、提示词段落组装、工具注册与完整执行管线（参数校验、输出契约、错误路径） |
| `tests/flowus-live.test.js` | 真实端点的元数据发现、PKCE 授权 URL 与未授权连接的错误映射 |

源码修改后的本地分发方式：

```powershell
npm pack --pack-destination "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin --profile web add "file:./blksword-dsh-flowus-0.1.1.tgz"
```

正式发布参见“发布”。

### 在另一运行时上验证

测试通过 `node_modules\@deepseek-ai` 这一 junction 解析 `@deepseek-ai/*`。更换运行时进行验证时，将该 junction 指向目标版本的包目录，并在仓库副本上重新执行 `node --test` 与联网冒烟测试。两个版本差异需注意：

- **依赖布局。** `0.2.0-rc.2` 将依赖嵌套于 `<dsh>\node_modules\@deepseek-ai\...`；`0.2.1-alpha.1` 与 `0.2.1-alpha.2` 则提升至 `<runtime>\node_modules\@deepseek-ai\...`，不存在嵌套目录。任何假定 rc.2 布局的脚本均需增加回退逻辑。
- **`./invariant` 子路径已移除。** `@deepseek-ai/dsh-tools/invariant`、`dsh-commands/invariant`、`dsh-system-prompt/invariant`（及其 `lib/invariant.js`）在 `0.2.0-rc.2` 中存在，自 `0.2.1-alpha.1` 起被移除。本插件仅从包根导入，不应新增此类深层路径引用。

## 发布

```powershell
npm login                      # 每台机器执行一次；@blksword scope 须属于该账号
npm publish --access public    # prepublishOnly 会先执行离线测试
npm view @blksword/dsh-flowus version

# 对发布产物执行端到端校验
dsh plugin --profile web remove @blksword/dsh-flowus
dsh plugin --profile web add @blksword/dsh-flowus@latest
```

`dsh plugin add` 是唯一受支持的安装路径：加载器从 profile 的 `node_modules` 解析该包，客户端半由包内 `exports["./client"]` 提供。

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| `/flowus` 命令不存在 | 插件未加载。确认 `dsh.profile.bundles` 包含 `@blksword/dsh-flowus`，随后重启 `dsh web` |
| 设置面板中没有 FlowUs 页面 | 原因同上：客户端入口图在启动时组装。重启 `dsh web` 并刷新浏览器页面 |
| 设置页操作返回 401 | 页面请求需携带登录 Cookie。请使用 `dsh web` 输出的、含 `?token=` 的地址打开 GUI |
| 授权完成后没有工具 | 执行 `/flowus reload`，再查看 `/flowus status` 或设置页中的错误信息 |
| 端口 42813 被占用 | 插件会改用临时端口，但此时需重新执行一次客户端注册（可能触及注册限流）。建议在配置中指定其他固定 `callbackPort` |
| 注册被限流（`too_many_requests`） | 稍后重试授权。插件复用已注册客户端，通常仅需注册一次 |
| 浏览器未打开 | 命令输出与设置页均会显示授权 URL，可手动打开 |
| 工具命名冲突 | 修改 `serverName`（例如 `flowus2`），工具命名空间随之变化 |

## 已知限制

- 图片、音频等富内容块不内联渲染，以占位文本呈现。FlowUs 的工具以文本与 JSON 为主。
- 不支持 MCP 任务扩展：`execution.taskSupport === "required"` 的工具将被跳过，并在日志中说明原因。
- 不注册 MCP resources 与 prompts；本插件的范围为工具、命令与设置页。
- 设置页仅提供状态展示与授权、连接操作，不提供按工具粒度的启用开关；工具可见性目前仅受 `maxTools` 上限与命名冲突保护约束。
- 首次授权必须由用户在浏览器中确认，这是 OAuth 授权码流程的固有要求。

## 目录结构

```
dsh-flowus/
├─ cordis.patch.yml      # bundle 层：插入 flowus 插件行与默认配置
├─ package.json          # dsh.bundle.patch / dsh.client / peer 依赖 / 发布白名单
├─ icon.svg
├─ locale/               # 插件列表中的显示名与简介（en/zh）
│  ├─ en.json
│  └─ zh.json
├─ lib/
│  ├─ index.js           # 插件入口：Config、apply、工具发布、/flowus 命令、提示词段落、设置页路由
│  ├─ http-api.js        # 设置页宿主 JSON API（/flowus/api/*，经连接信任栅栏）
│  ├─ client.js          # 浏览器半：__ModuleLoader__ bundle，注册设置页
│  ├─ login.js           # 两段式授权码流程编排
│  ├─ oauth-provider.js  # SDK 的 OAuthClientProvider 实现与令牌摘要、过期判断
│  ├─ callback-server.js # 一次性 loopback 回调监听
│  ├─ browser.js         # 不依赖 shell 的浏览器启动（含 Windows 候选回退）
│  ├─ mcp-session.js     # MCP 会话：连接、发现、调用与结果归一化
│  ├─ tool-bridge.js     # MCP JSON Schema 至 DSH defineTool 定义的转换
│  ├─ tool-names.js      # mcp__<server>__<raw> 命名契约
│  ├─ command-grammar.js # /flowus 语法解析
│  └─ store.js           # 私有状态文件（原子写入、串行化）
└─ tests/                # 离线测试与可选联网冒烟测试
```

## 许可证

Apache-2.0，详见 [LICENSE](./LICENSE)。
