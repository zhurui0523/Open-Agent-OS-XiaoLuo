/**
 * 小逻 v3 —— useChatAgent hook（对话型小逻的宿主接线）
 *
 * 替换对象：use-brain.ts（规划型，已随"小逻大脑对话规划"整体移除）。
 *
 * 职责：
 *  1. 持有 ChatAgent 实例（每个对话一个，随 conversationId 切换）
 *  2. 把 Agent 的 UI 事件（正文/旁白/代码卡/预览卡/媒体卡/反问卡）映射到消息流
 *  3. 提供 send / answerAsk / steer / stop 交互入口
 *  4. 对话历史落盘：默认 localStorage，ChatStore 接缝可换服务端实现（路线图⑦）
 *  5. 任务档案（路线图④）：每轮后自动维护 active 任务的时间线与产物引用
 *
 * 集成点（ChatAdapters）：
 *  - callLLM：模型网关（需支持 tool calling；流中断抛 BrainLLMError）
 *  - generateMedia：画布节点直派（接 startRunServer，无计划确认）
 *  - webSearch / consultHistory / fs / command / git / browser：可选口，
 *    不实现则对应工具不注册，自动降级
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatAgent, DEFAULT_CHAT_AGENT_CONFIG } from "../lib/brain/chat-agent";
import type {
  ChatAgentPorts,
  ChatTurnOutcome,
  ChatUIKind,
} from "../lib/brain/chat-agent";
import type { GenerateMediaArgs } from "../lib/brain/chat-tools";
import type { PreviewDocument } from "../lib/brain/preview";
import { buildPreviewDocument, isPreviewable } from "../lib/brain/preview";
import { buildXiaoluoChatPrompt } from "../lib/brain/prompts";
import type { DeployProgramResult } from "../lib/brain/types";
import { appendTimeline, createTask, LocalStorageTaskStore } from "../lib/brain/tasks";
import type { TaskRecord, TaskStore } from "../lib/brain/tasks";
import { HybridMemoryStore } from "../lib/brain/memory-store";
import { HttpMemoryMirror, HttpProgramStore } from "../lib/brain/api";
import { LocalStorageChatStore } from "../lib/brain/types";
import type {
  AskUserAnswer,
  AskUserRequest,
  BrowserPort,
  ChatMessage,
  ChatPersistence,
  ChatStore,
  CodeArtifact,
  CommandPort,
  FileSystemPort,
  GitPort,
  McpPort,
  NodeRunResult,
  ServicePort,
} from "../lib/brain/types";

// ---------- 适配层 ----------

export interface ChatAdapters {
  /** LLM 网关（OpenAI 兼容 tool calling） */
  callLLM: ChatAgentPorts["callLLM"];
  /** 画布媒体生成：直派节点执行并等结果（接 startRunServer + 轮询） */
  generateMedia?: (req: GenerateMediaArgs) => Promise<NodeRunResult>;
  /** 联网检索（可选） */
  webSearch?: (query: string) => Promise<string>;
  /** 历史检索（可选，首轮注入） */
  consultHistory?: (goal: string) => Promise<string>;
  /** 文件系统（可选：read_file / list_dir / write_file） */
  fs?: FileSystemPort;
  /** MCP 外部工具（可选：mcp__<server>__<tool> 动态注册） */
  mcp?: McpPort;
  /** 受控命令（可选：run_command，建议宿主接 sandbox.ts 分级闸门） */
  command?: CommandPort;
  /** 服务管理（可选：二期 start_service / stop_service / service_status） */
  service?: ServicePort;
  /** 仓库（可选：git status/log/diff/commit） */
  git?: GitPort;
  /** 网页浏览（可选：browse_page） */
  browser?: BrowserPort;
  /** 能力清单文本（capabilities 注册表 → 每行一个 Skill/模型） */
  capabilityCatalog: string;
  /** 本机落盘口（deploy_program；桌面端适配器提供，缺省则工具不注册） */
  deployProgram?(artifact: CodeArtifact, name?: string): Promise<DeployProgramResult>;
  /** 小逻所用模型 id */
  model: string;
}

/** hook 选项：默认 localStorage，接服务端时替换（路线图⑦） */
export interface UseChatAgentOptions {
  /** 对话持久化口（P1 迁服务端只需换实现） */
  store?: ChatStore;
  /** 任务档案持久化口 */
  taskStore?: TaskStore;
}

// ---------- 对话消息流类型 ----------

export type ChatUIMessageKind =
  | "user" //         老板输入
  | "assistant" //    小逻正文
  | "status" //       过程旁白（弱化）
  | "code-card" //    代码卡：查看/复制/下载/预览入口
  | "preview-card" // 预览卡：沙箱 iframe 渲染效果
  | "media-card" //   媒体结果卡
  | "ask-card" //    反问卡
  | "delivery-card" // 交付卡（deploy/package 落盘凭据）
  | "plan-card"; //    规划卡（todo_write 任务清单）

/** 用户消息随附素材：气泡按类型直接渲染本体（图片/视频/音频/文本） */
export interface ChatUserMediaRef {
  kind: "image" | "video" | "audio" | "text" | "other";
  url: string;
  name: string;
}

export interface ChatUIMessage {
  id: string;
  kind: ChatUIMessageKind;
  content: string;
  /** user 消息随附素材（仅界面渲染用；Agent 仍靠【附件】文本取文件） */
  media?: ChatUserMediaRef[];
  /** code-card 附带 */
  artifact?: CodeArtifact;
  /** preview-card 附带 */
  preview?: PreviewDocument;
  /** media-card 附带 */
  result?: NodeRunResult;
  /** ask-card 附带 */
  ask?: AskUserRequest;
  /** Codex 式时间线的结构化事件元信息（tool/target/ok/files 等） */
  meta?: Record<string, unknown>;
  /** 所属回合（任务卡分组用）；旧存档可能缺失 */
  turnId?: number;
  createdAt: number;
}

export type ChatPhase = "idle" | "thinking" | "waiting-ask";

let seq = 0;
const nextId = () => `cm-${Date.now()}-${++seq}`;

// ---------- Hook 主体 ----------

export function useChatAgent(
  conversationId: string,
  adapters: ChatAdapters,
  options?: UseChatAgentOptions,
) {
  const [messages, setMessages] = useState<ChatUIMessage[]>([]);
  /** persist 需最新消息流（state 闭包是旧值，用 ref） */
  const messagesRef = useRef<ChatUIMessage[]>(messages);
  messagesRef.current = messages;
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [lastTurn, setLastTurn] = useState<ChatTurnOutcome | null>(null);
  /** AUTO-RESUME 预算耗尽自动续跑次数（老板新发消息即重置；对话切换后不再续） */
  const autoResumeRef = useRef(0);
  const sendCidRef = useRef(conversationId);
  /** 当前对话的任务档案（长周期项目看板素材，路线图④） */
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);

  const agentRef = useRef<ChatAgent | null>(null);
  /** 持久化口（默认 localStorage；传 store 则走服务端实现） */
  const storeRef = useRef<ChatStore>(options?.store ?? new LocalStorageChatStore());
  storeRef.current = options?.store ?? storeRef.current;
  const taskStoreRef = useRef<TaskStore>(options?.taskStore ?? new LocalStorageTaskStore());
  taskStoreRef.current = options?.taskStore ?? taskStoreRef.current;
  /** 长期记忆（跨对话）：本地真相 + 服务端镜像（B5），管理权在老板（面板可查/删） */
  const memoryStoreRef = useRef(new HybridMemoryStore(new HttpMemoryMirror({ base: "" })));
  /** 程序库落盘口：write_code 成功 → 自动保存（服务未启动时静默降级） */
  const programStoreRef = useRef(new HttpProgramStore({ base: "" })); // 同源：默认 3001 无服务，写死会静默全丢
  /** 任务档案镜像：落盘时以任务标题作程序名 */
  const currentTaskRef = useRef<TaskRecord | null>(null);
  /** AUTO-SVC-SYNC：本对话启动的服务（产物变化后自动重启的目标；null = 未启动/已停止） */
  const linkedServiceRef = useRef<{ id: string; command: string; cwd?: string } | null>(null);
  const svcSyncTimerRef = useRef<number | null>(null);
  const svcSyncBusyRef = useRef(false);
  /** AUTO-SVC-SYNC：同步成功后递增 → 浏览器页签 iframe 强制重载 */
  const [svcSyncNonce, setSvcSyncNonce] = useState(0);

  /** adapters 走 ref：引用变化（如模型列表刷新）不得触发“对话切换”效应把消息清空；
   * 每次调用时读取最新值，模型/能力变化下一轮自动生效 */
  const adaptersRef = useRef(adapters);
  adaptersRef.current = adapters;

  useEffect(() => {
    currentTaskRef.current = currentTask;
  }, [currentTask]);


  /** persist 的前向引用：ports 构造在 makeAgent 里，需先声明 */
  const persistRef = useRef<((extra?: Partial<ChatPersistence>) => void) | null>(null);
  /** 流式输出占位消息 id：delta 增量更新同一条；end/定稿落帐时收口 */
  const streamMsgIdRef = useRef<string | null>(null);
  /** streamUI.end() 刚收口的占位气泡 id：定稿 postUI 在 end 之后才跑，靠它找回气泡原地定稿，防重复贴第二条 */
  const endedStreamIdRef = useRef<string | null>(null);
  /** 挂起快照的保存入口（Agent 中断/挂起时调用） */
  const persist = useCallback(
    (extra?: Partial<ChatPersistence>) => {
      const agent = agentRef.current;
      if (!agent) return;
      const snap = agent.serialize();
      const data: ChatPersistence = {
        lastCode: snap.lastCode ?? undefined,
        version: 1,
        conversationId,
        messages: snap.messages,
        usedTokens: snap.usedTokens,
        uiMessages: messagesRef.current,
        // 断点续跑：goal / 改完必跑账 / 读后写账随存档落盘（旧存档无字段即空）
        goal: snap.goal ?? undefined,
        dirtyCodeFiles: snap.dirtyCodeFiles?.length ? snap.dirtyCodeFiles : undefined,
        readPaths: snap.readPaths?.length ? snap.readPaths : undefined,
        savedAt: Date.now(),
        ...extra,
      };
      storeRef.current.save(conversationId, data).catch(() => {
        /* 存档失败不阻断对话（实现内部也已降级） */
      });
    },
    [conversationId],
  );
  persistRef.current = persist;

  /** 紧急落盘：页面闪动/热重载/误刷新不丢消息——同步写 localStorage + keepalive 补传服务端 */
  const emergencyPersist = useCallback(() => {
    const agent = agentRef.current;
    const data: ChatPersistence = {
      version: 1,
      conversationId,
      messages: agent?.serialize().messages ?? [],
      usedTokens: agent?.serialize().usedTokens ?? 0,
      uiMessages: messagesRef.current,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(`xiaoluo-chat:${conversationId}`, JSON.stringify(data));
    } catch { /* 存储满跳过 */ }
    try {
      void fetch(`/api/v2/chat/${encodeURIComponent(conversationId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive: true,
      }).catch(() => {});
    } catch { /* 网络不可用跳过 */ }
  }, [conversationId]);

  // 页面卸载补存：dev 热重载/误刷新时不丢最新几条消息
  useEffect(() => {
    const onGone = () => emergencyPersist();
    window.addEventListener("pagehide", onGone);
    window.addEventListener("beforeunload", onGone);
    return () => {
      window.removeEventListener("pagehide", onGone);
      window.removeEventListener("beforeunload", onGone);
    };
  }, [emergencyPersist]);

  // 执行中每秒周期存档：流式进行中的消息实时落盘，闪断恢复后仍在
  useEffect(() => {
    if (phase !== "thinking") return;
    const timer = window.setInterval(() => persistRef.current?.(), 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  /** 轮末任务档案维护：确保有 active 任务 → 抽 journal 时间线 → 存盘 */
  const recordTaskTurn = useCallback(
    async (firstUserText: string) => {
      const agent = agentRef.current;
      if (!agent) return;
      const store = taskStoreRef.current;
      let task =
        (await store.list()).find(
          (t) => t.status === "active" && t.conversationIds.includes(conversationId),
        ) ?? null;
      if (!task) {
        task = createTask(firstUserText || "新任务", conversationId);
      }
      appendTimeline(task, agent.journal.recent(8).map((e) => ({ ts: e.ts, note: e.note })));
      await store.save(task);
      setCurrentTask(task);
    },
    [conversationId],
  );

  /**
   * AUTO-SVC-SYNC：产物变化（write_code / 手改回写）→ 防抖 2 秒 → 同步到运行中的服务。
   * 链路：最新产物写回部署目录 → 停旧服务 → 同命令/同 cwd 重启 → nonce+1 刷新浏览器页签。
   * 只认「本对话启动的服务」（service 口包装时记录）；无服务/服务已停则静默跳过。
   */
  const scheduleServiceSync = useCallback(() => {
    if (svcSyncTimerRef.current !== null) window.clearTimeout(svcSyncTimerRef.current);
    svcSyncTimerRef.current = window.setTimeout(() => {
      svcSyncTimerRef.current = null;
      if (svcSyncBusyRef.current) { scheduleServiceSync(); return; } // 上一次同步在途：顺延
      void (async () => {
        const svc = linkedServiceRef.current;
        const fsPort = adaptersRef.current.fs;
        const service = adaptersRef.current.service;
        const artifact = agentRef.current?.getCurrentArtifact();
        if (!svc || !fsPort || !service || !artifact || !artifact.files.length) return;
        svcSyncBusyRef.current = true;
        const pushNote = (content: string, ok: boolean) => {
          const note: ChatUIMessage = {
            id: nextId(),
            kind: "status",
            content,
            meta: { tool: "auto_svc_sync", ok },
            turnId: agentRef.current?.turnId,
            createdAt: Date.now(),
          };
          messagesRef.current = [...messagesRef.current, note];
          setMessages((prev) => [...prev, note]);
        };
        try {
          // 服务可能已被老板停掉 / TTL 过期：重启前先核实，不复活已死的服务
          const rows = await service.status(svc.id);
          const rec = rows.find((r) => r.id === svc.id);
          if (!rec || rec.status === "exited") {
            linkedServiceRef.current = null;
            return;
          }
          // 最新产物写回部署目录（与 deploy_program 落盘处一致；相对路径即相对工作区）
          const base = svc.cwd ? svc.cwd.replace(/\/+$/, "") + "/" : "";
          for (const f of artifact.files) {
            await fsPort.writeFile(base + f.path, f.content);
          }
          // 运行中的进程无法原地换代码：停旧 → 同命令/同 cwd 重启
          await service.stop(svc.id);
          const fresh = await service.start(svc.command, { cwd: svc.cwd });
          if (fresh.status === "exited") {
            linkedServiceRef.current = null;
            pushNote("自动同步未完成：服务重启后即退出（exit " + (fresh.exitCode ?? "?") + "），可让小逻检查启动日志。", false);
            return;
          }
          linkedServiceRef.current = { id: fresh.id, command: svc.command, cwd: svc.cwd };
          setSvcSyncNonce((n) => n + 1);
          pushNote("已把最新代码同步到部署目录并自动重启服务，浏览器页签已刷新。", true);
        } catch {
          /* 同步失败不挡主流程：服务保持旧代码，老板可手动重启或让小逻处理 */
        } finally {
          svcSyncBusyRef.current = false;
        }
      })();
    }, 2_000);
  }, []);

  const makeAgent = useCallback(
    (cid: string, restoreMessages?: ChatMessage[], restoreLastCode?: CodeArtifact) => {
      const ports: ChatAgentPorts = {
        // 调用期动态取适配器：老板切换模型后，已创建的 Agent 下一请求即用新模型
        callLLM: (req) => adaptersRef.current.callLLM(req),
        generateMedia: adaptersRef.current.generateMedia
          ? (args) => adaptersRef.current.generateMedia!(args)
          : undefined,
        postUI: (kind: ChatUIKind, content: string, meta?: Record<string, unknown>) => {
          // 流式定稿去重：刚打完字的流占位气泡（含 end 刚收口的）→ 原地定稿，不再贴新消息
          if (meta?.fromStream) {
            const sid = streamMsgIdRef.current ?? endedStreamIdRef.current;
            if (sid) {
              streamMsgIdRef.current = null;
              endedStreamIdRef.current = null;
              messagesRef.current = messagesRef.current.map((x) =>
                x.id === sid ? { ...x, kind, content, meta: { ...x.meta, streaming: false } } : x,
              );
              setMessages((prev) => prev.map((x) =>
                x.id === sid ? { ...x, kind, content, meta: { ...x.meta, streaming: false } } : x,
              ));
              return;
            }
          }
          const msg: ChatUIMessage = {
            id: nextId(),
            kind,
            content,
            artifact: kind === "code-card" ? (meta?.artifact as CodeArtifact) : undefined,
            meta,
            turnId: agentRef.current?.turnId,
            preview: kind === "preview-card" ? (meta?.preview as PreviewDocument) : undefined,
            result: kind === "media-card" ? (meta?.result as NodeRunResult) : undefined,
            ask: kind === "ask-card" ? (meta?.ask as AskUserRequest) : undefined,
            createdAt: Date.now(),
          };
          // 同步入 ref：渲染是异步的，中断/收尾瞬间的 persist 必须能读到最新消息，
          // 否则最后几条回复会被旧快照回滚掉（“回复消失”的直接根因）
          messagesRef.current = [...messagesRef.current, msg];
          setMessages((prev) => [...prev, msg]);
          // 反问挂起：立刻存档 pendingAsk，刷新后能重新挂回卡片
          if (kind === "ask-card" && meta?.ask) {
            persistRef.current?.({ pendingAsk: meta.ask as AskUserRequest });
          }
          // AUTO-SVC-SYNC：write_code 产出新产物 → 防抖同步到本对话跑着的服务
          if (kind === "code-card") scheduleServiceSync();
        },
        /** 流式 UI 通道：begin 挂占位气泡，delta 逐字增长，end 收口（定稿由 postUI fromStream 去重） */
        streamUI: {
          begin: () => {
            const id = nextId();
            streamMsgIdRef.current = id;
            endedStreamIdRef.current = null;
            const msg: ChatUIMessage = {
              id,
              kind: "assistant",
              content: "",
              meta: { streaming: true },
              turnId: agentRef.current?.turnId,
              createdAt: Date.now(),
            };
            messagesRef.current = [...messagesRef.current, msg];
            setMessages((prev) => [...prev, msg]);
          },
          delta: (t: string) => {
            const sid = streamMsgIdRef.current;
            if (!sid || !t) return;
            messagesRef.current = messagesRef.current.map((x) =>
              x.id === sid ? { ...x, content: x.content + t } : x,
            );
            setMessages((prev) => prev.map((x) =>
              x.id === sid ? { ...x, content: x.content + t } : x,
            ));
          },
          end: () => {
            const sid = streamMsgIdRef.current;
            streamMsgIdRef.current = null;
            if (!sid) return;
            // 流断且无定稿兑现（中断/重试路径）：占位气泡空则删，有内容则只摘掉光标
            const last = messagesRef.current[messagesRef.current.length - 1];
            if (last && last.id === sid && !last.content) {
              messagesRef.current = messagesRef.current.filter((x) => x.id !== sid);
              setMessages((prev) => prev.filter((x) => x.id !== sid));
              return;
            }
            endedStreamIdRef.current = sid;
            messagesRef.current = messagesRef.current.map((x) =>
              x.id === sid ? { ...x, meta: { ...x.meta, streaming: false } } : x,
            );
            setMessages((prev) => prev.map((x) =>
              x.id === sid ? { ...x, meta: { ...x.meta, streaming: false } } : x,
            ));
          },
        },
        webSearch: adaptersRef.current.webSearch,
        consultHistory: adaptersRef.current.consultHistory,
        fs: adaptersRef.current.fs,
        command: adaptersRef.current.command,
        /** AUTO-SVC-SYNC：包装服务口，记录「本对话启动的服务」（产物变化自动重启的目标） */
        service: adaptersRef.current.service
          ? {
              start: async (command, opts) => {
                const info = await adaptersRef.current.service!.start(command, opts);
                if (info.status !== "exited") {
                  linkedServiceRef.current = { id: info.id, command, cwd: opts?.cwd };
                }
                return info;
              },
              stop: async (id) => {
                const info = await adaptersRef.current.service!.stop(id);
                if (linkedServiceRef.current?.id === id) linkedServiceRef.current = null;
                return info;
              },
              status: (id) => adaptersRef.current.service!.status(id),
              setup: adaptersRef.current.service.setup
                ? (payload) => adaptersRef.current.service!.setup!(payload)
                : undefined,
            }
          : undefined,
        git: adaptersRef.current.git,
        browser: adaptersRef.current.browser,
        deployProgram: adaptersRef.current.deployProgram,
        /** 长期记忆口：add_memory 工具 + 首轮注入 */
        memory: memoryStoreRef.current,
        /** 程序库自动落盘：按对话 upsert，程序名取任务标题（失败静默降级） */
        saveProgram: async (artifact) => {
          await programStoreRef.current.save({
            conversationId: cid,
            name: currentTaskRef.current?.title || "未命名程序",
            entry: artifact.entryFile ?? artifact.files[0]?.path,
            files: artifact.files,
          });
        },
      };
      return new ChatAgent(
        {
          config: DEFAULT_CHAT_AGENT_CONFIG,
          ports,
          model: adaptersRef.current.model,
          conversationId: cid,
          systemPrompt: buildXiaoluoChatPrompt(adaptersRef.current.capabilityCatalog, {
            localExecution: typeof window !== "undefined" && Boolean((window as unknown as { xiaoluoDesktop?: unknown }).xiaoluoDesktop),
          }),
        },
        restoreMessages,
        restoreLastCode,
      );
    },
    [],
  );

  // 对话切换：重建 Agent 并恢复历史（含挂起反问与中断断点）
  useEffect(() => {
    agentRef.current = null;
    messagesRef.current = []; // 同步清 ref：切换窗口内首次渲染前的 persist 不会把旧对话写进新对话
    setMessages([]);
    setPhase("idle");
    setLastTurn(null);
    setCurrentTask(null);

    // 恢复本对话的任务档案（看板展示用）+ 历史快照；存储口现为异步（HTTP/localStorage 同契约）
    let cancelled = false;
    (async () => {
      try {
        const task = (await taskStoreRef.current.list()).find(
          (t) => t.status === "active" && t.conversationIds.includes(conversationId),
        );
        if (task && !cancelled) setCurrentTask(task);
      } catch {
        /* 静默 */
      }

      try {
        const snap = await storeRef.current.load(conversationId);
        if (!snap || cancelled) return;

        const restored: ChatUIMessage[] = [];
        const savedUI = Array.isArray(snap.uiMessages) ? (snap.uiMessages as ChatUIMessage[]) : null;
        if (savedUI) {
          // 旧存档里遗留的"对话存档已恢复"占位卡不再展示：对话内容本身常驻
          restored.push(...savedUI.filter((m) => !(m.kind === "status" && m.meta && m.meta.tool === "session_restored")));
        }
        if (snap.pendingAsk && !(savedUI?.some((m) => m.kind === "ask-card"))) {
          restored.push({
            id: nextId(),
            kind: "ask-card",
            content: snap.pendingAsk.question,
            ask: snap.pendingAsk,
            createdAt: snap.savedAt,
          });
        }
        // 中断不再插占位卡：历史消息原样常驻，老板直接发消息接着聊
        // 上次代码产物：重建代码卡（结果面板刷新/重建后不丢）
        if (snap.lastCode && !savedUI) {
          restored.push({
            id: nextId(),
            kind: "code-card",
            content: "已恢复上次的代码产物",
            artifact: snap.lastCode,
            createdAt: snap.savedAt,
          });
          // 预览 srcDoc 不存档：由产物直接推导重建，刷新/重建后结果预览不丢
          if (isPreviewable(snap.lastCode)) {
            const preview = buildPreviewDocument(snap.lastCode);
            restored.push({
              id: nextId(),
              kind: "preview-card",
              content: `预览：${preview.title}`,
              preview,
              meta: {
                files: snap.lastCode.files.map((f) => ({ path: f.path, language: f.language, chars: f.content.length })),
              },
              createdAt: snap.savedAt,
            });
          }
        }
        messagesRef.current = restored; // 同步回写 ref：恢复后首次渲染前若触发 persist，不能用空流覆盖历史
        setMessages(restored);
        setPhase(snap.pendingAsk ? "waiting-ask" : "idle");
        const resumedAgent = makeAgent(conversationId, snap.messages, snap.lastCode);
        // 断点续跑：goal / 待验证文件 / 读后写账从存档还原（旧存档无字段则无操作）
        resumedAgent.resumeFrom({ goal: snap.goal ?? null, dirtyCodeFiles: snap.dirtyCodeFiles, readPaths: snap.readPaths });
        agentRef.current = resumedAgent;

        // 程序库补存：落盘只在 write_code 成功瞬间尝试一次，服务端当时不可用会静默丢失；
        // 恢复时若存档有代码产物而程序库无本对话记录，则自动补一次（服务端按对话 upsert，不会重复）
        if (snap.lastCode && snap.lastCode.files?.length) {
          const code = snap.lastCode;
          void (async () => {
            try {
              const metas = await programStoreRef.current.list();
              if (cancelled || metas.some((m) => m.source?.conversationId === conversationId)) return;
              await programStoreRef.current.save({
                conversationId,
                name: currentTaskRef.current?.title || "未命名程序",
                entry: code.entryFile ?? code.files[0]?.path,
                files: code.files,
              });
            } catch {
              /* 服务不可用：继续静默，下次打开再试 */
            }
          })();
        }
      } catch {
        /* 快照损坏/服务未启动：丢弃，从零开始 */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, makeAgent]);

  /** 老板发消息：驱动一轮对话（执行中再发 = 插话） */
  const send = useCallback(
    async (
      text: string,
      attachments: string[] = [],
      media?: ChatUserMediaRef[],
      images?: Array<{ mimeType: string; dataUrl: string }>,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      const userMsg: ChatUIMessage = {
        id: nextId(),
        kind: "user",
        content: trimmed || `（提供 ${attachments.length} 个素材）`,
        ...(media?.length ? { media } : {}),
        ...(images?.length ? { images } : {}),
        // 插话归当前回合；新发起预占下一回合（reply 开头会 +1 对齐）
        turnId: phase === "thinking" ? (agentRef.current?.turnId || 1) : (agentRef.current?.turnId ?? 0) + 1,
        createdAt: Date.now(),
      };
      // 同步入 ref：插话场景下 persist 可能先于渲染触发，老板的输入不能被回滚
      messagesRef.current = [...messagesRef.current, userMsg];
      setMessages((prev) => [...prev, userMsg]);
      emergencyPersist(); // 用户输入立即落盘：闪断/刷新也不丢这条

      const agent = agentRef.current ?? makeAgent(conversationId);
      agentRef.current = agent;
      agent.updateModel(adaptersRef.current.model);
      autoResumeRef.current = 0; // 老板新消息 = 新任务，自动续跑计数重置
      sendCidRef.current = conversationId;

      // 小逻正在干活 → 这条消息作为插话注入，不打断当前轮
      if (phase === "thinking") {
        agent.steer(trimmed);
        return;
      }

      setPhase("thinking");
      // AUTO-RESUME 预算耗尽自动续跑：系统注入续跑指令接着推进，老板不必反复手动输"继续"
      const MAX_AUTO_RESUME = 6;
      let turn: ChatTurnOutcome | null = null;
      let turnText = trimmed;
      try {
        for (;;) {
          turn = await agent.reply(turnText, attachments, images).catch((e: unknown) => {
            // 未预期异常兜底：写一条中断状态进消息流并存档，避免静默丢状态
            const msg = e instanceof Error ? e.message : String(e);
            const errStatus: ChatUIMessage = {
              id: nextId(),
              kind: "status",
              content: "发生未预期错误：" + msg,
              meta: {
                tool: "llm_interrupted",
                target: msg.slice(0, 80),
                ok: false,
                detail: "直接发消息即可接着聊",
              },
              turnId: agentRef.current?.turnId ?? 1,
              createdAt: Date.now(),
            };
            messagesRef.current = [...messagesRef.current, errStatus];
            setMessages((prev) => [...prev, errStatus]);
            return { interrupted: true, usedTokens: 0, steps: 0 } as ChatTurnOutcome;
          });
          setLastTurn(turn);
          attachments = [];
          images = undefined;
          if (
            turn.budgetExhausted &&
            sendCidRef.current === conversationId &&
            autoResumeRef.current < MAX_AUTO_RESUME
          ) {
            autoResumeRef.current += 1;
            const n = autoResumeRef.current;
            const note: ChatUIMessage = {
              id: nextId(),
              kind: "status",
              content: `本轮预算已用尽，小逻自动继续（${n}/${MAX_AUTO_RESUME}）…`,
              meta: { tool: "auto_resume", ok: true },
              turnId: agent.turnId,
              createdAt: Date.now(),
            };
            messagesRef.current = [...messagesRef.current, note];
            setMessages((prev) => [...prev, note]);
            persist();
            turnText = "[系统续跑] 预算已续：从上一步中断处继续推进任务，不要重复已完成的步骤。";
            continue;
          }
          autoResumeRef.current = 0;
          break;
        }
      } finally {
        setPhase("idle");
        // 中断断点：历史存档提示续聊；正常结束也存档（多轮记忆）
        persist(turn?.interrupted ? { interrupted: true } : undefined);
        // 任务档案：抽 journal 时间线入档（路线图④）；异步存盘不阻塞下一轮
        void recordTaskTurn(trimmed);
      }
    },
    [conversationId, makeAgent, persist, recordTaskTurn, phase],
  );

  /** 当前步骤摘要（journal 最新一条）：运行指示器轮询读取 */
  const getStepNote = useCallback(
    () => agentRef.current?.journal.recent(1)[0]?.note ?? "",
    [],
  );

  /** 回答反问卡 → Agent 原地继续（存档同步清掉 pendingAsk） */
  const answerAsk = useCallback(
    (answer: AskUserAnswer) => {
      agentRef.current?.answerAsk(answer);
      setPhase("thinking");
      persist();
    },
    [persist],
  );

  /** 执行中插话 */
  const steer = useCallback((text: string) => agentRef.current?.steer(text), []);

  /** EDIT-SYNC + AUTO-SYNC：代码页签手改回写入口（合并进代理产物并存档+落盘程序库，下一轮基线即最新） */
  const mergeArtifactFiles = useCallback((files: Array<{ path: string; content: string }>) => {
    const changed = agentRef.current?.mergeArtifactFiles(files);
    if (changed) persistRef.current?.();
    if (changed) scheduleServiceSync(); // AUTO-SVC-SYNC：手改同样触发服务同步
    // AUTO-SYNC: 手改产物同样落盘程序库（服务端按对话 upsert，与 write_code 自动落盘同一路径），
    // 失败静默降级不挡手改流程；对话存档里仍有最新代码兜底。
    if (changed) {
      void (async () => {
        try {
          const artifact = agentRef.current?.getCurrentArtifact();
          if (!artifact || !artifact.files.length) return;
          await programStoreRef.current.save({
            conversationId,
            name: currentTaskRef.current?.title || "未命名程序",
            entry: artifact.entryFile ?? artifact.files[0]?.path,
            files: artifact.files,
          });
        } catch {
          /* 服务端不可用：静默降级（对话存档里仍有最新代码） */
        }
      })();
    }
    return Boolean(changed);
  }, [conversationId]);

  // EDIT-SYNC：结果面板代码页签编辑 → 事件回写本对话代理产物（跨组件解耦）
  useEffect(() => {
    const onArtifactEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ files?: Array<{ path: string; content: string }> }>).detail;
      if (detail?.files?.length) mergeArtifactFiles(detail.files);
    };
    window.addEventListener("xiaoluo-artifact-edit", onArtifactEdit);
    return () => window.removeEventListener("xiaoluo-artifact-edit", onArtifactEdit);
  }, [mergeArtifactFiles]);

  /** 中止当前轮：Agent 标记中止 + 杀掉桌面/服务端在途命令子进程 */
  const stop = useCallback(() => {
    agentRef.current?.stop();
    adaptersRef.current.command?.cancelAll?.();
  }, []);

  return useMemo(
    () => ({
      messages,
      phase,
      lastTurn,
      currentTask,
      send,
      answerAsk,
      steer,
      stop,
      getStepNote,
      memoryStore: memoryStoreRef.current,
      /** AUTO-SVC-SYNC：服务自动重启完成计数（浏览器页签强制重载用） */
      svcSyncNonce,
    }),
    [messages, phase, lastTurn, currentTask, send, answerAsk, steer, stop, getStepNote, svcSyncNonce],
  );
}
