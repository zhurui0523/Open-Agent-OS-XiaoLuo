# Codex 比小逻更强的地方（逐个攻克清单）

口径：只列「Codex 有、小逻没有，或明显更浅」的能力。判定依据是两边源码，不是文档旧结论。
Codex 侧证据：`codex-rs`（commit `69231e1`，本机路径见文末）。小逻侧证据：本轮实测代码位置。

---

## 总表（按建议攻克顺序）

| # | 维度 | Codex 证据 | 小逻现状 | 差距性质 | 成本 | 建议 |
|---|---|---|---|---|---|---|
| 1 | 结构化补丁语义 | `apply_patch` 223 处引用；`@@` 上下文 hunk 格式 | `edit_file` 多 hunk + 三级容错；**已补 `apply_patch`**：`@@` 上下文锚点 + 一次 update/add/delete 多文件 | ✅ 已攻克（2026-11-16） | 低–中 | 已交付，见下 |
| 2 | 生命周期 hooks 事件面 | 独立 `hooks` crate：`engine/{discovery,dispatcher,command_runner}`、`events/permission_request`、`config_rules` | 已有 `hooks.toml` 的 PreToolUse 拦截 + Post 验收 + 技能 `verify`（`chat-agent.ts:992/2402`），但只有这两个点，没有 session 生命周期、权限请求、外部命令 runner | 事件面窄 | 低（2–3 小时/类事件） | 性价比最高的"扩张力"，但先做 1 |
| 3 | 终端 PTY 完整交互 | 独立 crate `utils/pty`（跨平台 portable-pty） | 只有 `list_sessions` + 保尾输出 + TTL，**逐行回显未对齐** | 真差距 | 中（跨平台依赖 + 流式回显） | 交互式命令（npm 提问、ssh、REPL）必需 |
| 4 | 子 Agent 可写 / 并行 | `spawn_agent` 27 处引用，可写、可并行 | `dispatch_subagent` 只读、单层、12 步 / 6 分钟 / 结论回填 | 真差距 | 大（要接沙箱 + 审批 + 并发治理） | 价值高但风险最高，必须排在有沙箱兜底之后 |
| 5 | MCP 企业级认证 | `rmcp-client` 里 `client_credentials` 4 处、`token_exchange` 12 处、重试退避 | 公开客户端 + PKCE + 30s 提前刷新 + 401 换 token | 深度 | 中（要先有能验的 IdP） | 等你手里有企业 IdP 再动，否则只能写空壳 |
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

**已知边界（没做）**：① `*** Move to:` 暂不支持（改写路径请用 `move_file`）——故意报错而不是静默忽略；② 执行器的"全算后落盘"只有源码断言覆盖，仓库里没有能实例化 `ChatAgent` 的运行时测试，端到端写入路径仍靠人工验；③ 写盘失败不回滚已写成功的文件（避免二次破坏），只如实回报。

### 2. hooks 事件面

**Codex**：`hooks` 是独立 crate，事件至少覆盖 session 起止、tool 前后、**权限请求**；带 discovery（从配置发现规则）与 command runner（跑外部脚本）。

**小逻现状**：`hooks.toml` 已在用，但只有 PreToolUse 拦截与 Post 验收，规则是内部结构，没有"跑外部命令"这一层。

**改法**：按需加事件（`session_start` / `session_end` / `permission_request`），并允许 hook 声明 `command`（走已有命令闸门 + 审批档），超时/失败按"不阻断"处理并留痕。

**验收**：`hooks.toml` 三事件各有测试；拦下时原因回流模型；外部命令 hook 走四档审批。

### 3. 终端 PTY

**Codex**：`utils/pty` crate，跨平台伪终端，逐行回显 + 交互输入。

**小逻现状**：`list_sessions` 只能看退出码/TTL/保尾输出，不能中途输入。

**改法**：宿主侧（桌面/服务端）引入 PTY 通道，工具面加 `terminal_input` / `terminal_read`，输出走现有 SSE；Windows 用 ConPTY，POSIX 用 `openpty`。

**验收**：真机跑 `npm init` 交互问答、`ssh` 登录、`python` REPL 三个场景。

### 4. 子 Agent 可写 / 并行

**Codex**：`spawn_agent` 可指定写权限、可并行派多个。

**小逻现状**：`dispatch_subagent` 只读、单层（子 Agent 不带该口，防递归）、12 步 / 6 分钟。

**改法**：分批——先"并行只读"（多任务同轮派发、结果聚合），再"可写但限工作区 + 每次写要审批"，最后才谈递归深度。

**验收**：并行 3 个只读任务总耗时 < 串行；可写档必须过审批闸门，且越界写被拒。

### 5. MCP 企业级认证

**Codex**：`rmcp-client` 支持 `client_credentials`、`token_exchange`（EMA 企业认证）、失败重试退避。

**小逻现状**：公开客户端 + PKCE + 刷新 + 401 重试一次。真机（Linear）已验到"发现 / 动态注册 / 授权地址"，换 token 后半段仍卡在人工登录。

**改法**：补 `client_credentials` 与 `token_exchange` 两条 grant，加重试退避（指数 + 上限）。需要真实 IdP 才能验收，否则只算"代码具备、未验证"。

### 6. POSIX 内核沙箱

**Codex**：`landlock`（191 处）+ seatbelt，Linux/macOS 都有内核级隔离。

**小逻现状**：Windows MIC-low 真机验过；POSIX 未开工。

**改法**：Linux 接 `landlock`（bwrap 兜底），macOS 接 `sandbox-exec` 剖面；CI 加 `ubuntu-latest` 沙箱用例。

**验收**：越界读写/网络在 Linux 上真被拦，且有测试；Windows 档不回退。

---

## 复核时发现原文档两处偏差（已改）

1. 原文写"生命周期 hooks：小逻无 Codex 式钩子"——**不准确**：小逻已有 `hooks.toml` 的 PreToolUse + Post 验收 + 技能 verify，差距是"事件面窄 + 不能跑外部命令"。
2. 原文"只剩四处差距"与总表六行不一致——已统一成六项，并把"编辑语义"从"Codex 更强"细化为"实现深度差一档（没有 `@@` 上下文 diff）"。

## 取证路径

- Codex：`C:\Users\Zh\Documents\Qoder\2026-10-20\3a669cb8\codex_probe\codex-69231e119bfca0b14453515e97d99688ce1c47c9\codex-rs`
- 小逻：`D:\projects\xiaoluo ai agent OS\后台\source\app\xiaoluo-brain\lib\brain\{patch.ts,chat-tools.ts,chat-agent.ts}`
- 取证命令示例：`rg -c apply_patch codex-rs` → 223；`rg -c landlock codex-rs` → 191；`rg -c spawn_agent codex-rs` → 27。
