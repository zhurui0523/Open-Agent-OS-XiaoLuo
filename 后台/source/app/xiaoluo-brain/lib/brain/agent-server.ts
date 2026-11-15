/**
 * 小逻 v3 —— app-server（P3：内核搬进服务进程）
 *
 * 这一份是「线程宿主」：线程（一条对话 = 一个 ChatAgent 实例）活在 Next.js 服务进程里，
 * 浏览器 / CLI / 桌面主进程都只是隔着 JSON-RPC 说话的客户。对齐 Codex 的 app-server：
 *
 *   thread/start | resume | fork | read      线程生命周期
 *   turn/start | steer | answer | interrupt  回合控制
 *   event/ui | stream | turn | approval | tool-request   内核 → 宿主（SSE 单向广播）
 *
 * 宿主答的两条线都是「内核挂起、宿主回执」：approval/decide 决定危不危险，
 * tool/decide 交回只有宿主才跑得动的能力结果（画布节点、截屏、CDP、UIA、SSH）。
 *
 * 三条设计约束：
 *  1. 存档所有权仍在宿主。服务端不猜 localStorage 在哪：thread/resume 由宿主把快照交进来，
 *     thread/read 把快照还回去给宿主落盘。因此换宿主不动持久化，也不会两边抢一份存档。
 *  2. 回合不阻塞请求。turn/start 立刻回 turnId，正文/旁白/卡片全从事件流走 ——
 *     这样 steer / answer / interrupt 才能在另一个 HTTP 请求里插进正在跑的回合。
 *  3. 注册表锚在 globalThis（与 brain-sandbox 的服务/会话注册表同一惯例）：
 *     standalone 是单个长驻 Node 进程，模块级 Map 跨请求存活，热重载也不丢线程。
 */

import { DEFAULT_CHAT_AGENT_CONFIG, chatToolCapabilities, runtimeToolCaps, type ChatAgentPorts, type ChatUIEventMeta, type ChatUIKind } from "./agent-ports";
import { createChatAgent } from "./agent-host";
import { buildForkSnapshot, forkConversationId } from "./conversation";
import { ChatAgent } from "./chat-agent";
import { createServerPorts, type ApprovalRequest, type ModelCaller } from "./server-ports";
import { buildChatToolSchemas } from "./chat-tools";
import * as wire from "./agent-wire";
import type { ChatPersistence, McpToolInfo } from "./types";

/** 线程闲置多久回收（回合跑完还挂着 = 白占内存；历史在宿主手里，重建走 thread/resume） */
const THREAD_IDLE_TTL_MS = 30 * 60_000;
/** 事件环形缓冲：断线重连按 since 补发，超出的部分明说「补不上了」 */
const EVENT_BUFFER = 400;
/** 同时最多活着的线程（LRU 淘汰最久没用的） */
const MAX_THREADS = 64;
/** 审批等多久没答按拒绝处理：不能让回合永远挂在一次没人看的弹窗上 */
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/**
 * 宿主代跑端口方法的兜底时长：没人应答不能挂住整轮（回合墙钟硬闸 25 分钟）。
 * 生成类是真在跑（视频要几分钟），交互类点一下就回来，所以按端口分档，不是一刀切。
 */
const HOST_TOOL_TIMEOUT_MS: Record<wire.HostToolPort, number> = {
  generateMedia: 20 * 60_000,
  vision: 60_000,
  desktop: 60_000,
  webdriver: 5 * 60_000,
  uia: 90_000,
  ssh: 5 * 60_000,
  deploy: 60_000,
  // MCP 工具是外部服务器在跑（爬虫、数据库查询都可能几分钟），按webdriver 同一档
  mcp: 5 * 60_000,
};
/** 同时最多挂在路上的反向工具请求：宿主卡住时不至于攒出一堆永远不会回来的 Promise */
const HOST_TOOL_INFLIGHT_MAX = 4;
/** 宿主一次能报上来的 MCP 工具上限：再多就该由宿主那边自己收敛，不是把工具面挤没 */
const MCP_TOOLS_MAX = 64;
/** 逐字增量合并发送的间隔：够平滑（约 12 帧/秒增长），又不至于一个 token 一条事件 */
const STREAM_FLUSH_MS = 80;

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingHostTool {
  port: wire.HostToolPort;
  call: string;
  /** 应答里带回 result/error；超时由本侧合成 error */
  resolve: (reply: { ok: boolean; result?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 宿主一次交上来的代跑声明（thread/start|resume|fork 的那几份字段），过一遍 normalize 才准用 */
interface HostDecl {
  hostTools: wire.HostToolPort[];
  hostModelVision: boolean;
  mcpTools: McpToolInfo[];
  permissionMode: wire.PermissionMode;
}

export interface AgentThread {
  userId: string;
  conversationId: string;
  canvasId: string;
  modelId: string;
  agent: ChatAgent;
  /** 这条线程用的是哪套模型调用（默认服务端网关；嵌入式宿主/测试可换）。分叉时沿用源线程那份 */
  callModel?: ModelCaller;
  /** 线程内单调递增：SSE 的 id 字段用它，客户端据此续传与去重 */
  seq: number;
  buffer: wire.AgentEvent[];
  listeners: Set<(event: wire.AgentEvent) => void>;
  approvals: Map<string, PendingApproval>;
  /** 当前宿主声明能代跑的端口：换宿主（桌面↔浏览器）时整份替换，工具面跟着变 */
  hostTools: Set<wire.HostToolPort>;
  /** 当前模型的视觉能力判定（宿主给），只有 vision 口用 */
  hostModelVision: boolean;
  /** 宿主报上来的 MCP 工具清单（声明了 mcp 口才有效）：工具面按它注册，服务端不猜宿主连了啥 */
  mcpTools: McpToolInfo[];
  /** 宿主报的文件档位：内核只拿它建文件口，命令口不吃这一份 */
  permissionMode: wire.PermissionMode;
  hostToolCalls: Map<string, PendingHostTool>;
  /** 程序库落盘用的任务名：本轮对话第一句老板原话（与面板宿主取 currentTask.title 同口径） */
  taskTitle: string;
  /** 按当前 hostTools 重搭端口面并交给引擎（构造入参与 holder 闭在闭包里，换宿主只需改声明再调它） */
  rebuildPorts: () => void;
  /** 回合跑一半时换来的新宿主声明：本轮结束、端口面没在用的那一刻才落地 */
  pendingHostDecl?: HostDecl;
  running: boolean;
  lastUsedAt: number;
}

function registry(): Map<string, AgentThread> {
  const g = globalThis as unknown as { __xiaoluoBrainAgentThreads?: Map<string, AgentThread> };
  if (!g.__xiaoluoBrainAgentThreads) g.__xiaoluoBrainAgentThreads = new Map();
  return g.__xiaoluoBrainAgentThreads;
}

function threadKey(userId: string, conversationId: string): string {
  return userId + "::" + conversationId;
}

/** 事件体（宿主视角少了 seq/conversationId/turnId：这三个字段由线程补） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmitInput = DistributiveOmit<wire.AgentEvent, "seq" | "conversationId" | "turnId"> & { turnId?: number };

function emit(thread: AgentThread, event: EmitInput) {
  const full = {
    ...event,
    conversationId: thread.conversationId,
    turnId: event.turnId ?? thread.agent.turnId,
    seq: (thread.seq += 1),
  } as wire.AgentEvent;
  // delta 不进重放缓冲：它只是展示，正文最终由 event/ui 定稿带全文。攒得再狠也可能把 400 条缓冲
  // 刷成碎帧，断线补发时就再也补不到真正的卡片与审批了
  // tool-request 同理不进缓冲：审批重放是「再问老板一次」，工具重放是「再截一次屏/再生成一次」，
  // 机器应答的动作被补发一次就是白跑一遍副作用
  const isStreamDelta = full.method === "event/stream" && full.phase === "delta";
  if (!isStreamDelta && full.method !== "event/tool-request") {
    thread.buffer.push(full);
    if (thread.buffer.length > EVENT_BUFFER) thread.buffer.splice(0, thread.buffer.length - EVENT_BUFFER);
  }
  for (const listener of thread.listeners) {
    try {
      listener(full);
    } catch {
      /* 一个客户端断开不能拖垮回合：广播是尽力而为 */
    }
  }
}

/**
 * 逐字增量往线上发必须先攒：一个 token 一条事件会把重放缓冲区挤满，
 * 断线补发还要重播几千条碎帧。80ms 合并一段再发，观感仍是逐字增长。
 */
function createStreamChannel(holder: { thread?: AgentThread }): NonNullable<ChatAgentPorts["streamUI"]> {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const thread = holder.thread;
    const text = pending;
    pending = "";
    if (!thread || !text) return;
    emit(thread, { method: "event/stream", phase: "delta", text });
  };
  return {
    begin() {
      const thread = holder.thread;
      if (!thread) return;
      flush();
      emit(thread, { method: "event/stream", phase: "begin" });
    },
    delta(text: string) {
      if (!text) return;
      pending += text;
      if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS);
    },
    end() {
      flush();
      const thread = holder.thread;
      if (thread) emit(thread, { method: "event/stream", phase: "end" });
    },
  };
}

interface ThreadPortsInput {
  userId: string;
  /** 程序库按对话 upsert 的那个 key：端口面自己不带线程号，所以要从线程交下来 */
  conversationId: string;
  canvasId: string;
  modelId: string;
  callModel?: ModelCaller;
  /** 当前宿主声明能代跑的端口：注册与否只看这一份 */
  hostTools: wire.HostToolPort[];
  hostModelVision: boolean;
  /** 宿主报上来的 MCP 工具清单（只有声明了 mcp 口才交上去） */
  mcpTools: McpToolInfo[];
  /** 宿主报的文件档位（缺省由调用方 normalize 成 default） */
  permissionMode: wire.PermissionMode;
}

/**
 * 线程的端口面：服务端自带的口就近实现，只有宿主才有的口（画布生成、截屏、CDP、UIA、SSH）
 * 隔着反向通道代跑。换宿主时整份重搭 —— 工具注册是从 ports 推出来的，端口面不重搭，
 * 小逻就会继续跟一个已经不在路上的宿主要点截图。
 */
function buildThreadPorts(input: ThreadPortsInput, holder: { thread?: AgentThread }): ChatAgentPorts {
  return createServerPorts({
    userId: input.userId,
    conversationId: input.conversationId,
    canvasId: input.canvasId,
    modelId: input.modelId,
    ...(input.callModel ? { callModel: input.callModel } : {}),
    hostTools: input.hostTools,
    mcpTools: input.mcpTools,
    permissionMode: input.permissionMode,
    streamUI: createStreamChannel(holder),
    emitUi: (kind: ChatUIKind, content: string, meta?: ChatUIEventMeta) => {
      const thread = holder.thread;
      if (!thread) return;
      emit(thread, { method: "event/ui", kind, content, meta });
    },
    requestApproval: async (req: ApprovalRequest) => {
      const thread = holder.thread;
      if (!thread) return false;
      return await requestApproval(thread, req);
    },
    requestHostTool: async (port: wire.HostToolPort, call: string, args: unknown[]) => {
      const thread = holder.thread;
      if (!thread) throw new Error("线程宿主未就绪，无法请宿主代跑 " + port + "." + call);
      return await requestHostTool(thread, port, call, args);
    },
    /** 视觉判定跟着宿主走：同一句 inspect_screen，换了支持视觉的模型就不该再降级成 DOM */
    getHostModelVision: () => holder.thread?.hostModelVision ?? false,
    /** 程序库落盘的任务名：现读线程上第一句老板原话，重建端口面也不用重传 */
    getTaskTitle: () => holder.thread?.taskTitle ?? "",
    auditApproval: (entry) => {
      holder.thread?.agent.journal.append("approval", `审批留痕：${entry.ok ? "批准" : "拒绝"} ${entry.scope} ${entry.subject.slice(0, 60)}`);
    },
  });
}

function newThread(input: {
  userId: string;
  conversationId: string;
  canvasId: string;
  modelId: string;
  capabilityCatalog?: string;
  localExecution?: boolean;
  systemPrompt?: string;
  snapshot?: wire.AgentThreadSnapshot;
  callModel?: ModelCaller;
  hostTools?: wire.HostToolPort[];
  hostModelVision?: boolean;
  mcpTools?: McpToolInfo[];
  permissionMode?: wire.PermissionMode;
  /** 分叉出来的分支沿用主干任务名：程序库按对话 upsert，分支写出的程序该接着同名 */
  taskTitle?: string;
}): AgentThread {
  const holder: { thread?: AgentThread } = {};
  const hostTools = new Set(input.hostTools ?? []);
  const mcpTools = input.mcpTools ?? [];
  const permissionMode = input.permissionMode ?? "default";
  const ports = buildThreadPorts(
    {
      userId: input.userId,
      conversationId: input.conversationId,
      canvasId: input.canvasId,
      modelId: input.modelId,
      ...(input.callModel ? { callModel: input.callModel } : {}),
      hostTools: [...hostTools],
      hostModelVision: input.hostModelVision === true,
      mcpTools,
      permissionMode,
    },
    holder,
  );

  const agent = createChatAgent(
    {
      ports,
      model: input.modelId,
      conversationId: input.conversationId,
      capabilityCatalog: input.capabilityCatalog,
      localExecution: input.localExecution,
      systemPrompt: input.systemPrompt,
      config: DEFAULT_CHAT_AGENT_CONFIG,
    },
    input.snapshot?.messages,
    input.snapshot?.lastCode ?? undefined,
  );
  if (input.snapshot) {
    agent.resumeFrom({
      goal: input.snapshot.goal,
      dirtyCodeFiles: input.snapshot.dirtyCodeFiles,
      readPaths: input.snapshot.readPaths,
    });
  }
  const thread: AgentThread = {
    userId: input.userId,
    conversationId: input.conversationId,
    canvasId: input.canvasId,
    modelId: input.modelId,
    agent,
    ...(input.callModel ? { callModel: input.callModel } : {}),
    seq: 0,
    buffer: [],
    listeners: new Set(),
    approvals: new Map(),
    hostTools,
    hostModelVision: input.hostModelVision === true,
    mcpTools,
    permissionMode,
    hostToolCalls: new Map(),
    taskTitle: "",
    rebuildPorts: () => {
      thread.agent.usePorts(
        buildThreadPorts(
          {
            userId: thread.userId,
            conversationId: thread.conversationId,
            canvasId: thread.canvasId,
            modelId: thread.modelId,
            ...(thread.callModel ? { callModel: thread.callModel } : {}),
            hostTools: [...thread.hostTools],
            hostModelVision: thread.hostModelVision,
            mcpTools: thread.mcpTools,
            permissionMode: thread.permissionMode,
          },
          holder,
        ),
      );
    },
    running: false,
    lastUsedAt: Date.now(),
  };
  holder.thread = thread;
  return thread;
}

/**
 * 开一条线程并登记（thread/start、resume、fork 与嵌入式宿主都走这里）。
 * 回收先跑一遍：注册表有上限，新建是天然的淘汰时机。
 */
function openThread(input: Parameters<typeof newThread>[0]): AgentThread {
  pruneIdle();
  const thread = newThread(input);
  registry().set(threadKey(input.userId, input.conversationId), thread);
  return thread;
}

/**
 * 服务进程内的宿主入口（HTTP 路由走 handleAgentRpc，这一份给嵌入式宿主与 bare-Node 测试）。
 * 存档照旧由调用方交出、由调用方收回，内核不认得存档在哪；协议行为与 HTTP 完全一致。
 */
export function openThreadForHost(input: {
  userId: string;
  conversationId: string;
  canvasId: string;
  model: string;
  snapshot?: wire.AgentThreadSnapshot;
  callModel?: ModelCaller;
  hostTools?: wire.HostToolPort[];
  hostModelVision?: boolean;
  mcpTools?: McpToolInfo[];
  permissionMode?: wire.PermissionMode;
}): AgentThread {
  return openThread({
    userId: input.userId,
    conversationId: input.conversationId,
    canvasId: input.canvasId,
    modelId: input.model,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.callModel ? { callModel: input.callModel } : {}),
    ...(input.hostTools ? { hostTools: input.hostTools } : {}),
    ...(input.hostModelVision !== undefined ? { hostModelVision: input.hostModelVision } : {}),
    ...(input.mcpTools ? { mcpTools: input.mcpTools } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
  });
}

/** 审批请求 id：进程内单调递增 + 时间戳短码，跨重启也不会撞 */
let approvalSeq = 0;
function nextApprovalId(): string {
  approvalSeq += 1;
  return "apr-" + approvalSeq.toString(36) + "-" + Date.now().toString(36);
}

/** 要老板批准：推一条 event/approval 给所有订阅者，等 approval/decide；超时按拒绝 */
async function requestApproval(thread: AgentThread, req: ApprovalRequest): Promise<boolean> {
  const approvalId = nextApprovalId();
  const expiresAt = Date.now() + APPROVAL_TIMEOUT_MS;
  emit(thread, { method: "event/approval", approvalId, scope: req.scope, subject: req.subject, action: req.action, reasons: req.reasons, expiresAt });
  return await new Promise<boolean>((resolve) => {
    const settle = (approved: boolean) => {
      clearTimeout(timer);
      thread.approvals.delete(approvalId);
      resolve(approved);
    };
    const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS);
    thread.approvals.set(approvalId, { resolve: settle, timer });
  });
}

/** 反向工具请求 id：与审批同一惯例（进程内单调递增 + 时间戳短码） */
let hostToolSeq = 0;
function nextHostToolId(): string {
  hostToolSeq += 1;
  return "ht-" + hostToolSeq.toString(36) + "-" + Date.now().toString(36);
}

function countInflightHostTools(thread: AgentThread, port: wire.HostToolPort): number {
  let n = 0;
  for (const pending of thread.hostToolCalls.values()) {
    if (pending.port === port) n += 1;
  }
  return n;
}

/**
 * 请宿主代跑一个只有它才有的能力（画布生成、截屏、CDP、UIA、SSH）。
 * 形状与审批完全同构：广播一条 event/tool-request，等宿主回 tool/decide。
 * 差别在失败方向 —— 审批没人答按「拒绝」，这里没答案就是「跑不了」，
 * 必须把理由原样抛回引擎：模型只有看见失败，才不会把这一跳当成已完成。
 */
async function requestHostTool(
  thread: AgentThread,
  port: wire.HostToolPort,
  call: string,
  args: unknown[],
): Promise<unknown> {
  const timeoutMs = HOST_TOOL_TIMEOUT_MS[port];
  const settleEarly = (reason: string): never => {
    thread.agent.journal.append("tool_result", `宿主代跑 ${port}.${call}：${reason}`);
    throw new Error(`${port}.${call} 没能交给宿主执行：${reason}`);
  };
  // 宿主换人后工具面还是上一任那份时（回合跑一半不换端口），当场说清楚，别等超时
  if (!thread.hostTools.has(port)) {
    settleEarly("当前宿主没有声明能代跑这个口（能力面已随换宿主收回）");
  }
  // 一个订阅者都没有 = 没人会来回话：直接失败，别让模型白等几十秒
  if (thread.listeners.size === 0) {
    settleEarly("宿主没连着事件流，收不到这条请求");
  }
  if (countInflightHostTools(thread, port) >= HOST_TOOL_INFLIGHT_MAX) {
    settleEarly("这个口已经有 " + HOST_TOOL_INFLIGHT_MAX + " 个请求挂在路上，先等宿主把它们跑完");
  }

  const requestId = nextHostToolId();
  const expiresAt = Date.now() + timeoutMs;
  emit(thread, { method: "event/tool-request", requestId, port, call, args, expiresAt });
  const startedAt = Date.now();
  const reply = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
    const settle = (r: { ok: boolean; result?: unknown; error?: string }) => {
      clearTimeout(timer);
      thread.hostToolCalls.delete(requestId);
      resolve(r);
    };
    const timer = setTimeout(
      () => settle({ ok: false, error: `宿主 ${Math.round(timeoutMs / 1000)} 秒内没回话（页面可能已关掉或卡住）` }),
      timeoutMs,
    );
    thread.hostToolCalls.set(requestId, { port, call, resolve: settle, timer });
  });
  const elapsedMs = Date.now() - startedAt;
  thread.agent.journal.append(
    "tool_result",
    `宿主代跑 ${port}.${call}：${reply.ok ? "成功" : "失败"}（${elapsedMs}ms）${reply.error ? " " + reply.error.slice(0, 120) : ""}`,
  );
  if (!reply.ok) throw new Error(reply.error || "宿主代跑失败");
  return reply.result;
}

/** 宿主声明的端口名只认协议里那几个：拼错的、不认识的都不算声明（不给一个假口开工具面） */
function normalizeHostTools(value: unknown): wire.HostToolPort[] {
  if (!Array.isArray(value)) return [];
  const out: wire.HostToolPort[] = [];
  for (const item of value) {
    if (wire.HOST_TOOL_PORTS.includes(item as wire.HostToolPort) && !out.includes(item as wire.HostToolPort)) {
      out.push(item as wire.HostToolPort);
    }
  }
  return out;
}

/** 从 thread/* 的 params 里取宿主的代跑声明（hostTools + 模型视觉判定 + MCP 工具清单 + 文件档位） */
function hostToolDecl(params: unknown): HostDecl {
  const p = (params ?? {}) as { hostTools?: unknown; hostModelVision?: unknown; mcpTools?: unknown; permissionMode?: unknown };
  return {
    hostTools: normalizeHostTools(p.hostTools),
    hostModelVision: p.hostModelVision === true,
    mcpTools: normalizeMcpTools(p.mcpTools),
    permissionMode: wire.normalizePermissionMode(p.permissionMode),
  };
}

/**
 * MCP 清单只收引擎认得的那几把：
 * 分发靠 mcp__ 前缀路由（chat-agent dispatchTool），收下别的名字等于让宿主往工具面塞
 * 一个 model 叫了却没人应答的假工具，甚至撞掉内置工具的名字。上限同样由内核定：
 * 一台失控的 MCP 服务器报几千把工具，不该把整张工具面挤没。
 */
function normalizeMcpTools(value: unknown): McpToolInfo[] {
  if (!Array.isArray(value)) return [];
  const out: McpToolInfo[] = [];
  for (const item of value as Array<Partial<McpToolInfo> | null>) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name.startsWith("mcp__")) continue;
    if (out.some((t) => t.name === name)) continue;
    out.push({
      name,
      description: typeof item?.description === "string" ? item.description : "",
      ...(item?.inputSchema && typeof item.inputSchema === "object" ? { inputSchema: item.inputSchema as Record<string, unknown> } : {}),
    });
    if (out.length >= MCP_TOOLS_MAX) break;
  }
  return out;
}

/** 清单是否等价：只看公开名集合（描述变了不影响注册面，值变了宿主重报即可） */
function sameMcpTools(a: McpToolInfo[], b: McpToolInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.name === b[i]?.name);
}

/**
 * 换宿主 = 代跑能力面整份重谈（桌面宿主有 CDP/UIA/MCP，浏览器标签页只有画布生成）。
 * 回合跑一半不动端口面：那等于把模型正在等的口从脚下抽走，等下一轮开头再按新宿主重建。
 * 文件档位也走这一条：换到桌面壳就多几个口、档位跟着宿主报的那份变，但放宽也只在下轮落地。
 */
function applyHostTools(thread: AgentThread, decl: HostDecl): void {
  // 视觉判定是每次 inspect_screen 现读的，换了宿主立刻生效，不必等端口重建
  thread.hostModelVision = decl.hostModelVision;
  const same =
    decl.hostTools.length === thread.hostTools.size &&
    decl.hostTools.every((p) => thread.hostTools.has(p)) &&
    sameMcpTools(decl.mcpTools, thread.mcpTools) &&
    decl.permissionMode === thread.permissionMode;
  if (same) return;
  const summary = "代跑口=" + (decl.hostTools.length ? decl.hostTools.join("/") : "无") +
    "，MCP 工具=" + decl.mcpTools.length + " 把，文件档位=" + decl.permissionMode;
  if (thread.running) {
    thread.pendingHostDecl = decl;
    thread.agent.journal.append("host", `宿主能力面待切换（本轮还在跑）：${summary}`);
    return;
  }
  thread.pendingHostDecl = undefined;
  thread.hostTools = new Set(decl.hostTools);
  thread.mcpTools = decl.mcpTools;
  thread.permissionMode = decl.permissionMode;
  thread.rebuildPorts();
  thread.agent.journal.append("host", `宿主能力面已切换：${summary}，模型视觉=${decl.hostModelVision ? "有" : "无"}`);
}

/** 线程收口：定时器一律摘掉，否则被回收的线程会一直攥着挂起的 Promise */
function releasePending(thread: AgentThread): void {
  for (const [, pending] of thread.approvals) clearTimeout(pending.timer);
  thread.approvals.clear();
  for (const [, pending] of thread.hostToolCalls) clearTimeout(pending.timer);
  thread.hostToolCalls.clear();
}

function pruneIdle(): void {
  const reg = registry();
  const now = Date.now();
  for (const [key, thread] of reg) {
    if (thread.running) continue;
    if (now - thread.lastUsedAt > THREAD_IDLE_TTL_MS) {
      releasePending(thread);
      thread.listeners.clear();
      reg.delete(key);
    }
  }
  // 还在 TTL 内但数量顶到上限：淘汰最久没用的（历史在宿主手里，丢了能 resume 回来）
  while (reg.size >= MAX_THREADS) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, thread] of reg) {
      if (thread.running) continue;
      if (thread.lastUsedAt < oldest) {
        oldest = thread.lastUsedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const victim = reg.get(oldestKey);
    victim?.agent.stop();
    if (victim) releasePending(victim);
    victim?.listeners.clear();
    reg.delete(oldestKey);
  }
}

function getThread(userId: string, conversationId: string): AgentThread | undefined {
  const thread = registry().get(threadKey(userId, conversationId));
  if (thread) thread.lastUsedAt = Date.now();
  return thread;
}

function snapshotOf(thread: AgentThread): wire.AgentThreadSnapshot {
  const s = thread.agent.serialize();
  return {
    messages: s.messages,
    usedTokens: s.usedTokens,
    lastCode: s.lastCode,
    goal: s.goal,
    dirtyCodeFiles: s.dirtyCodeFiles,
    readPaths: s.readPaths,
  };
}

/** 活线程 → ChatPersistence（只为复用 buildForkSnapshot 的取舍规则） */
function persistenceOf(thread: AgentThread): ChatPersistence {
  const s = snapshotOf(thread);
  return {
    version: 1,
    conversationId: thread.conversationId,
    messages: s.messages,
    usedTokens: s.usedTokens,
    uiMessages: [],
    savedAt: Date.now(),
    ...(s.lastCode ? { lastCode: s.lastCode } : {}),
    ...(s.goal ? { goal: s.goal } : {}),
    ...(s.dirtyCodeFiles.length ? { dirtyCodeFiles: s.dirtyCodeFiles } : {}),
    ...(s.readPaths.length ? { readPaths: s.readPaths } : {}),
  };
}

function snapshotFromPersistence(p: ChatPersistence): wire.AgentThreadSnapshot {
  return {
    messages: p.messages,
    usedTokens: p.usedTokens,
    lastCode: p.lastCode ?? null,
    goal: p.goal ?? null,
    dirtyCodeFiles: p.dirtyCodeFiles ?? [],
    readPaths: p.readPaths ?? [],
  };
}

/**
 * 线程是否已被别的宿主占用：同一条线程只允许一个回合在跑（turn/start 的幂等保护）。
 * 两个标签页同时开同一 cid 是安全的 —— 它们看到的是同一个 Agent 与同一份事件流。
 */
function requireIdle(thread: AgentThread): void {
  if (!thread.running) return;
  throw new StaleRpcError(wire.RPC.TURN_RUNNING, "这条对话已有回合在跑；要补充请走 turn/steer，要停走 turn/interrupt");
}

class StaleRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** 起一轮：reply() 同步跑到第一个 await，所以 turnId 立刻可读 */
function startTurn(thread: AgentThread, params: wire.TurnStartParams): { turnId: number } {
  requireIdle(thread);
  thread.running = true;
  thread.lastUsedAt = Date.now();
  // 任务名取这条对话的第一句原话（面板宿主那侧是 currentTask.title，同一口径）：程序库落盘靠它命名
  if (!thread.taskTitle) thread.taskTitle = params.text.slice(0, 120);
  const pending = thread.agent.reply(params.text, params.attachments ?? [], params.images);
  const turnId = thread.agent.turnId;
  emit(thread, { method: "event/turn", phase: "started", turnId });
  void pending
    .then((outcome) => {
      // 先落回空闲再发 ended：宿主见到结束回执就该能立刻起下一轮，
      // 而不是隔一个微任务才解锁，撞上「已有回合在跑」
      markIdle(thread);
      emit(thread, {
        method: "event/turn",
        phase: "ended",
        turnId,
        outcome: {
          usedTokens: outcome.usedTokens,
          steps: outcome.steps,
          ...(outcome.interrupted !== undefined ? { interrupted: outcome.interrupted } : {}),
          ...(outcome.stopped !== undefined ? { stopped: outcome.stopped } : {}),
          ...(outcome.budgetExhausted !== undefined ? { budgetExhausted: outcome.budgetExhausted } : {}),
        },
      });
    })
    .catch((e: unknown) => {
      markIdle(thread);
      emit(thread, {
        method: "event/error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
      });
    })
    .finally(() => {
      markIdle(thread);
      pruneIdle();
    });
  return { turnId };
}

/** 回合结束 = 线程立即可用；ended 事件发出前落回 false，宿主才不会撞 TURN_RUNNING */
function markIdle(thread: AgentThread): void {
  thread.running = false;
  thread.lastUsedAt = Date.now();
  // 回合跑一半时换来的新宿主：端口面没在用的这一刻才落地，下一轮按新宿主的代跑能力建工具面
  const deferred = thread.pendingHostDecl;
  if (deferred) {
    thread.pendingHostDecl = undefined;
    applyHostTools(thread, deferred);
  }
}

// ---------- RPC 分发 ----------

/**
 * 处理一条 JSON-RPC 请求。鉴权/限流由调用方（HTTP 路由）负责，这里只认协议。
 * 返回值要么是 result 要么是 error，绝不抛（抛出去会变成 500，宿主看不出是协议的锅）。
 */
export async function handleAgentRpc(userId: string, body: unknown): Promise<wire.JsonRpcResponse> {
  const parsed = wire.parseJsonRpcRequest(body);
  if (!parsed.ok) {
    return wire.jsonRpcError(typeof body === "object" && body !== null && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : null, parsed.code, parsed.message);
  }
  const { id, method, params } = parsed.request;
  try {
    return wire.jsonRpcResult(id, await dispatch(userId, method, params));
  } catch (e) {
    if (e instanceof wire.RpcParamError) return wire.jsonRpcError(id, wire.RPC.INVALID_PARAMS, e.message);
    if (e instanceof StaleRpcError) return wire.jsonRpcError(id, e.code, e.message);
    return wire.jsonRpcError(id, wire.RPC.INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
  }
}

async function dispatch(userId: string, method: wire.AgentRpcMethod, params: unknown): Promise<unknown> {
  switch (method) {
    case "thread/start": {
      const p = params as ThreadStartParamsWithSnapshot | undefined;
      const conversationId = wire.requireString(p, "conversationId");
      const canvasId = wire.requireString(p, "canvasId");
      const modelId = wire.requireString(p, "model");
      const decl = hostToolDecl(p);
      const existing = getThread(userId, conversationId);
      if (existing) {
        existing.agent.updateModel(modelId);
        // 换宿主重连（关了桌面端再开标签页）：代跑能力面按新宿主重谈，否则小逻会照着上一任的能力清单点菜
        applyHostTools(existing, decl);
        return { conversationId, existed: true, seq: existing.seq } satisfies wire.ThreadHandleResult;
      }
      const snapshot = wire.optionalObject<wire.AgentThreadSnapshot>(p, "snapshot");
      const created = openThread({
        userId,
        conversationId,
        canvasId,
        modelId,
        capabilityCatalog: typeof p?.capabilityCatalog === "string" ? p.capabilityCatalog : undefined,
        localExecution: p?.localExecution === true,
        systemPrompt: typeof p?.systemPrompt === "string" ? p.systemPrompt : undefined,
        snapshot,
        hostTools: decl.hostTools,
        hostModelVision: decl.hostModelVision,
        mcpTools: decl.mcpTools,
        permissionMode: decl.permissionMode,
      });
      return { conversationId, existed: false, seq: created.seq } satisfies wire.ThreadHandleResult;
    }
    case "thread/resume": {
      const p = params as (wire.ThreadResumeParams | undefined) ?? undefined;
      const conversationId = wire.requireString(p, "conversationId");
      const canvasId = wire.requireString(p, "canvasId");
      const modelId = wire.requireString(p, "model");
      const snapshot = wire.optionalObject<wire.AgentThreadSnapshot>(p, "snapshot");
      if (!snapshot || !Array.isArray(snapshot.messages)) {
        throw new wire.RpcParamError("thread/resume 需要 params.snapshot（含 messages）；没有存档就用 thread/start");
      }
      const decl = hostToolDecl(p);
      const key = threadKey(userId, conversationId);
      const existing = registry().get(key);
      if (existing) {
        // 已活着就不重建：宿主那份存档可能比内存里的旧（例如两个标签页）
        existing.agent.updateModel(modelId);
        existing.lastUsedAt = Date.now();
        applyHostTools(existing, decl);
        return { conversationId, existed: true, seq: existing.seq } satisfies wire.ThreadHandleResult;
      }
      const resumed = openThread({
        userId,
        conversationId,
        canvasId,
        modelId,
        snapshot,
        hostTools: decl.hostTools,
        hostModelVision: decl.hostModelVision,
        mcpTools: decl.mcpTools,
        permissionMode: decl.permissionMode,
      });
      return { conversationId, existed: false, seq: resumed.seq } satisfies wire.ThreadHandleResult;
    }
    case "thread/fork": {
      const p = params as (wire.ThreadForkParams | undefined) ?? undefined;
      const from = wire.requireString(p, "fromConversationId");
      const canvasId = wire.requireString(p, "canvasId");
      const modelId = wire.requireString(p, "model");
      const source = getThread(userId, from);
      const given = wire.optionalObject<wire.AgentThreadSnapshot>(p, "sourceSnapshot");
      let base: ChatPersistence | undefined;
      if (given) base = { version: 1, savedAt: Date.now(), ...snapshotToPersistenceFields(from, given) };
      else if (source) base = persistenceOf(source);
      if (!base) {
        throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "源线程不在服务里，宿主也没交存档：先 thread/resume 再分叉");
      }
      if (base.messages.filter((m) => m.role !== "system").length === 0) {
        throw new wire.RpcParamError("源对话还是空的，没有可分叉的内容");
      }
      // 分支 id 由服务端按固定规则生成：宿主自己拼容易撞车（存档名 sanitize 后落到同一个文件）
      const conversationId = forkConversationId(from, Date.now());
      const forked = buildForkSnapshot(base, conversationId);
      // 源线程还活着就沿用它的宿主声明（含 MCP 清单）；只剩存档时按这次调用带来的那份建分支
      const decl: HostDecl = source
        ? { hostTools: [...source.hostTools], hostModelVision: source.hostModelVision, mcpTools: source.mcpTools, permissionMode: source.permissionMode }
        : hostToolDecl(p);
      const thread = openThread({
        userId,
        conversationId,
        canvasId,
        modelId: modelId || source?.modelId || "",
        taskTitle: source?.taskTitle,
        snapshot: snapshotFromPersistence(forked),
        callModel: source?.callModel,
        hostTools: decl.hostTools,
        hostModelVision: decl.hostModelVision,
        mcpTools: decl.mcpTools,
        permissionMode: decl.permissionMode,
      });
      const note = forked.uiMessages?.at(-1) as { content?: string } | undefined;
      emit(thread, {
        method: "event/ui",
        kind: "status",
        content: note?.content ?? "已分叉出分支对话",
        meta: { tool: "conversation_fork", target: conversationId, ok: true },
      });
      return {
        conversationId,
        existed: false,
        seq: thread.seq,
        forkedFrom: from,
        snapshot: snapshotOf(thread),
      } satisfies wire.ThreadForkResult;
    }
    case "thread/read": {
      const conversationId = wire.requireString(params, "conversationId");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收），请 thread/resume 重建");
      return { snapshot: snapshotOf(thread), turnId: thread.agent.turnId, running: thread.running } satisfies wire.ThreadReadResult;
    }
    case "thread/capabilities": {
      const conversationId = wire.requireString(params, "conversationId");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收），请 thread/resume 重建");
      const ports = threadAgentPorts(thread);
      const caps = chatToolCapabilities(ports);
      return {
        conversationId,
        toolNames: buildChatToolSchemas(caps).map((t) => (t as { function?: { name?: string } }).function?.name ?? ""),
        caps: runtimeToolCaps(ports),
      } satisfies wire.ThreadCapabilitiesResult;
    }
    case "thread/model/update": {
      const conversationId = wire.requireString(params, "conversationId");
      const model = wire.requireString(params, "model");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      thread.modelId = model;
      thread.agent.updateModel(model);
      return { conversationId, model };
    }
    case "thread/artifact/edit": {
      const conversationId = wire.requireString(params, "conversationId");
      const edits = ((params ?? {}) as { edits?: Array<{ path: string; content: string }> }).edits ?? [];
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      return { changed: thread.agent.mergeArtifactFiles(edits) };
    }
    case "thread/journal": {
      const conversationId = wire.requireString(params, "conversationId");
      const limit = Number.isFinite((params as { limit?: number } | undefined)?.limit) ? Number((params as { limit: number }).limit) : 8;
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      const entries: wire.ThreadJournalEntry[] = thread.agent.journal
        .recent(Math.min(200, Math.max(1, Math.trunc(limit))))
        .map((e) => ({ ts: e.ts, kind: String(e.kind), note: e.note }));
      return { entries };
    }
    case "turn/start": {
      const conversationId = wire.requireString(params, "conversationId");
      const text = wire.requireString(params, "text");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收），请 thread/resume 重建");
      const p = (params ?? {}) as { attachments?: string[]; images?: TurnStartParams["images"] };
      const { turnId } = startTurn(thread, { conversationId, text, attachments: p.attachments, images: p.images });
      return { conversationId, turnId, started: true } satisfies wire.TurnStartResult;
    }
    case "turn/steer": {
      const conversationId = wire.requireString(params, "conversationId");
      const text = wire.requireString(params, "text");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      thread.agent.steer(text);
      return { conversationId, queued: true, running: thread.running };
    }
    case "turn/answer": {
      const conversationId = wire.requireString(params, "conversationId");
      const answer = wire.optionalObject<{ text?: string; selected?: string; attachments?: string[]; skipped?: boolean }>(params, "answer");
      if (!answer) throw new wire.RpcParamError("turn/answer 需要 params.answer");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      if (!thread.agent.hasPendingAsk()) {
        throw new StaleRpcError(wire.RPC.NO_PENDING_ASK, "这条对话当前没有挂起的反问，应答无处可去");
      }
      thread.agent.answerAsk(answer);
      return { conversationId, answered: true };
    }
    case "turn/interrupt": {
      const conversationId = wire.requireString(params, "conversationId");
      const thread = getThread(userId, conversationId);
      if (!thread) throw new StaleRpcError(wire.RPC.THREAD_NOT_FOUND, "线程不在服务里（可能已回收）");
      const wasRunning = thread.running;
      thread.agent.stop();
      // 中止要立刻见效：命令子进程跑在服务进程里，宿主掐自己那头的 fetch 没用
      threadAgentPorts(thread).command?.cancelAll?.();
      return { conversationId, wasRunning };
    }
    case "approval/decide": {
      const conversationId = wire.requireString(params, "conversationId");
      const approvalId = wire.requireString(params, "approvalId");
      const approved = (params as { approved?: boolean } | undefined)?.approved === true;
      const thread = getThread(userId, conversationId);
      const pending = thread?.approvals.get(approvalId);
      if (!thread || !pending) {
        return { decided: false, reason: "审批请求已超时或已被应答" } satisfies wire.ApprovalDecideResult;
      }
      pending.resolve(approved);
      return { decided: true } satisfies wire.ApprovalDecideResult;
    }
    case "tool/decide": {
      const conversationId = wire.requireString(params, "conversationId");
      const requestId = wire.requireString(params, "requestId");
      const p = (params ?? {}) as { ok?: unknown; result?: unknown; error?: unknown };
      const thread = getThread(userId, conversationId);
      const pending = thread?.hostToolCalls.get(requestId);
      if (!thread || !pending) {
        return { settled: false, reason: "反向工具请求已超时或已被应答" } satisfies wire.ToolDecideResult;
      }
      const ok = p.ok === true;
      const error = typeof p.error === "string" && p.error.trim() ? p.error.trim() : undefined;
      pending.resolve({ ok, ...(ok ? { result: p.result } : { error: error ?? "宿主代跑失败（未给出理由）" }) });
      return { settled: true } satisfies wire.ToolDecideResult;
    }
    default:
      throw new StaleRpcError(wire.RPC.METHOD_NOT_FOUND, "未知方法：" + String(method));
  }
}

type ThreadStartParamsWithSnapshot = wire.ThreadStartParams & { snapshot?: wire.AgentThreadSnapshot };

type TurnStartParams = wire.TurnStartParams;

/** 存档字段 → ChatPersistence 必填那几项（分叉规则只看这些，UI 流由宿主自己管） */
function snapshotToPersistenceFields(conversationId: string, s: wire.AgentThreadSnapshot): Omit<ChatPersistence, "version" | "savedAt"> {
  return {
    conversationId,
    messages: s.messages,
    usedTokens: s.usedTokens,
    uiMessages: [],
    ...(s.lastCode ? { lastCode: s.lastCode } : {}),
    ...(s.goal ? { goal: s.goal } : {}),
    ...(s.dirtyCodeFiles.length ? { dirtyCodeFiles: s.dirtyCodeFiles } : {}),
    ...(s.readPaths.length ? { readPaths: s.readPaths } : {}),
  };
}

/** 线程的端口取自引擎当前持有那份（宿主没另存，所以从 agent 的 opts 里拿） */
function threadAgentPorts(thread: AgentThread) {
  return (thread.agent as unknown as { opts: { ports: Parameters<typeof chatToolCapabilities>[0] } }).opts.ports;
}

// ---------- 事件订阅（SSE 用） ----------

export interface ThreadSubscription {
  /** 缓冲区里还留着的历史事件（宿主按 lastSeq 之后自行过滤） */
  replay: wire.AgentEvent[];
  /** 挂上后要放掉的回调 */
  detach: () => void;
}

/**
 * 把一条连接挂到某条线程的事件流上：返回缓冲区里可补发的事件与取消函数。
 * 每条连接一个独立回调，一个客户端写失败不影响别的连接。
 */
export function attachThreadListener(
  userId: string,
  conversationId: string,
  onEvent: (event: wire.AgentEvent) => void,
): ThreadSubscription | null {
  const thread = getThread(userId, conversationId);
  if (!thread) return null;
  thread.listeners.add(onEvent);
  return {
    replay: thread.buffer.slice(),
    detach: () => {
      thread.listeners.delete(onEvent);
    },
  };
}

/** 测试与运维用：当前活着的线程数（不含用户隔离细节） */
export function agentThreadCount(): number {
  return registry().size;
}

/** 测试用：清掉所有线程（别在生产调用） */
export function resetAgentThreads(): void {
  const reg = registry();
  for (const thread of reg.values()) {
    thread.agent.stop();
    releasePending(thread);
    thread.listeners.clear();
  }
  reg.clear();
}
