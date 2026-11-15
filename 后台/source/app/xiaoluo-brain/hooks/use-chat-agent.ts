/**
 * 小逻 v3 —— useChatAgent hook（对话型小逻的浏览器宿主）
 *
 * 内核不在这一侧：引擎跑在服务进程里（lib/brain/agent-server.ts），本文件只是它的又一个宿主，
 * 跟 CLI、桌面端说的是同一套协议（AgentClient：POST 信封 + GET SSE，同源 /api/v2/brain/agent）。
 * hook 对外那张面孔（messages/phase/send/steer/stop…）跟内核搬走之前一模一样，面板一行不用改。
 *
 * 职责：
 *  1. 线程生命周期：有存档就 thread/resume（快照交回内核），没存档就 thread/start
 *  2. 事件 → 消息流映射：event/ui 的卡片/旁白、event/stream 的逐字流、event/turn 的回合边界
 *  3. 宿主应答两条线：event/approval（批不批）、event/tool-request（这一口在这台机器上怎么跑）
 *  4. 对话历史落盘归宿主：内核只认快照，存哪（localStorage / 服务端）由 store 决定
 *  5. 任务档案（路线图④）：每轮后从 thread/journal 抽时间线入档
 *
 * 存档里的 lastSeq 是宿主自己记的水位：事件流重连会补发缓冲区里的旧事件，
 * 没有它就等于每次刷新都把已经贴过的卡片再贴一遍。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentClient, httpTransport, isThreadGone, type AgentTurnOutcome } from "../lib/brain/agent-client";
import { confirmApproval, markApproved, wasApproved } from "../lib/brain/approval-grants";
import { buildForkSnapshot } from "../lib/brain/conversation";
import type { ChatAgentPorts } from "../lib/brain/agent-ports";
import { hostDecl, probeHostGate, runHostTool, type HostAdapters } from "../lib/brain/host-bridge";
import type {
  AgentApprovalEvent,
  AgentEvent,
  AgentThreadSnapshot,
  PermissionMode,
} from "../lib/brain/agent-wire";
import type { PreviewDocument } from "../lib/brain/preview";
import { buildPreviewDocument, isPreviewable } from "../lib/brain/preview";
import { appendTimeline, createTask, LocalStorageTaskStore } from "../lib/brain/tasks";
import type { TaskRecord, TaskStore } from "../lib/brain/tasks";
import { HybridMemoryStore } from "../lib/brain/memory-store";
import { HttpMemoryMirror, HttpProgramStore } from "../lib/brain/api";
import { LocalStorageChatStore } from "../lib/brain/types";
import type {
  AskUserAnswer,
  AskUserRequest,
  BrowserPort,
  ChatPersistence,
  ChatStore,
  CodeArtifact,
  CommandPort,
  FileSystemPort,
  GitPort,
  NodeRunResult,
  ServicePort,
} from "../lib/brain/types";

// ---------- 宿主能代跑什么（能力声明的唯一依据：adapters 里有哪个口就声明哪个） ----------

export interface ChatAdapters extends HostAdapters {
  /** 网关准入对：thread/start 要按它解析模型凭据 */
  canvasId: string;
  /** LLM 网关（OpenAI 兼容 tool calling） */
  callLLM: ChatAgentPorts["callLLM"];
  /** 联网检索（可选） */
  webSearch?: (query: string) => Promise<string>;
  /** 历史检索（可选，首轮注入） */
  consultHistory?: (goal: string) => Promise<string>;
  /** 文件系统（AUTO-SVC-SYNC 把最新产物写回部署目录时用；工具面那一侧已在内核里） */
  fs?: FileSystemPort;
  /** 受控命令（可选：run_command，建议宿主接 sandbox.ts 分级闸门） */
  command?: CommandPort;
  /** 服务管理（AUTO-SVC-SYNC 重启本对话的服务时用） */
  service?: ServicePort;
  /** 仓库（可选：git status/log/diff/commit） */
  git?: GitPort;
  /** 网页浏览（可选：browse_page） */
  browser?: BrowserPort;
  /** 能力清单文本（capabilities 注册表 → 每行一个 Skill/模型） */
  capabilityCatalog: string;
  /** 老板在控制台上选的文件档位：内核在服务进程里读文件，得按这一份建围栏（缺省 default） */
  permissionMode?: PermissionMode;
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
  /** user 消息随附素材（仅界面渲染用；内核仍靠【附件】文本取文件） */
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

/** 进度轮询间隔：一次取运行指示器要的最新一条账，顺带把快照镜像与存档刷一遍 */
const PROGRESS_POLL_MS = 1_500;

/** 本机执行形态（桌面壳里才 true）：影响提示词里的路径与命令口径 */
function isDesktopHost(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { xiaoluoDesktop?: unknown }).xiaoluoDesktop);
}

/** 本宿主这张面孔（不含模型）：文件档位 + 代跑口 + MCP 清单 + 有没有视觉。
 *  内核的围栏和工具面按这份建，某一项变了就得把整份重新交回去 —— 否则老板把权限切到
 *  「全部访问」小逻还按旧档位被拦，或者桌面通道断了之后小逻仍跟一个不在路上的宿主要截图。
 *  只换模型不算变面孔，走 thread/model/update 那条轻路径，不必把线程推倒重建。
 *  闸门读数 gateOpen 也算面孔的一笔：老板一开「允许小逻控制本机」，desktop/webdriver/ssh
 *  三口跟着变，下一轮就该重新交一份声明，而不是让内核继续按关着的那张脸答「这个我跑不了」。 */
function hostFace(a: ChatAdapters, gateOpen: boolean): string {
  const d = hostDecl(a, gateOpen);
  return [
    a.permissionMode ?? "default",
    d.hostTools.join(","),
    d.mcpTools.map((t) => t.name).join(","),
    d.hostModelVision ? "vision" : "-",
  ].join("|");
}

/** 没有挂起的反问（应答无处可去）：内核用 NO_PENDING_ASK(-32012) 挡，宿主改成发一条新消息 */
function isNoPendingAsk(e: unknown): boolean {
  return e instanceof Error && e.name === "AgentRpcError" && (e as unknown as { code?: number }).code === -32012;
}

/** 协议层失败 → 一条弱化旁白：老板看得见卡在哪，也知道接着发消息就行 */
function failureMessage(e: unknown, turnId: number): ChatUIMessage {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    id: nextId(),
    kind: "status",
    content: "发生未预期错误：" + msg,
    meta: { tool: "llm_interrupted", target: msg.slice(0, 80), ok: false, detail: "直接发消息即可接着聊" },
    turnId: turnId || 1,
    createdAt: Date.now(),
  };
}

/** 存档 → 内核快照形状（缺字段一律按空补，宿主不用判 undefined） */
function snapshotOf(persistence: ChatPersistence | null): AgentThreadSnapshot {
  return {
    messages: persistence?.messages ?? [],
    usedTokens: persistence?.usedTokens ?? 0,
    lastCode: persistence?.lastCode ?? null,
    goal: persistence?.goal ?? null,
    dirtyCodeFiles: persistence?.dirtyCodeFiles ?? [],
    readPaths: persistence?.readPaths ?? [],
  };
}

/** 内核快照 → 存档字段（分叉以服务端返回的那份为准，宿主镜像可能旧一拍） */
function snapshotToFields(s: AgentThreadSnapshot): Partial<ChatPersistence> {
  return {
    messages: s.messages,
    usedTokens: s.usedTokens,
    ...(s.lastCode ? { lastCode: s.lastCode } : {}),
    ...(s.goal ? { goal: s.goal } : {}),
    ...(s.dirtyCodeFiles.length ? { dirtyCodeFiles: s.dirtyCodeFiles } : {}),
    ...(s.readPaths.length ? { readPaths: s.readPaths } : {}),
  };
}

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
  const [lastTurn, setLastTurn] = useState<AgentTurnOutcome | null>(null);
  /** AUTO-RESUME 预算耗尽自动续跑次数（老板新发消息即重置；对话切换后不再续） */
  const autoResumeRef = useRef(0);
  const sendCidRef = useRef(conversationId);
  /** 当前对话的任务档案（长周期项目看板素材，路线图④） */
  const [currentTask, setCurrentTask] = useState<TaskRecord | null>(null);
  /** 本对话的分叉血统（存档 forkedFrom）；null = 主干对话 */
  const [forkedFrom, setForkedFrom] = useState<string | null>(null);

  /** 持久化口（默认 localStorage；传 store 则走服务端实现） */
  const storeRef = useRef<ChatStore>(options?.store ?? new LocalStorageChatStore());
  storeRef.current = options?.store ?? storeRef.current;
  const taskStoreRef = useRef<TaskStore>(options?.taskStore ?? new LocalStorageTaskStore());
  taskStoreRef.current = options?.taskStore ?? taskStoreRef.current;
  /** 长期记忆（跨对话）：本地真相 + 服务端镜像（B5），管理权在老板（面板可查/删） */
  const memoryStoreRef = useRef(new HybridMemoryStore(new HttpMemoryMirror({ base: "" })));
  /** 程序库落盘口：手改产物后补一份（write_code 的自动落盘已在服务端做掉） */
  const programStoreRef = useRef(new HttpProgramStore({ base: "" })); // 同源：默认 3001 无服务，写死会静默全丢
  /** 任务档案镜像：落盘时以任务标题作程序名 */
  const currentTaskRef = useRef<TaskRecord | null>(null);
  /** AUTO-SVC-SYNC：本对话启动的服务（产物变化后自动重启的目标；null = 未启动/已停止） */
  const linkedServiceRef = useRef<{ id: string; command: string; cwd?: string } | null>(null);
  const svcSyncTimerRef = useRef<number | null>(null);
  const svcSyncBusyRef = useRef(false);
  /** AUTO-SVC-SYNC：同步成功后递增 → 浏览器页签 iframe 强制重载 */
  const [svcSyncNonce, setSvcSyncNonce] = useState(0);

  /** adapters 走 ref：引用变化（如模型列表刷新）不得触发"对话切换"效应把消息清空；
   * 每次调用时读取最新值，模型/能力变化下一轮自动生效 */
  const adaptersRef = useRef(adapters);
  adaptersRef.current = adapters;

  // ---------- 协议侧状态（内核在服务进程里，这边只有镜像与订阅） ----------

  /** 内核最新快照（messages/usedTokens/lastCode/断点账）：存档与紧急落盘都读它，不查服务也不会写成空 */
  const mirrorRef = useRef<AgentThreadSnapshot | null>(null);
  /** 内核当前回合号：卡片归组与续跑提示读它，由事件与 threadRead 双向更新 */
  const turnIdRef = useRef(0);
  /** 运行指示器要的最新一条 journal note（getStepNote 必须同步返回，所以靠轮询喂） */
  const stepNoteRef = useRef("");
  /** 这条线程是否已在服务里活着（切对话/被回收后置 false，下一次用时重建） */
  const threadReadyRef = useRef(false);
  /** 已消费到的事件序号：事件流重连的补发靠它挡住上一轮就贴过的卡片 */
  const lastSeqRef = useRef(0);
  /** 事件订阅句柄（引用计数在客户端里，这里只管开关） */
  const watchRef = useRef<{ close(): void } | null>(null);
  /** 上一次交回内核的模型 id：变了才 thread/model/update，不必每轮都报一遍 */
  const lastModelRef = useRef("");
  /** 上一次交回内核的宿主面孔（hostFace）：变了才重开线程，把围栏与工具面按新的那份重搭 */
  const hostFaceRef = useRef("");

  /** 事件回调与审批回调都要读后面才声明的东西，用 ref 打断声明顺序 */
  const handleEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const approveRef = useRef<((event: AgentApprovalEvent) => Promise<boolean>) | null>(null);

  const clientRef = useRef<AgentClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new AgentClient({
      // 同源：浏览器带 cookie 走 requireUser，与面板其余 /api/v2 调用同一套鉴权
      transport: httpTransport({ baseUrl: "" }),
      onEvent: (event) => handleEventRef.current?.(event),
      // 审批的失败方向永远是安全的那一边：没接上确认 UI 就等于拒绝
      onApproval: (event) => approveRef.current?.(event) ?? Promise.resolve(false),
      // 代跑现读现派：适配器换了（换模型、桌面通道断了）都不必重建客户端
      onHostTool: (event) => runHostTool(adaptersRef.current, event),
    });
  }
  const client = clientRef.current;

  useEffect(() => {
    currentTaskRef.current = currentTask;
  }, [currentTask]);

  /** persist 的前向引用：事件回调里只认这一个入口 */
  const persistRef = useRef<((extra?: Partial<ChatPersistence>) => void) | null>(null);
  /** 流式输出占位消息 id：delta 增量更新同一条；end/定稿落帐时收口 */
  const streamMsgIdRef = useRef<string | null>(null);
  /** streamUI.end() 刚收口的占位气泡 id：定稿 event/ui 在 end 之后才到，靠它找回气泡原地定稿，防重复贴第二条 */
  const endedStreamIdRef = useRef<string | null>(null);

  /** 当前存档快照：内核镜像 + 宿主消息流，两处共用一份构造防字段漂移 */
  const buildSnapshot = useCallback((): ChatPersistence | null => {
    const snap = mirrorRef.current;
    if (!snap) return null;
    return {
      version: 1,
      conversationId,
      messages: snap.messages,
      usedTokens: snap.usedTokens,
      uiMessages: messagesRef.current,
      lastCode: snap.lastCode ?? undefined,
      // 断点续跑：goal / 改完必跑账 / 读后写账随存档落盘（旧存档无字段即空）
      goal: snap.goal ?? undefined,
      dirtyCodeFiles: snap.dirtyCodeFiles?.length ? snap.dirtyCodeFiles : undefined,
      readPaths: snap.readPaths?.length ? snap.readPaths : undefined,
      lastSeq: lastSeqRef.current || undefined,
      savedAt: Date.now(),
    };
  }, [conversationId]);

  /**
   * 存档：先把内核侧的账读回来刷新镜像，再落盘。
   * 线程已回收就用手上的镜像兜底（镜像为 null 说明什么都没读到，此时存下去只会把历史写成空）。
   */
  const persist = useCallback(
    (extra?: Partial<ChatPersistence>) => {
      void (async () => {
        if (threadReadyRef.current) {
          try {
            const read = await client.threadRead(conversationId);
            mirrorRef.current = read.snapshot;
            turnIdRef.current = read.turnId;
          } catch {
            threadReadyRef.current = false;
            if (!mirrorRef.current) return;
          }
        } else if (!mirrorRef.current) {
          return;
        }
        const data = buildSnapshot();
        if (!data) return;
        await storeRef.current.save(conversationId, { ...data, ...extra }).catch(() => {
          /* 存档失败不阻断对话（实现内部也已降级） */
        });
      })();
    },
    [buildSnapshot, client, conversationId],
  );
  persistRef.current = persist;

  /** 紧急落盘：页面闪动/热重载/误刷新不丢消息——同步用现有镜像写 localStorage + keepalive 补传服务端 */
  const emergencyPersist = useCallback(() => {
    const data = buildSnapshot();
    if (!data) return;
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
  }, [buildSnapshot, conversationId]);

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

  /** 起线程：有存档就把快照交回内核重建，没有就从零 start；顺手挂上事件流 */
  const openThread = useCallback(async (gateOpen: boolean) => {
    const a = adaptersRef.current;
    if (!a.model) throw new Error("请先在设置里启用一个文本大模型");
    const base = {
      conversationId,
      canvasId: a.canvasId,
      model: a.model,
      permissionMode: a.permissionMode ?? "default",
      ...hostDecl(a, gateOpen),
    };
    const snap = mirrorRef.current;
    const handle = snap?.messages.length
      ? await client.threadResume({ ...base, snapshot: snap })
      : await client.threadStart({ ...base, capabilityCatalog: a.capabilityCatalog, localExecution: isDesktopHost() });
    // 内核这一世死了重开（服务重启 / 闲置回收）时 seq 从 1 重来：本地旧水位必须跟着退回去，
    // 不退就是永久聋掉 —— 回合照跑、存档照写，界面一条事件也认不出来，老板只看到「进行中」
    if (handle.seq < lastSeqRef.current) {
      lastSeqRef.current = handle.seq;
      client.rebaseSeq(conversationId, handle.seq);
    }
    threadReadyRef.current = true;
    hostFaceRef.current = hostFace(a, gateOpen);
    lastModelRef.current = a.model;
    if (!client.isWatched(conversationId)) watchRef.current = client.watch(conversationId);
  }, [client, conversationId]);

  /**
   * 线程起没起、宿主这张面孔变没变，都在这一步兜住；调用方只管往下跑。
   * 面孔 = 文件档位 + 代跑口 + MCP 清单 + 有没有视觉 + 本机闸门读数（见 hostFace）：
   * 内核的围栏与工具面按它建，变了就重开线程（走 thread/resume，存档会灌回去，历史不丢）。
   * 只换模型是另一条路：thread/model/update 原地换连接，待答反问和挂起的审批都不用重建。
   * 闸门每次回合都现问一遍：它活在老板的设置里，随时可能被动，缓存一份旧读数就是拿昨天的能力面骗小逻。
   */
  const ensureThread = useCallback(async () => {
    const a = adaptersRef.current;
    const gate = await probeHostGate(a);
    if (threadReadyRef.current) {
      if (hostFace(a, gate) === hostFaceRef.current) {
        if (a.model && a.model !== lastModelRef.current) {
          await client.threadModelUpdate(conversationId, a.model).catch(() => undefined);
          lastModelRef.current = a.model;
        }
        return;
      }
    }
    await openThread(gate);
  }, [client, conversationId, openThread]);

  /** 线程被回收（闲置 30 分钟 / 服务重启）：按存档重建一次再试，老板不该看到"线程不在服务里" */
  const withThread = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      await ensureThread();
      try {
        return await run();
      } catch (e) {
        if (!isThreadGone(e)) throw e;
        threadReadyRef.current = false;
        await openThread(await probeHostGate(adaptersRef.current));
        return await run();
      }
    },
    [ensureThread, openThread],
  );

  // ---------- 消息流写入 ----------

  const pushMessage = useCallback((msg: ChatUIMessage) => {
    // 同步入 ref：渲染是异步的，中断/收尾瞬间的存档必须能读到最新消息，
    // 否则最后几条回复会被旧快照回滚掉（"回复消失"的直接根因）
    messagesRef.current = [...messagesRef.current, msg];
    setMessages((prev) => [...prev, msg]);
  }, []);

  const patchMessage = useCallback((id: string, patch: (m: ChatUIMessage) => ChatUIMessage) => {
    messagesRef.current = messagesRef.current.map((x) => (x.id === id ? patch(x) : x));
    setMessages((prev) => prev.map((x) => (x.id === id ? patch(x) : x)));
  }, []);

  /**
   * AUTO-SVC-SYNC：产物变化（write_code / 手改回写）→ 防抖 2 秒 → 同步到运行中的服务。
   * 链路：最新产物写回部署目录 → 停旧服务 → 同命令/同 cwd 重启 → nonce+1 刷新浏览器页签。
   * 只认「本对话启动的服务」（从 start_service 那条旁白的 meta.serviceId 认领）；无服务/已停则静默跳过。
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
        const artifact = mirrorRef.current?.lastCode;
        if (!svc || !fsPort || !service || !artifact || !artifact.files.length) return;
        svcSyncBusyRef.current = true;
        const pushNote = (content: string, ok: boolean) => {
          pushMessage({
            id: nextId(),
            kind: "status",
            content,
            meta: { tool: "auto_svc_sync", ok },
            turnId: turnIdRef.current,
            createdAt: Date.now(),
          });
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
  }, [pushMessage]);

  // ---------- 事件 → 消息流映射 ----------

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      if (event.conversationId !== conversationId) return;
      // 重连补发的旧事件不再重演：卡片与旁白只该进消息流一次
      if (event.seq <= lastSeqRef.current) return;
      lastSeqRef.current = event.seq;
      if (event.turnId) turnIdRef.current = Math.max(turnIdRef.current, event.turnId);

      switch (event.method) {
        case "event/ui": {
          // 流式定稿去重：刚打完字的流占位气泡（含 end 刚收口的）→ 原地定稿，不再贴新消息
          if (event.meta?.fromStream) {
            const sid = streamMsgIdRef.current ?? endedStreamIdRef.current;
            if (sid) {
              streamMsgIdRef.current = null;
              endedStreamIdRef.current = null;
              patchMessage(sid, (x) => ({
                ...x,
                kind: event.kind as ChatUIMessageKind,
                content: event.content,
                meta: { ...x.meta, ...event.meta, streaming: false },
              }));
              return;
            }
          }
          const kind = event.kind as ChatUIMessageKind;
          pushMessage({
            id: nextId(),
            kind,
            content: event.content,
            artifact: kind === "code-card" ? (event.meta?.artifact as CodeArtifact) : undefined,
            meta: event.meta as Record<string, unknown> | undefined,
            turnId: event.turnId,
            preview: kind === "preview-card" ? (event.meta?.preview as PreviewDocument) : undefined,
            result: kind === "media-card" ? (event.meta?.result as NodeRunResult) : undefined,
            ask: kind === "ask-card" ? (event.meta?.ask as AskUserRequest) : undefined,
            createdAt: Date.now(),
          });
          // 反问挂起：立刻存档 pendingAsk，刷新后能重新挂回卡片
          if (kind === "ask-card" && event.meta?.ask) {
            persistRef.current?.({ pendingAsk: event.meta.ask as AskUserRequest });
          }
          if (kind === "code-card") {
            // 镜像里的产物先跟上：AUTO-SVC-SYNC 与手改落盘都读这份，不等下一次 threadRead
            const artifact = event.meta?.artifact as CodeArtifact | undefined;
            if (artifact && mirrorRef.current) mirrorRef.current = { ...mirrorRef.current, lastCode: artifact };
            scheduleServiceSync();
          }
          // 服务口在内核侧，宿主只能从旁白的 meta 里认领「本对话启动的服务」
          if (event.meta?.tool === "start_service") {
            const id = event.meta.serviceId as string | undefined;
            if (event.meta.ok === true && id) {
              linkedServiceRef.current = {
                id,
                command: String(event.meta.target ?? ""),
                cwd: event.meta.cwd as string | undefined,
              };
            } else if (event.meta.ok !== true && (!id || linkedServiceRef.current?.id === id)) {
              linkedServiceRef.current = null;
            }
          }
          // 老板或小逻自己把服务停了：别再往一个已退出的服务上同步代码
          if (event.meta?.tool === "stop_service" && linkedServiceRef.current?.id === event.meta.target) {
            linkedServiceRef.current = null;
          }
          return;
        }
        case "event/stream": {
          if (event.phase === "begin") {
            const id = nextId();
            streamMsgIdRef.current = id;
            endedStreamIdRef.current = null;
            pushMessage({
              id,
              kind: "assistant",
              content: "",
              meta: { streaming: true },
              turnId: event.turnId,
              createdAt: Date.now(),
            });
            return;
          }
          if (event.phase === "delta") {
            const sid = streamMsgIdRef.current;
            if (!sid || !event.text) return;
            patchMessage(sid, (x) => ({ ...x, content: x.content + event.text }));
            return;
          }
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
          patchMessage(sid, (x) => ({ ...x, meta: { ...x.meta, streaming: false } }));
          return;
        }
        case "event/turn": {
          if (event.phase === "started") return;
          // 收口先把状态机放回 idle：反问应答之后没有 runTurn 在等，只有这一条事件能让输入框解除"正在思考"
          setPhase("idle");
          if (!threadReadyRef.current) return;
          // 收口时把内核的账一次性拿回来：紧接着的存档读的就是这份镜像，不用再回查服务
          void client
            .threadRead(conversationId)
            .then((read) => {
              mirrorRef.current = read.snapshot;
              turnIdRef.current = read.turnId;
              // 应答续跑的那一轮没有 send 的 finally 会存，落账只能挂在这里
              persistRef.current?.();
            })
            .catch(() => {
              threadReadyRef.current = false;
            });
          return;
        }
        case "event/error": {
          setPhase("idle");
          pushMessage(failureMessage(event.message, event.turnId));
          return;
        }
        default:
          // event/approval 与 event/tool-request 由客户端自动回执（onApproval / onHostTool）
          return;
      }
    },
    [client, conversationId, patchMessage, pushMessage, scheduleServiceSync],
  );
  handleEventRef.current = handleEvent;

  /** 审批门：会话级记住选择（同内容 30 分钟内不再问），决策留痕由 approval-grants 负责 */
  approveRef.current = useCallback(async (event: AgentApprovalEvent) => {
    if (wasApproved(event.scope, event.subject)) return true;
    const ok = confirmApproval({
      scope: event.scope,
      subject: event.subject,
      action: event.action,
      reasons: event.reasons,
    });
    if (ok) markApproved(event.scope, event.subject);
    return ok;
  }, []);

  // 执行中周期轮询：一次取运行指示器要的最新一条账，顺带刷新镜像并存档（闪断恢复后消息仍在）
  useEffect(() => {
    if (phase !== "thinking") return;
    const poll = () => {
      void client
        .threadJournal(conversationId, 1)
        .then(({ entries }) => {
          const note = entries.at(-1)?.note;
          if (note) stepNoteRef.current = note;
        })
        .catch(() => undefined);
      persistRef.current?.();
    };
    const timer = window.setInterval(poll, PROGRESS_POLL_MS);
    poll();
    return () => window.clearInterval(timer);
  }, [client, conversationId, phase]);

  /** 轮末任务档案维护：确保有 active 任务 → 抽 journal 时间线 → 存盘 */
  const recordTaskTurn = useCallback(
    async (firstUserText: string) => {
      const store = taskStoreRef.current;
      let task =
        (await store.list()).find(
          (t) => t.status === "active" && t.conversationIds.includes(conversationId),
        ) ?? null;
      if (!task) {
        task = createTask(firstUserText || "新任务", conversationId);
      }
      try {
        const { entries } = await client.threadJournal(conversationId, 8);
        appendTimeline(task, entries.map((e) => ({ ts: e.ts, note: e.note })));
        const note = entries.at(-1)?.note;
        if (note) stepNoteRef.current = note;
      } catch {
        /* 线程刚好被回收：这轮时间线拿不到就只存任务本身，别把续聊也搭进去 */
      }
      await store.save(task);
      setCurrentTask(task);
    },
    [client, conversationId],
  );

  // 对话切换：先清掉上一条的订阅与镜像，再从存档恢复消息流（线程等第一条消息再起）
  useEffect(() => {
    watchRef.current?.close();
    watchRef.current = null;
    threadReadyRef.current = false;
    mirrorRef.current = null;
    turnIdRef.current = 0;
    stepNoteRef.current = "";
    lastSeqRef.current = 0;
    streamMsgIdRef.current = null;
    endedStreamIdRef.current = null;
    linkedServiceRef.current = null;
    messagesRef.current = []; // 同步清 ref：切换窗口内首次渲染前的存档不会把旧对话写进新对话
    setMessages([]);
    setPhase("idle");
    setLastTurn(null);
    setCurrentTask(null);
    setForkedFrom(null);

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
        setForkedFrom(snap.forkedFrom ?? null);

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
        messagesRef.current = restored; // 同步回写 ref：恢复后首次渲染前若触发存档，不能用空流覆盖历史
        setMessages(restored);
        setPhase(snap.pendingAsk ? "waiting-ask" : "idle");
        // 镜像先垫上存档那份：服务重启/线程回收后紧急落盘不会把历史写成空
        mirrorRef.current = snapshotOf(snap);
        lastSeqRef.current = snap.lastSeq ?? 0;
      } catch {
        /* 快照损坏/服务未启动：丢弃，从零开始 */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /**
   * 分叉当前对话（走 thread/fork）：分支 id、血统与留痕由服务端定，宿主只负责把分支存档落下去。
   * 返回新 conversationId，宿主切过去即走原有恢复链路。
   */
  const forkConversation = useCallback(async (): Promise<string> => {
    const a = adaptersRef.current;
    const current = buildSnapshot();
    if (!current) throw new Error("对话还没建起来，分叉不了。");
    if (current.messages.filter((m) => m.role !== "system").length === 0) {
      throw new Error("当前对话还是空的，没有可分叉的内容。");
    }
    const forked = await withThread(async () =>
      client.threadFork({
        canvasId: a.canvasId,
        model: a.model,
        permissionMode: a.permissionMode ?? "default",
        fromConversationId: conversationId,
        ...(mirrorRef.current ? { sourceSnapshot: mirrorRef.current } : {}),
        ...hostDecl(a, await probeHostGate(a)),
      }),
    );
    // 存档口失败一律静默降级，所以写完必须回读确认：确认不了就是没落盘，
    // 此时切过去只会得到一条空对话，老板看到的是"历史丢了"而不是"分叉失败"。
    const seed: ChatPersistence = {
      ...current,
      ...snapshotToFields(forked.snapshot),
    };
    await storeRef.current.save(forked.conversationId, buildForkSnapshot(seed, forked.conversationId, Date.now()));
    if (!(await storeRef.current.load(forked.conversationId))) {
      throw new Error("分叉存档没写进去（存储不可用），原对话没动，稍后再试。");
    }
    return forked.conversationId;
  }, [buildSnapshot, client, conversationId, withThread]);

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
        // 插话归当前回合；新发起预占下一回合（内核 turn/start 会 +1 对齐）
        turnId: phase === "thinking" ? (turnIdRef.current || 1) : turnIdRef.current + 1,
        createdAt: Date.now(),
      };
      pushMessage(userMsg);
      emergencyPersist(); // 用户输入立即落盘：闪断/刷新也不丢这条

      autoResumeRef.current = 0; // 老板新消息 = 新任务，自动续跑计数重置
      sendCidRef.current = conversationId;

      // 小逻正在干活 → 这条消息作为插话注入，不打断当前轮
      if (phase === "thinking") {
        void withThread(() => client.turnSteer(conversationId, trimmed)).catch(() => undefined);
        return;
      }

      setPhase("thinking");
      let turn: AgentTurnOutcome | null = null;
      let turnText = trimmed;
      // AUTO-RESUME 预算耗尽自动续跑：系统注入续跑指令接着推进，老板不必反复手动输"继续"
      const MAX_AUTO_RESUME = 6;
      try {
        for (;;) {
          turn = await withThread(() =>
            client.runTurn({
              conversationId,
              text: turnText,
              ...(attachments.length ? { attachments } : {}),
              ...(images?.length ? { images } : {}),
            }),
          ).catch((e: unknown) => {
            // 未预期异常兜底：写一条中断状态进消息流并存档，避免静默丢状态
            pushMessage(failureMessage(e, turnIdRef.current));
            return { interrupted: true, usedTokens: 0, steps: 0 } as AgentTurnOutcome;
          });
          setLastTurn(turn);
          attachments = [];
          images = undefined;
          if (
            turn?.budgetExhausted &&
            sendCidRef.current === conversationId &&
            autoResumeRef.current < MAX_AUTO_RESUME
          ) {
            autoResumeRef.current += 1;
            const n = autoResumeRef.current;
            pushMessage({
              id: nextId(),
              kind: "status",
              content: `本轮预算已用尽，小逻自动继续（${n}/${MAX_AUTO_RESUME}）…`,
              meta: { tool: "auto_resume", ok: true },
              turnId: turnIdRef.current,
              createdAt: Date.now(),
            });
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
        persist(turn && (turn.interrupted || turn.stopped) ? { interrupted: true } : undefined);
        // 任务档案：抽 journal 时间线入档（路线图④）；异步存盘不阻塞下一轮
        void recordTaskTurn(trimmed);
      }
    },
    [client, conversationId, emergencyPersist, persist, phase, pushMessage, recordTaskTurn, withThread],
  );

  /** 当前步骤摘要（journal 最新一条）：运行指示器轮询读取 */
  const getStepNote = useCallback(() => stepNoteRef.current, []);

  /** 回答反问卡 → 内核原地继续（存档同步清掉 pendingAsk） */
  const answerAsk = useCallback(
    (answer: AskUserAnswer) => {
      setPhase("thinking");
      void withThread(() => client.turnAnswer(conversationId, answer))
        .then(() => {
          persist({ pendingAsk: undefined });
        })
        .catch((e: unknown) => {
          setPhase("idle");
          // 线程里没挂着这条反问（刷新后重建的那张卡就是这种）：把回答当新消息发出去，
          // 别让老板点了按钮却什么都没发生
          const text = answer.skipped ? "" : (answer.text ?? answer.selected ?? "");
          if (isNoPendingAsk(e)) {
            persist({ pendingAsk: undefined });
            if (text) void send(text);
            return;
          }
          if (e instanceof Error) pushMessage(failureMessage(e, turnIdRef.current));
        });
    },
    [client, conversationId, persist, pushMessage, send, withThread],
  );

  /** 执行中插话 */
  const steer = useCallback(
    (text: string) => void client.turnSteer(conversationId, text).catch(() => undefined),
    [client, conversationId],
  );

  /** EDIT-SYNC + AUTO-SYNC：代码页签手改回写入口（合并进内核产物并存档+落盘程序库，下一轮基线即最新） */
  const mergeArtifactFiles = useCallback(
    (files: Array<{ path: string; content: string }>) => {
      void (async () => {
        try {
          const { changed } = await withThread(() => client.threadArtifactEdit(conversationId, files));
          if (!changed) return;
          // 刷新镜像：程序库那份要用改完的最新产物
          const read = await client.threadRead(conversationId).catch(() => null);
          if (read) mirrorRef.current = read.snapshot;
          persistRef.current?.();
          scheduleServiceSync(); // AUTO-SVC-SYNC：手改同样触发服务同步
          // AUTO-SYNC: 手改产物同样落盘程序库（服务端按对话 upsert，与 write_code 自动落盘同一路径）。
          // write_code 的自动落盘已在内核里做掉，手改这条路内核不会重跑，所以由宿主补一份；
          // 失败静默降级不挡手改流程，对话存档里仍有最新代码兜底。
          const artifact = mirrorRef.current?.lastCode;
          if (!artifact?.files.length) return;
          await programStoreRef.current.save({
            conversationId,
            name: currentTaskRef.current?.title || "未命名程序",
            entry: artifact.entryFile ?? artifact.files[0]?.path,
            files: artifact.files,
          });
        } catch {
          /* 线程不在 / 服务端不可用：静默降级（对话存档里仍有最新代码） */
        }
      })();
    },
    [client, conversationId, scheduleServiceSync, withThread],
  );

  // EDIT-SYNC：结果面板代码页签编辑 → 事件回写本对话代理产物（跨组件解耦）
  useEffect(() => {
    const onArtifactEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ files?: Array<{ path: string; content: string }> }>).detail;
      if (detail?.files?.length) mergeArtifactFiles(detail.files);
    };
    window.addEventListener("xiaoluo-artifact-edit", onArtifactEdit);
    return () => window.removeEventListener("xiaoluo-artifact-edit", onArtifactEdit);
  }, [mergeArtifactFiles]);

  /** 中止当前轮：内核标记中止，服务端在途命令子进程由 turn/interrupt 一并杀掉 */
  const stop = useCallback(() => {
    void client.turnInterrupt(conversationId).catch(() => undefined);
  }, [client, conversationId]);

  // 卸载：断开事件流；服务端那条线程留给闲置回收（历史在宿主存档里，不怕断）
  useEffect(() => {
    return () => {
      watchRef.current?.close();
      watchRef.current = null;
    };
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
      /** 分叉血统（P2）：null = 主干对话 */
      forkedFrom,
      /** 把当前对话复制成分支（宿主拿到新 id 后自行切换 conversationId） */
      forkConversation,
    }),
    [messages, phase, lastTurn, currentTask, send, answerAsk, steer, stop, getStepNote, svcSyncNonce, forkedFrom, forkConversation],
  );
}
