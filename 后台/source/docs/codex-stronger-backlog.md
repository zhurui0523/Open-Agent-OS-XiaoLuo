# Codex 比小逻更强的地方（逐个攻克清单）

口径：只列「Codex 有、小逻没有，或明显更浅」的能力。判定依据是两边源码，不是文档旧结论。
Codex 侧证据：`codex-rs`（commit `69231e1`，本机路径见文末）。小逻侧证据：本轮实测代码位置。

---

## 总表（按建议攻克顺序）

| # | 维度 | Codex 证据 | 小逻现状 | 差距性质 | 成本 | 建议 |
|---|---|---|---|---|---|---|
| 1 | 结构化补丁语义 | `apply_patch` 223 处引用；`@@` 上下文 hunk 格式 | `edit_file` 多 hunk + 三级容错；**已补 `apply_patch`**：`@@` 上下文锚点 + 一次 update/add/delete 多文件 | ✅ 已攻克（2026-11-16） | 低–中 | 已交付，见下 |
| 2 | 生命周期 hooks 事件面 | 独立 `hooks` crate：`engine/{discovery,dispatcher,command_runner}`、`events/permission_request`、`config_rules` | 原有 PreToolUse + Post 验收 + 技能 `verify`；**已补** `session_start` / `session_end` / `user_prompt_submit` / `permission_request` 四个事件 + 外部命令 runner + 解析/匹配抽成 `hooks.ts` | ✅ 已攻克（2026-11-16） | 低 | 已交付，见下 |
| 3 | 终端 PTY 完整交互 | 独立 crate `utils/pty`（跨平台 portable-pty） | 原为管道会话（isatty=false）；**已补** `pty-adapter`：node-pty 惰性加载 + ConPTY/openpty + 装不上时如实降级并回流原因 | ✅ 已攻克（真机端到端待验） | 中 | 见下方边界 |
| 4 | 子 Agent 可写 / 并行 | `spawn_agent` 27 处引用，可写、可并行 | 原只读、单任务；**已补** `tasks` 并行只读（最多 3）+ `canWrite`（宿主显式开写权限，写任务串行），改动登记回主线程 | ✅ 已攻克（并行仅只读） | 中 | 见下方边界 |
| 5 | MCP 企业级认证 | `rmcp-client` 里 `client_credentials` 4 处、`token_exchange` 12 处、重试退避 | 原有公开客户端 + PKCE + 刷新 + 401 重试一次；**已补**机密客户端（basic/post）+ `client_credentials` + RFC 8693 `token_exchange` + token 端点重试背压，secret 不落盘 | ✅ 代码已补齐（真实 IdP 未验） | 中 | 见下方边界 |
| 6 | POSIX 内核级沙箱 | `landlock` 191 处、seatbelt | 只有 Windows MIC-low；POSIX / AppContainer 未开工 | 真差距，最贵 | 大（要 Linux/macOS 真机 + CI 矩阵） | 放最后；没有跨平台真机验等于没做 |

---

## 逐项：差在哪、怎么改、怎么验收

### 1. 结构化补丁语义 — ✅ 已攻克（2026-11-16）

**Codex 怎么做的**：`apply_patch` 用 `*** Begin Patch` + `*** Update File` + `@@` 上下文行描述改动，只传"上下文 + 增删行"。大文件只发几十行，不用整份回传；上下文对不上就整体拒绝，不会误改到别处。

**小逻现状**：`edit_file` 走 `oldText → newText` 的整串替换，多 hunk 一次落地，`patch.ts` 已有 exact / trailing / trimmed 三级匹配。能做，但：
- 改 2000 行文件里 3 处，模型仍要抄整段原文（token 高）；
- 没有"上下文锚点"，长段重复文本（比如多个 `return null;`）只能靠整串唯一性，容易撞车；
- 不能一个调用里同时 update + add + delete 文件。

**改法**（不换工具名，加一个入口，避免破坏既有 prompt/白名单）：
1. `patch.ts` 增加 `applyContextPatch(source, hunks)`：解析 `@@` 锚点 + 上下文行，按行匹配定位，命中要求"上下文逐行相等"，否则整批不落地；
2. 新增工具 `apply_patch`（`chat-tools.ts` 注册，走同一套 `fs` 口与只读目录/删除双锁检查），支持 `add` / `update` / `delete` 三类操作；
3. `edit_file` 保留不动（短文本、单点替换仍更省）；
4. 快照测试补 `@@` 命中 / 上下文不符 / 多文件批处理 / 半途失败整批回滚 四类用例。

**验收**：`tests/patch.test.mjs` 新增用例全绿；快照新增 `apply_patch` 四例；门禁九步通过；`tool-search` 中文"打补丁/按上下文改"能命中。

**落地结果（2026-11-16）**：

- `patch.ts` 新增 `parsePatch()` 与 `applyContextHunks()`：`@@` 锚点只用来收敛候选位置，匹配本身逐行严格相等，不做模糊匹配；
- 新工具 `apply_patch`（`chat-tools.ts` 的 `APPLY_PATCH_SCHEMA`，`caps.fsEnabled` 时注册），支持一次 `Update File` / `Add File` / `Delete File`；
- 执行器 `execApplyPatch`（`chat-agent.ts`）：**先把所有文件算完再落盘**，只要一处锚不上就整批不动；删除仍守"本轮先 read_file 过才允许删"；写完自动 tsc 检查 + Post hook；
- `tool-search` 同义词补 `打补丁 / 上下文补丁 / 锚点 / 按行改` → `apply_patch`；
- 测试新增 7 条（解析 / 落地 / 上下文不符整批不落 / 多命中靠锚点收敛 / 多文件 / 格式错误带行号 / 工具面接线），`tests/brain-patch-and-truncation.test.mjs` 19 条全绿；基线 `requirements-coverage.csv` 相应 +7 行；
- 本地九步全量门禁 233.9s 通过。

**已知边界（没做）**：① ~~`*** Move to:` 暂不支持~~ → **第 7 批已补**（2026-11-16：改名 + 改内容一次做完，目标被占用即拒，先落新文件再删旧文件）；上下文也已补到三级（逐字符 / 忽略行尾 / 忽略首尾）；② 执行器的"全算后落盘"已有真跑用例（move 路径），但"写盘中途失败不回滚"仍只有源码断言；③ 写盘失败不回滚已写成功的文件（避免二次破坏），只如实回报；④ 未做 Codex `seek_sequence` 的第四级"标点归一化模糊匹配"（避免把错误内容按标点差异硬落）。

### 2. hooks 事件面 — ✅ 已攻克（2026-11-16）

**Codex**：`hooks` 是独立 crate，`events/` 下 12 个文件，事件全集为 `session_start` / `session_end` / `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `permission_request` / `model_request` / `compact` / `interrupt` / `stop`；带 discovery（从配置发现规则）与 command runner（跑外部脚本）。

**小逻原来**：`hooks.toml` 已在用，但只有 PreToolUse 拦截与 Post 验收两个点；规则解析埋在 `chat-agent.ts` 的私有方法 `parseHooksToml` 里，不可测、也不方便加事件。

**改法**：取 Codex 事件面里最值钱、又不需要宿主配合的四个（`session_start` / `session_end` / `user_prompt_submit` / `permission_request`），规则可声明 `command` 走既有命令通道与四档审批。

**落地结果（2026-11-16）**：

- 新建 `lib/brain/hooks.ts`：`HookEvent` / `HookRule` 类型 + `parseHooks()` / `normalizeEvent()` / `hookMatches()` / `fillCommand()`；解析器仍是零依赖子集（`[[hook]]` + `key = "value"`），坏行跳过；
- **未知事件名整条丢弃**，不静默降级成 `pre`（否则一个拼错的观测钩子会变成拦截器，工具全被挡）；
- `chat-agent.ts` 增加 `runEventHooks(event, payload)`：只有声明了 `command` 的规则才真跑，走 `ports.command.run`（命令闸门与四档审批照旧），单条 60 秒、与 Post 验收共享本轮 6 次额度；
- 事件接线：`session_start` 只在会话首轮（`turnId === 1`）跑一次；`user_prompt_submit` 每轮跑，输出以 `[钩子]` system 消息注入模型上下文；`session_end` 在轮末 `memoryPipeline` 之后跑；`permission_request` 插在 `execRunCommand` 解析完参数、三支分派之前，**命令退出码非 0 即拒绝执行**（`trackFailure` 回流，禁止换写法绕道）；
- 模板变量：`{command}` / `{prompt}` / `{tool}` / `{path}` / `{reason}`；没传的占位符原样保留，便于一眼看出命令写错；
- 测试新增 7 条（解析含未知事件丢弃 / 事件名归一 / 三重门匹配与坏正则 / 模板替换 / 接线断言 + 旧解析器已删 / **真跑：轮首两事件执行 + `permission_request` 非 0 拦下命令且模型收到拒绝回流** / **真跑：钩子失败只提醒不阻断，未命中的命令照常执行**），`tests/brain-hooks-events.test.mjs` 全绿（真跑那两条用 `createChatAgent` + 桩端口，不是源码正则）；基线 `requirements-coverage.csv` 相应增行。

**已知边界（没做）**：

1. `session_end` 的粒度是「一轮」而不是 Codex 的「进程会话」——小逻的宿主没有显式会话结束信号，这里取"本轮答复交付完"作为会话边界，源码注释已写明差异；
2. ~~没接 `model_request` / `compact` / `interrupt` / `stop` 四个事件~~ → **第 7 批已补**（2026-11-16）：`model_request` 每轮第一次请求前跑一次（只观测/注入提醒，不做硬闸）；`compact` 在压缩前留痕；`interrupt` 在两个中止返回路径触发；`stop` 在交付后触发。仍存的粒度差：`model_request` 是一轮一次而不是每次请求一次，`compact` 拿不到压缩前后的 token 差值；
3. 事件型钩子只记录不回溯：`session_end` 跑完不改已交付的答复，仅留痕；
4. `permission_request` 只挂 `run_command` 一个入口（`write_file` / `apply_patch` 的写入仍由既有只读目录锁和删除双锁管），没有做成所有工具的通用审批前置。

### 3. 终端 PTY — ✅ 已攻克（2026-11-16，含降级边界）

**Codex**：`utils/pty` crate，跨平台伪终端，逐行回显 + 交互输入。

**小逻原来**：`list_sessions` 只能看退出码/TTL/保尾输出，交互会话是 `spawn` + 三根管道（isatty=false），REPL / ssh / npm 这类看 isatty 的程序行为不对。

**落地结果（2026-11-16）**：

- 新建 `app/lib/pty-adapter.ts`：`probePty()`（探测可用性与后端 conpty/openpty）+ `openPty()`（惰性加载 node-pty，`spawn` 后接 write/onData/onExit/kill/end）；`loadNodePty()` 用字符串形式的动态 import，避免打包器把它当硬依赖、也避免 CI 因为没有原生编译工具链而挂；
- `types.ts`：`CommandPort.startSession` 增加 `pty?: boolean`；`StdinSessionResult` 增加 `pty?` / `ptyNotice?`；
- `brain-sandbox.ts`：`startBrainStdinSession` 在 `opts.pty` 时先试真 PTY（成功则记录 `ptyMode: true`，输出走 `onData`）；失败/模块缺失则退回原管道实现，并把 `probePty().reason` 作为 `ptyNotice` 回流；写输入、close、TTL 回收、进程退出清场四条路径都按 `ptyMode` 分叉（PTY 写原始行、收尾先发 EOF 字节再 kill）；
- `brain-command-gate.ts` / `server-ports.ts`：`pty` 一路透传，审批仍在 `withApproval` 闸门里；
- 工具面：`run_command` 增 `pty` 参数（仅 `interactive=true` 有效），`chat-agent` 把结果写成 `【真终端】isatty=true` 或 `【真终端不可用，已降级】<原因>` 让模型知道自己在哪种会话里；
- 测试 4 条：本机无 node-pty 时 probe 如实报不可用 / 模块缺失返回 null / 假模块下 spawn 参数与读写退出回调全接通（含 EOF 字节与 kill）/ 接线断言（类型、schema、agent 透传、sandbox 降级、闸门透传），`tests/brain-pty.test.mjs` 全绿。

**已知边界（没做 / 没验）**：

1. **真 ConPTY / openpty 没有真机端到端验证**：本机与 CI 都没装 `node-pty`（原生模块不进依赖），所以真 PTY 分支只有"假模块"单测覆盖；真正跑 `npm init`、`ssh`、`node` REPL 三个场景需要先在宿主 `npm i node-pty` 再人工验；
2. 没有自动安装 node-pty：是否把它做成可选安装包（如 `npm i node-pty` 写进 README / 安装脚本）需要老板定，因为会引入原生编译依赖；
3. 没有做终端尺寸协商（cols/rows 固定 120x30）与 ANSI 颜色归一：输出按 utf8 原样回流，带颜色的 CLI 会给模型一串转义码；
4. 未接真 PTY 的窗口 resize（`terminal_resize`），交互里按列宽换行的 TUI 仍可能错行。

### 4. 子 Agent 可写 / 并行 — ✅ 已攻克（2026-11-16，并行限只读）

**Codex**：`spawn_agent` 可指定写权限、可并行派多个。

**小逻原来**：`dispatch_subagent` 只读、单任务、12 步 / 6 分钟、结论回填；子 Agent 的 `writeFile` 直接抛"只读"。

**落地结果（2026-11-16）**：

- 工具面（`chat-tools.ts`）：`dispatch_subagent` 增 `tasks`（2–3 个互不依赖的只读任务，并行跑、结论合并）与 `canWrite`（默认 false）；`required` 去掉，`task` / `tasks` 二选一；
- 执行器（`chat-agent.ts`）：`execDispatchSubagent` 拆出 `runSubagentTask(task, maxSteps, canWrite)`；并行批次用 `Promise.all`，**并行只放只读**，写任务一律串行（多个子 Agent 同时落盘会互相踩，改动也无法归属）；单个任务失败/超时都转成可读文字，不把异常抛给主循环；
- 写权限：`ports.subagent.write === true` 才允许；没开时 `canWrite=true` 直接拒绝，不偷偷降级成写。可写子 Agent 的 `writeFile` 走同一个沙箱 fs 口（路径围栏照旧），且**改动登记回主线程**：写入 `turnChangedFiles`、结论里附 `【子 Agent 改过的文件】`，交付前主线程自己核对；
- 子 Agent 仍守 read-before-write（它自己的 `readPaths` 管），且不带 `command` / `subagent` 口（防递归与越权执行）；
- `server-ports.ts` 显式声明 `subagent: { maxDepth: 1, write: true }`（写权限由宿主开关决定，默认只读能力仍保留）；
- 顺手修掉一个真 bug：子 Agent 的 6 分钟超时定时器没清，跑完还要为 timer 吊着进程不退（`clearTimeout` 放 `finally`）；
- 测试 4 条（真跑）：并行 2 任务且第二个在第一个收口前就启动（真并行）/ 宿主没开写权限时拒绝且零落盘 / 开权限后子 Agent 读→写成功且改动回流 / 只读档下写请求被挡在 fs 口外面，`tests/brain-subagent-parallel.test.mjs` 全绿。

**已知边界（没做 / 没验）**：

1. **并行只支持只读任务**：`canWrite + tasks` 会退化成串行执行；Codex 里多写 Agent 并行的冲突治理（文件锁 / 冲突合并）没有做；
2. 子 Agent 深度仍是 1（子 Agent 不带 `subagent` 口），递归派发没开；
3. 子 Agent 不能跑命令（`command` 口仍不传），需要执行的环节留主线程；
4. 并行批次没有总预算闸：3 个子 Agent 各自 12 步 / 6 分钟，token 全计回父线程，极端情况一轮能烧掉父线程大半预算（只在 config 里做了单子 Agent 的 budget 上限，没有做批次求和上限）。

### 5. MCP 企业级认证 — ✅ 代码已补齐（2026-11-16，真实 IdP 未验）

**Codex**：`rmcp-client` 支持机密客户端（client_id + client_secret，basic/post 两种端点认证）、`token_exchange`（RFC 8693 / EMA）、失败重试退避。

**小逻原来**：公开客户端 + PKCE + 30 秒提前刷新 + 401 换 token 重试一次；没有 client_secret、没有机器类 grant、token 端点失败就失败。

**落地结果（2026-11-16）**：

- `mcp-oauth.mjs` 新增机密客户端：`oauth.clientSecret` + `authMethod`（`client_secret_basic` / `client_secret_post`）；basic 走 `Authorization: Basic`，post 走表单；**secret 只在内存里拼进请求，不落盘**；只配 secret 不配 client_id / secret 为空直接报错（与 Codex 的校验一致）；
- 新增 `client_credentialsToken()`：无人值守 M2M，没有 refresh_token，过期就重取；
- 新增 `exchangeToken()` + `TOKEN_EXCHANGE_GRANT`：按 RFC 8693 发 `subject_token / subject_token_type / requested_token_type / audience / resource / scope`；subject token 来源是 `oauth.subjectToken` 或环境变量 `XIAOLUO_MCP_SUBJECT_TOKEN`，缺失时回 `needs_subject_token` 并告诉你去哪配；
- `oauthConfig` 支持 `oauth.grant`（`authorization_code` / `client_credentials` / `token_exchange`）；`ensureToken` 与 `refreshRejected` 按 grant 分叉：机器类直接重取，不再假装能 refresh；
- token 端点重试背压：只重试 408/425/429/5xx 与网络失败，最多 3 次，指数退避 300ms→封顶 5s + 抖动，服务器给了 `Retry-After` 就按它等；4xx 配置/凭据错误立即失败；
- `mcp-runtime.mjs`：机器类 grant 的 `oauth/login` 不走浏览器，直接取一次 token；缺 subject token 的提示改成"去配环境变量/写 mcp.json"，不再指路点授权；
- 测试 5 条（真跑假授权服务器）：basic 不进表单且 token 可复用 / post 表单 + 成对校验 / token_exchange 参数齐全与缺 token 提示 / 429 重试而 400 不重试且网络抖动会重试 / 机器类 401 后重取，`tests/mcp-oauth-enterprise.test.mjs` 全绿。

**已知边界（没做 / 没验）**：

1. **没有真实企业 IdP 端到端**：Linear 只验到"发现 / 动态注册 / 授权地址"，换 token 后半段仍卡在人工登录；Okta、Azure AD、Auth0 的 client_credentials / token_exchange 一次都没跑过，所以只能说"代码具备，未验证"；
2. 没做 `jwt-bearer` grant（Codex 有 `JWT_BEARER_GRANT_TYPE`）与 mTLS / DPoP；
3. 没做 `WWW-Authenticate` 的 `error="insufficient_scope"` 自动升 scope 重授权（现在只是把 scope hint 拼进授权地址）；
4. 重试退避只做 token 端点，MCP 工具调用本身的 5xx 重试仍由调用方决定；
5. 机密客户端的 secret 目前从 mcp.json 明文读（Codex 也一样），没有接系统钥匙串。

### 6. POSIX 内核沙箱

**Codex**：`landlock`（191 处）+ seatbelt，Linux/macOS 都有内核级隔离。

**小逻现状**：Windows MIC-low 真机验过；POSIX 未开工。

**改法**：Linux 接 `landlock`（bwrap 兜底），macOS 接 `sandbox-exec` 剖面；CI 加 `ubuntu-latest` 沙箱用例。

**验收**：越界读写/网络在 Linux 上真被拦，且有测试；Windows 档不回退。

（本轮按老板决定不做；上面是留给有 Linux/macOS 真机时的做法，不写空壳。）

---

## 第 7 批：六项之外的代码级差距（沙箱除外）

2026-11-16 按两边源码重扫（Codex 110 个 crate、`core/src` 144 个 `.rs`；小逻 `app/` 全量 keyword 扫描）。
判定口径：只在 Codex 有实际实现、小逻代码里 0 命中的才算"差距"。

### 已补（本轮）

| # | 能力 | 补了什么 | 证据 |
|---|---|---|---|
| 7.1 | apply_patch 语义 | ① 支持 `*** Move to: <path>`（改名 + 改内容一次做完，目标不许被占用，先落新文件再删旧文件）；② 上下文匹配由"逐行严格相等"升级到三级（逐字符 → 忽略行尾空白 → 忽略行首尾空白），与 Codex `seek_sequence` 前三级对齐；同一级命中多处仍判不唯一，绝不往更松一级猜 | `patch.ts` / `chat-agent.ts execApplyPatch`；`tests/brain-patch-and-truncation.test.mjs` 22 条（含 1 条真跑 move） |
| 7.2 | hooks 事件面 | 补齐 10 事件里的 `model_request` / `compact` / `interrupt` / `stop`：model_request 每轮第一次请求前跑一次（观测/注入提醒，不做硬闸）；compact 在压缩前留痕；interrupt 在两个中止返回路径触发；stop 在交付后触发 | `hooks.ts` / `chat-agent.ts`；`tests/brain-hooks-events.test.mjs` 8 条（含 1 条真跑断言 model_request/stop 各一次） |
| 7.3 | 出站网络代理（最小版） | 新建 `app/lib/egress-proxy.ts`：本机 HTTP 代理（只监听 127.0.0.1）、域名白名单/黑名单（黑名单优先、`*.corp.com` 后缀通配、空白名单=全拒）、CONNECT 隧道放行/拒绝、明文 HTTP 转发时按目标主机注入凭据头（token 从环境变量读，不进审计）、裁决审计（有上限）。`hooks.toml` 写 `[sandbox] egress = "proxy"` 才启用；四个命令入口（run_command / 常驻服务 / git / 交互会话）统一走 `networkEnvForUser`，`egress.allow` 与 `network_allow` 共用一份，避免两处配置打架 | `egress-proxy.ts` / `brain-sandbox.ts`；`tests/brain-egress-proxy.test.mjs` 6 条（含真跑 CONNECT 隧道 + 凭据注入） |

**7.3 已知边界**：① 没有 MITM 与证书体系，HTTPS 走 CONNECT 隧道，代理看不到明文、也不能给 HTTPS 注入凭据头（只对明文 HTTP 生效）；② 没有按进程归属统计、没有 HTTP/2 专用处理、没有 AWS SigV4 签名；③ 仍是"代理约定级"约束，raw socket / `curl --noproxy` 可绕过，进程级禁网要等内核隔离档；④ 默认关闭（不写 `egress = "proxy"` 行为与原来完全一致），因此没有做灰度开关。

### 未补（按价值排序，仍待做）

| # | 能力 | Codex 代码证据 | 小逻现状 | 价值 |
|---|---|---|---|---|
| 7.4 | MCP elicitation / resources / 连接池 | `codex-mcp/src/elicitation.rs`、`resource_client.rs`、`connection_pool.rs`、`event_stream.rs` | `mcp-runtime.mjs` 只有 tools/list + call + OAuth | 企业 MCP 服务器大量依赖 |

| 7.5 | 线程持久化（可检索、可治理） | `thread-store` 78 files / 1.44MB；`rollout` 含 compression / reverse_jsonl_scanner / reference_index / search | `event-log.ts`（7KB）+ `journal.ts`（8KB）+ sqlite 派生状态 | 长会话与回溯 |
| 7.6 | skills 隐式调用识别 | `skills`：17 files / 89KB（`invocation.rs`、`mentions.rs`、`interface.rs`、`selection.rs`） | 有 skills 加载，但靠显式调用 | 体验 |
| 7.7 | 文件索引 / 变更监听 | `app-server/src/fuzzy_file_search.rs`；`file-watcher` 56KB | `repo.ts` 只有仓库元信息 | 大仓库体验 |
| 7.8 | code-mode（写代码在受控会话里执行） | `code-mode` 33 files / 349KB（`grpc_session.rs`、`remote_session.rs`） | `code.ts` 明确"一期不执行任何代码，代码只是文件集交付物" | 架构级，需单独评估 |
| 7.9 | guardian 审查 / 异步打分 | `guardian-context` 48 files / 519KB | 无；只有命令审批 + 风险信号扫描 | 安全与合规 |
| 7.10 | 多 Agent 组织（角色/身份/图/消息板） | `agent-roles` / `agent-identity` / `agent-graph-store` / `message-board` / `runtime-agent-instance` | `debate.ts`(4KB) / `collab.ts`(2KB) 只是对话协作 | 架构级 |
| 7.11 | 凭据钥匙串 | `keyring-store` / `secrets` / `workload-identity` | 凭据走 json 文件（MCP secret 也是 mcp.json 明文） | 安全债 |
| 7.12 | 可观测性 | `otel` / `otel-trace-websocket` | 无（只有本地 gate 日志） | 运维 |
| 7.13 | 语音 / 实时会话 | `voice-host` / `realtime-webrtc` | 无 | 产品形态 |
| 7.14 | 云端任务 | `cloud-tasks` / `cloud-client` / `aws-auth` | 无（远程只有 SSH 工作区） | 形态差异，可判不追 |

---

## 复核时发现原文档两处偏差（已改）

1. 原文写"生命周期 hooks：小逻无 Codex 式钩子"——**不准确**：小逻已有 `hooks.toml` 的 PreToolUse + Post 验收 + 技能 verify，差距是"事件面窄 + 不能跑外部命令"。
2. 原文"只剩四处差距"与总表六行不一致——已统一成六项，并把"编辑语义"从"Codex 更强"细化为"实现深度差一档（没有 `@@` 上下文 diff）"。

## 取证路径

- Codex：`C:\Users\Zh\Documents\Qoder\2026-10-20\3a669cb8\codex_probe\codex-69231e119bfca0b14453515e97d99688ce1c47c9\codex-rs`
- 小逻：`D:\projects\xiaoluo ai agent OS\后台\source\app\xiaoluo-brain\lib\brain\{patch.ts,chat-tools.ts,chat-agent.ts}`
- 取证命令示例：`rg -c apply_patch codex-rs` → 223；`rg -c landlock codex-rs` → 191；`rg -c spawn_agent codex-rs` → 27。
