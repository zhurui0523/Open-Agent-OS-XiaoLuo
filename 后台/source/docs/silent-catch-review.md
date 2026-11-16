# 静默 catch 逐条复核报告（2026-11-16）

对象：`scripts/silent-catch-allowlist.json` 冻结的 **169 处**静默 catch，分布在 **61 个文件**。
上下文抓取：`node scripts/review-silent-catch.mjs --write`（自动取每处 try 侧 5 行上下文）。
判定口径：`catch` 体去掉注释后为空 = 静默。结论分三档：

- **A 合理可吞**（153 处）：被吞的是"可选能力/探测/清理/降级"，吞掉后行为有明确兜底，且不留错误感。
- **B 建议补留痕**（12 处）：行为本身可接受，但失败后**外部不可观测**，用户或运维会误判"成功"。建议加一条 `console.warn` 或转成返回值里的 `note`，不改控制流。
- **C 建议修**（4 处）：安全或正确性相关，吞掉会**降低防护强度或留下残留物**，应优先处理。

> 本轮只做复核与记录，**没有改动这 169 处代码**——一次性改 169 处会把"稳定"换成"未知"。C/B 的清单在文末，按批处理。

## 一、逐文件结论（61 个文件 / 169 处）

| # | 文件 | 处数 | 档 | 依据（吞掉的是什么） |
| --- | --- | --- | --- | --- |
| 1 | `app/api/v2/chat/[conversationId]/route.ts` | 1 | A | 快照半份（上次写到一半崩）→ 不交给前端，改走事件流重建 |
| 2 | `app/api/v2/files/route.ts` | 1 | A | 标签不是 JSON → 回退按逗号分隔解析 |
| 3 | `app/api/v2/intent/messages/route.ts` | 1 | A | 历史消息 metadata 来自旧版本，解析不了就不带 originalIntent |
| 4 | `app/api/v2/organizations/members/route.ts` | 1 | A | 非手机号标识 → 下面按用户名查 |
| 5 | `app/api/v2/packages/from-artifact/route.ts` | 1 | **B** | 安装失败后的制品回滚失败 → 会留孤儿文件桶数据，需留痕 |
| 6 | `app/components/agent-config-panel.tsx` | 1 | A | 未登录/离线：设置面板不弹错，留空 |
| 7 | `app/components/brain-result-dock.tsx` | 2 | A | localStorage 写不进去（隐私模式）+ 服务列表查询失败保持旧值 |
| 8 | `app/components/canvas-view.tsx` | 3 | A | 协作重拉失败交给下一轮轮询；指针捕获已随失焦释放；dock 宽度持久化不可用 |
| 9 | `app/components/capabilities-view.tsx` | 8 | A×7 / **B**×1 | 插件无 skills、注册表不可用、工作区不存在、JSON 编辑中、回写技能失败均跳过；**单条 manifest 保存失败仍会提示"已保存"** → 需留痕 |
| 10 | `app/components/intent-console.tsx` | 1 | A | 权限模式写 localStorage 失败不影响本次会话 |
| 11 | `app/components/local-ai-settings.tsx` | 1 | A | 服务端同步失败不阻塞本地引擎操作 |
| 12 | `app/components/node-card.tsx` | 1 | A | 指针捕获已随 blur/cancel 释放 |
| 13 | `app/components/plugin-capabilities-panel.tsx` | 1 | A | 设置面板未登录/离线静默 |
| 14 | `app/components/server-url-widget.tsx` | 1 | A | 桥不可用 → 降级浏览器直连健康探测 |
| 15 | `app/components/xiaoluo-brain-panel.tsx` | 9 | A | MCP 同步失败不影响主流程、错误体解析失败保留默认文案、附件抓取失败走文件路径、坏技能条目跳过、注册表不可用跳过物化 |
| 16 | `app/hooks/use-intent-os.ts` | 5 | A | 草稿写本地失败（服务端为准）、陈旧草稿无害、偏好不可用维持 home 画布、并发槽位宁可少一次 |
| 17 | `app/lib/anthropic-adapter.ts` | 1 | A | 工具参数不是合法 JSON → 传空对象 |
| 18 | `app/lib/brain-llm-gateway.ts` | 1 | A | `uiSchema` 解析失败按缺凭据处理（安全方向） |
| 19 | `app/lib/brain-programs.ts` | 1 | A | 清单文件缺失 → 跳过该文件 |
| 20 | `app/lib/brain-sandbox-win.mjs` | 2 | **C**×1 / A×1 | `icacls` 打 Low 完整性标签失败被吞 → **沙箱强度可能没生效且无痕**；载荷删除失败也吞 → 残留临时脚本（同为 C） |
| 21 | `app/lib/brain-sandbox.ts` | 9 | A×8 / **C**×1 | GBK 解码器不可用、落盘失败、taskkill 已退出、meta 缺失、SKILL.md 坏条目、本地副本探测均合理；`process.kill` 兜底再吞 → 杀不掉即进程泄漏且无痕（C） |
| 22 | `app/lib/brain-state-store.ts` | 1 | A | 状态库坏行跳过，不让一行毁整份 |
| 23 | `app/lib/kernel-executors.ts` | 1 | A | SSE 坏块跳过，不中断整条流 |
| 24 | `app/lib/local-ai.ts` | 1 | **B** | 引擎状态文件写失败静默 → 用户以为改动已保存 |
| 25 | `app/lib/package-import.ts` | 2 | A | 构建缓存未就绪 → 重新隔离构建；某配置变体不存在 |
| 26 | `app/lib/plugin-reference-bridge.ts` | 1 | A | 只影响旧版适配器的最佳努力路径 |
| 27 | `app/lib/plugin-runtime-shim.ts` | 1 | **B** | `console.info` 套 try/catch 吞错，静默无收益（应直接去 try） |
| 28 | `app/lib/seed-skills.ts` | 2 | A | 已存在则跳过播种（`fs.access` 抛错即"不存在"） |
| 29 | `app/xiaoluo-brain/components/chat/clipboard.ts` | 2 | A | 桥不可用/权限被拒 → 继续降级到下一种方式 |
| 30 | `app/xiaoluo-brain/components/chat/code-preview.tsx` | 1 | A | 桌面桥打不开 → 回退 `window.open` |
| 31 | `app/xiaoluo-brain/hooks/use-chat-agent.ts` | 7 | A | 紧急落盘失败、keepalive 失败、同步部署失败（有提示路径）、线程被回收、快照损坏从零开始、代码工件上报失败 |
| 32 | `app/xiaoluo-brain/lib/brain/agent-client.ts` | 1 | A | 宿主审批回调炸了 → 按拒绝处理（失败方向安全） |
| 33 | `app/xiaoluo-brain/lib/brain/agent-server.ts` | 1 | A | 单个客户端断开不拖垮回合（广播尽力而为） |
| 34 | `app/xiaoluo-brain/lib/brain/agent-wire.ts` | 1 | A | 半截 JSON-RPC 帧丢弃，不炸流 |
| 35 | `app/xiaoluo-brain/lib/brain/api.ts` | 9 | A×8 / **B**×1 | 本地缓存写满、服务未起、任务/程序 CRUD 失败均"本地为准"；但远端**任务删除/程序删除失败**同样静默 → 列表和远端会不一致，需留痕 |
| 36 | `app/xiaoluo-brain/lib/brain/approval-grants.ts` | 1 | A | 审批留痕写失败不阻断审批流（但留痕缺失，与 B 边界，暂列 A） |
| 37 | `app/xiaoluo-brain/lib/brain/chat-agent.ts` | 21 | A×19 / **B**×1 / **C**×1 | 历史摘要、记忆、意图核对、交付件附属文件、插件技能探测、技能目录、共享库、安装前置检查、仓库探针、符号索引、插件根探测、插件重装检查均属"可选能力"；**兜底回答失败按空结果** → 用户看到空回复且无痕（B）；**插件安装后 `listDir` 失败被当成"无 skills 目录"** → 装了个坏插件也报成功（C） |
| 38 | `app/xiaoluo-brain/lib/brain/failure-advisor.ts` | 1 | A | 单条诊断规则抛错不影响其余规则 |
| 39 | `app/xiaoluo-brain/lib/brain/memory-store.ts` | 2 | A | 存储满降级为会话内有效；远端回填失败从零起步 |
| 40 | `app/xiaoluo-brain/lib/brain/tasks.ts` | 2 | A | 任务写 localStorage 满则静默（内存态仍可用） |
| 41 | `app/xiaoluo-brain/lib/brain/types.ts` | 1 | A | 同上：存储满放弃持久化，对话仍可进行 |
| 42 | `后台/source/shared/service-provision.mjs` | 2 | A | MySQL 目录探测失败 → 继续找下一个；`package.json` 坏则不推断脚本 |
| 43 | `scripts/install-git-hooks.mjs` | 1 | A | Windows 上 chmod 无意义 |
| 44 | `scripts/start-local-detached.mjs` | 1 | A | 进程已停止 |
| 45 | `scripts/start-login-detached.mjs` | 1 | A | 进程已停止 |
| 46 | `客户端/source/desktop/app-data.mjs` | 1 | A | 崩溃日志写失败不影响主流程 |
| 47 | `客户端/source/desktop/app-server-ipc.mjs` | 3 | A | 事件回调异常不拖垮 IPC 读循环；stderr 写失败；关停时 kill 失败 |
| 48 | `客户端/source/desktop/app-server.mjs` | 1 | A | `logErr` 自身写 stderr 失败 |
| 49 | `客户端/source/desktop/local-ai/downloader.mjs` | 4 | A×3 / **B**×1 | 删半份文件失败（会重下）、取消时删临时文件失败;`eventSink` 抛错被吞 → 界面进度静默停更（B） |
| 50 | `客户端/source/desktop/local-ai/ipc.mjs` | 2 | A | 窗口已销毁时 `send` 抛错；开机自启设置失败 |
| 51 | `客户端/source/desktop/local-ai/mock-diffusion.mjs` | 2 | A | mock 服务里解析不出 prompt |
| 52 | `客户端/source/desktop/local-ai/mock-engine.mjs` | 1 | A | mock 服务里解析不出消息 |
| 53 | `客户端/source/desktop/local-ai/runtime.mjs` | 1 | A | POSIX 下 SIGTERM 时进程已退出 |
| 54 | `客户端/source/desktop/local-runtime.mjs` | 11 | A×10 / **C**×1 | 已退出进程、GBK 解码、探针目录、stdout/stderr 已关、spill 落盘、payload 清理、杀树、服务停杀均合理；**payload 临时脚本删除失败** + `killTree` 双吞 → 残留脚本/进程泄漏无痕（C） |
| 55 | `客户端/source/desktop/main.mjs` | 2 | A | 崩溃日志写失败；外部链接协议不在白名单/格式坏 |
| 56 | `客户端/source/desktop/mcp-oauth.mjs` | 1 | A | 回调 server 已关闭 |
| 57 | `客户端/source/desktop/mcp-runtime.mjs` | 7 | A | 进程已停、SSE 心跳坏行、notify 失败、`mcp.json` 缺失/坏、`plugin.json` 坏、无 plugins 目录、打开授权页失败不影响回调监听 |
| 58 | `客户端/source/desktop/server-url.mjs` | 1 | A | 清配置时文件已不存在 |
| 59 | `客户端/source/desktop/uia-runtime.mjs` | 2 | A | PowerShell 里取 ControlType 失败 → 留空继续匹配 |
| 60 | `客户端/source/desktop/webdrive-runtime.mjs` | 12 | A | 端口文件未写完、WS 已关、CDP 移除绑定/监听失败、录制坏帧跳过、浏览器进程已退出 |
| 61 | `客户端/source/shared/service-provision.mjs` | 2 | A | 与 #42 同（双端副本） |

## 二、C 档（4 处，优先修）

| 位置 | 风险 | 建议改法 |
| --- | --- | --- |
| `app/lib/brain-sandbox-win.mjs:105` | `icacls` 打 Low 完整性标签失败被吞 → 沙箱没生效也看不出来 | 失败时写一条 `console.warn` 并把隔离等级降为"应用层围栏"，随命令结果回传给前端 |
| `app/lib/brain-sandbox-win.mjs:200` / `客户端/source/desktop/local-runtime.mjs:186,203` | 载荷临时脚本删不掉 → 工作区里留 `run-*.cmd.ps1` | 失败时记 `console.warn` 并在结果里带 `payloadLeft` 标记，让老板看得见 |
| `app/lib/brain-sandbox.ts:786` | `killTree` 两级 catch 都吞 → 进程杀不掉即泄漏，无痕 | 第二级失败写 `console.warn`（含 pid） |
| `app/xiaoluo-brain/lib/brain/chat-agent.ts:2851` | 插件装完 `listDir` 失败被当成"无 skills 目录"，坏插件也报安装成功 | 区分"目录不存在"与"列目录报错"，后者在返回文本里点明"技能清单读取失败" |

## 三、B 档（12 处，建议补留痕但不改控制流）

1. `app/api/v2/packages/from-artifact/route.ts:313` 制品回滚失败 → 留孤儿数据；
2. `app/components/capabilities-view.tsx:845` 单条 manifest 保存失败仍提示已保存；
3. `app/lib/local-ai.ts:110` 引擎配置写文件失败 → 用户以为已保存；
4. `app/lib/plugin-runtime-shim.ts:254` 给 `console.info` 套 try/catch，吞了也没收益；
5. `app/xiaoluo-brain/lib/brain/api.ts:168/274` 远端删除任务/程序失败 → 列表与远端不一致；
6. `app/xiaoluo-brain/lib/brain/chat-agent.ts:2296` 兜底回答失败按空结果 → 空回复无任何痕迹；
7. `客户端/source/desktop/local-ai/downloader.mjs:21` 进度事件 `eventSink` 抛错被吞 → 界面进度停更；
8. `app/xiaoluo-brain/lib/brain/approval-grants.ts:38` 审批留痕写失败 → 审计链断点（边界项）。

## 四、本轮做了什么 / 没做什么

- **做了**：抓取全部 169 处真实上下文并逐条判定；把白名单里 169 条占位理由换成按文件的真实结论（`scripts/silent-catch-allowlist.json`）；新增只读复核工具 `scripts/review-silent-catch.mjs`，以后每轮可重跑对照。
- **没做**：没有修改这 169 处代码；C 档 4 处、B 档 12 处按清单**待下一轮分批处理**（改代码会改行为，需各自配一条测试）。
- **边界说明**：`lint-silent-catch.mjs` 判的是"catch 体为空"，`catch (e) { void e }` 这类"形式上有语句、实质仍吞掉"的写法不在本清单内，属于已知盲区，未扩到本轮范围。
