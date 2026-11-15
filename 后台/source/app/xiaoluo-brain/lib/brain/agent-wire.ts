/**
 * 小逻 v3 —— app-server 线协议（P3：真正的进程边界）
 *
 * 对齐 Codex 的 app-server-protocol：宿主与内核之间只走这一份 JSON-RPC 2.0 信封，
 * 方法面就是 thread/*（线程生命周期）+ turn/*（回合控制），内核向宿主只推 event/*。
 *
 * 本文件是「协议」不是「实现」：
 *  - 运行时依赖为零（其余全是 `import type`），浏览器 / Node CLI / 桌面主进程 / 服务端共用同一份定义；
 *  - 方法名、错误码、事件体在这里定型，改协议 = 改一处，两侧（agent-server.ts 与 agent-client.ts）都引用它；
 *  - SSE 帧的编解码也放这里（encodeSseFrame / createSseParser），免得客户端各写一份解析器。
 *
 * 存档所有权仍在宿主：thread/resume 与 thread/fork 由宿主把 ChatPersistence 交进来，
 * thread/read 把快照还给宿主去落盘。内核不猜存档在哪，因此换宿主不需要动持久化。
 *
 * 反向通道（P6）：event/approval → approval/decide 是「内核问、宿主答」的第一条线，
 * event/tool-request → tool/decide 照它抄第二条。有的能力物理上只能在宿主里
 * （画布节点、内嵌浏览器截屏、CDP、Windows UIA、本机 SSH 密钥），内核在服务进程里
 * 拿不到就注册不了工具。宿主在 thread/start 时用 hostTools 声明自己能代跑哪几口，
 * 内核只把声明过的口注册上去 —— 声明与注册同一份依据，不会注册一个必然失败的口。
 */

import type { ChatUIEventMeta, ChatUIKind } from "./agent-ports";
import type { AskUserAnswer, ChatMessage, CodeArtifact, McpToolInfo } from "./types";
import type { RuntimeToolCaps } from "./prompts";

/** 线协议版本：两侧握手时带上，不兼容就当场报错，别让老客户端静默跑偏 */
export const AGENT_PROTOCOL_VERSION = 1;
export const JSONRPC_VERSION = "2.0";

// ---------- 方法面 ----------

export type AgentThreadMethod =
  | "thread/start"
  | "thread/resume"
  | "thread/fork"
  | "thread/read"
  | "thread/capabilities"
  | "thread/model/update"
  | "thread/artifact/edit"
  | "thread/journal";

export type AgentTurnMethod = "turn/start" | "turn/steer" | "turn/answer" | "turn/interrupt";

/** 审批应答：内核要执行需要批准的操作时先挂起，宿主决定后才继续（对应浏览器宿主的 confirm） */
export type AgentApprovalMethod = "approval/decide";

/** 反向工具应答：内核要用只有宿主才有的能力（画布节点、CDP、UIA…）时挂起，等宿主代跑结果 */
export type AgentHostToolMethod = "tool/decide";

export type AgentRpcMethod = AgentThreadMethod | AgentTurnMethod | AgentApprovalMethod | AgentHostToolMethod;

export type AgentEventMethod =
  | "event/ui"
  | "event/stream"
  | "event/turn"
  | "event/approval"
  | "event/tool-request"
  | "event/error";

/**
 * 内核侧的断点账快照（= ChatAgent.serialize() 的返回）。
 * 宿主只负责存它、原样交回来；字段含义见 chat-agent.ts 的 serialize()。
 */
export interface AgentThreadSnapshot {
  messages: ChatMessage[];
  usedTokens: number;
  lastCode: CodeArtifact | null;
  goal: { goal: string; criteria: string; setAt: number } | null;
  dirtyCodeFiles: string[];
  readPaths: string[];
}

// ---------- 请求参数 ----------

/**
 * 宿主的文件权限档位（与 /api/v2/brain/fs 的 mode 同一份口径、同一个信任边界：都是登录用户本人）：
 * default = 只碰这个用户的大脑工作区；auto = 越界只读放行；full = 绝对路径直接读写。
 * 只喂文件口（list/read/write/grep/find）；命令口不吃这一份，它有自己的风险分级与审批门。
 */
export type PermissionMode = "default" | "auto" | "full";

/** 宿主报的档位只认这三个字，别的（含拼错、含 undefined）一律回落 default */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "auto" || value === "full" ? value : "default";
}

/** 线程身份：canvasId + modelId 是 LLM 网关的准入对（凭据解析与权限都按它走） */
export interface ThreadHandleParams {
  conversationId: string;
  /** 模型连接 id（modelConnections.id） */
  model: string;
  /** 网关鉴权用的画布归属 */
  canvasId: string;
}

export interface ThreadStartParams extends ThreadHandleParams {
  /** 能力清单文本（Skill/模型逐行）；空 = 不列 */
  capabilityCatalog?: string;
  /** 本机执行形态（桌面宿主 true） */
  localExecution?: boolean;
  /** 整份替换系统提示词 */
  systemPrompt?: string;
  /**
   * 本宿主能代跑的端口名（见 HostToolPort）。
   * 只声明不给 = 内核不注册对应工具；给了但跑不了 = 宿主回 tool/decide 失败，理由回流给模型。
   */
  hostTools?: HostToolPort[];
  /** 当前模型是否具备视觉能力（宿主判定）：vision 口用它决定 inspect_screen 是否降级为 DOM 快照 */
  hostModelVision?: boolean;
  /**
   * 宿主已发现的 MCP 工具清单（声明了 mcp 口才有效）：
   * 工具面按这份注册，服务端不猜宿主连了哪几台 MCP 服务器。
   */
  mcpTools?: McpToolInfo[];
  /** 本宿主的文件权限档位（缺省 default）：内核按它建文件口，换宿主就重谈 */
  permissionMode?: PermissionMode;
}

/** 恢复线程：宿主把存档交回来（messages 含系统提示词轮） */
export interface ThreadResumeParams extends ThreadStartParams {
  snapshot: AgentThreadSnapshot;
}

/**
 * 分叉线程：源可以是内核里活着的线程（只给 fromConversationId），
 * 也可以是宿主手里的存档（再给 sourceSnapshot）——两条路都走 buildForkSnapshot。
 * 分支 id 由服务端生成（forkConversationId 的规则），宿主别自己拼，免得两条分支撞进同一份存档。
 */
export interface ThreadForkParams {
  /** 分支的模型/画布归属（缺省沿用源线程） */
  model: string;
  canvasId: string;
  fromConversationId: string;
  sourceSnapshot?: AgentThreadSnapshot;
  /**
   * 分叉时宿主自己声明代跑能力：源线程还活着时服务端沿用源线程那份，
   * 源已经不在了（宿主只交了存档）才按这份建分支的工具面。
   */
  hostTools?: HostToolPort[];
  hostModelVision?: boolean;
  /** 源线程不在了才用这份 MCP 清单（同 hostTools 的取舍） */
  mcpTools?: McpToolInfo[];
  /** 源线程不在了才用这份档位（活着就沿用主干那一档，分支不该比主干更宽） */
  permissionMode?: PermissionMode;
}

export interface ThreadReadParams {
  conversationId: string;
}

export interface ThreadCapabilitiesParams {
  conversationId: string;
}

export interface ThreadModelUpdateParams {
  conversationId: string;
  model: string;
}

export interface ThreadArtifactEditParams {
  conversationId: string;
  edits: Array<{ path: string; content: string }>;
}

export interface ThreadJournalParams {
  conversationId: string;
  limit?: number;
}

export interface TurnStartParams extends ThreadReadParams {
  text: string;
  attachments?: string[];
  images?: Array<{ mimeType: string; dataUrl: string }>;
}

export interface TurnSteerParams extends ThreadReadParams {
  text: string;
}

export interface TurnAnswerParams extends ThreadReadParams {
  answer: AskUserAnswer;
}

export interface TurnInterruptParams extends ThreadReadParams {}

/**
 * 审批请求（内核 → 宿主）：命令风险 / 网络策略 / 路径围栏 / git push 都走这一条。
 * 闸门语义只有一份（app/lib/brain-command-gate.ts），这里只负责把它搬到线上。
 */
export interface AgentApprovalEvent extends AgentEventBase {
  method: "event/approval";
  /** 应答 approval/decide 时要带回来，宿主据此配对 */
  approvalId: string;
  scope: "command" | "stdin" | "git" | "service" | "service-setup";
  /** 要执行的具体内容（命令原文 / 会话输入 / git 操作），也是审批记忆的键 */
  subject: string;
  /** 文案里的动作，如「执行这条命令」「向会话写入」「推送到远端」 */
  action: string;
  reasons: string[];
  /** 超时未答按拒绝处理；宿主可提前决定 */
  expiresAt: number;
}

export interface ApprovalDecideParams extends ThreadReadParams {
  approvalId: string;
  approved: boolean;
}

/** decided=false 表示这条请求早已应答/超时/不属于本线程（宿主不该重试） */
export interface ApprovalDecideResult {
  decided: boolean;
  reason?: string;
}

/**
 * 只能由宿主代跑的端口名（与 ChatAgentPorts 上的口一一对应）：
 * 服务端进程里没有实现，也不该有一份会失败或会绕门的假实现。
 * - generateMedia/vision/desktop/webdriver/uia/ssh：画布节点与这台机器上的画面、鼠标、控件、密钥
 * - deploy：本机程序落盘（deploy_program）——落的是宿主这台机器的目录，服务端没有那个目录
 * - mcp：外部 MCP 工具（stdio 子进程由宿主托管，凭据与连接也在宿主手里）；
 *   这一口的工具清单是宿主在 thread/start 用 mcpTools 报上来的，注册面 = 报上来的那几把
 */
export type HostToolPort =
  | "generateMedia"
  | "vision"
  | "desktop"
  | "webdriver"
  | "uia"
  | "ssh"
  | "deploy"
  | "mcp";

export const HOST_TOOL_PORTS: readonly HostToolPort[] = [
  "generateMedia",
  "vision",
  "desktop",
  "webdriver",
  "uia",
  "ssh",
  "deploy",
  "mcp",
];

/**
 * 反向工具请求（内核 → 宿主）：端口方法与位置参数原样搬到线上，由宿主在自己的运行时里执行。
 * 工具语义（参数校验、结果怎么回流给模型）仍在内核，宿主只负责"这一口怎么在这台机器上跑"。
 */
export interface AgentHostToolEvent extends AgentEventBase {
  method: "event/tool-request";
  /** 应答 tool/decide 时要带回来，宿主据此配对 */
  requestId: string;
  port: HostToolPort;
  /** 端口上的方法名（capture / operate / dom / navigate / exec / inspect / eval / record / replay …） */
  call: string;
  /** 位置参数：内核按端口签名传入，宿主按同名方法展开 */
  args: unknown[];
  /** 超时未答 = 失败回流给模型（不是拒绝，是真跑不了）；宿主可提前应答 */
  expiresAt: number;
}

export interface ToolDecideParams extends ThreadReadParams {
  requestId: string;
  ok: boolean;
  /** ok=true 时的返回值（各端口形状不同，内核侧端口原样交回引擎） */
  result?: unknown;
  /** ok=false 时给模型看的理由：写清楚是宿主不支持、断了，还是这一步真跑失败了 */
  error?: string;
}

/** settled=false 表示这条请求早已超时/已被应答，或不属于本线程 */
export interface ToolDecideResult {
  settled: boolean;
  reason?: string;
}

// ---------- 响应结果 ----------

export interface ThreadHandleResult {
  conversationId: string;
  /** 内核里这条线程此前是否已存在（存在 = 复用，没按传入快照重建） */
  existed: boolean;
  /**
   * 这条线程当前的 seq 读数。seq 只在线程自己的一生里递增，服务重启或线程回收后会从 1 重来，
   * 所以宿主必须拿它对表，不能拿本地存档里那个旧高水位去过滤事件。
   */
  seq: number;
}

/** 分叉结果：顺带把分支快照还给宿主，宿主落盘后原对话不受影响 */
export interface ThreadForkResult extends ThreadHandleResult {
  /** 血统：从哪条对话分出来的（宿主据此显示「分支自 …」） */
  forkedFrom: string;
  snapshot: AgentThreadSnapshot;
}

export interface ThreadReadResult {
  snapshot: AgentThreadSnapshot;
  turnId: number;
  running: boolean;
}

export interface ThreadCapabilitiesResult {
  conversationId: string;
  /** 这条线程注册得上的工具名（与内核建工具面同源） */
  toolNames: string[];
  caps: RuntimeToolCaps;
}

export interface ThreadJournalEntry {
  ts: number;
  kind: string;
  note: string;
}

export interface TurnStartResult {
  conversationId: string;
  /** 本轮 id：事件流按它归组，turn/steer 之后仍是同一轮 */
  turnId: number;
  /** false = 这条线程已有回合在跑（插话请走 turn/steer，别开第二轮） */
  started: boolean;
}

// ---------- 事件（内核 → 宿主） ----------

/** 所有事件都带这三个字段：宿主按 seq 去重/续传，按 turnId 归组 */
export interface AgentEventBase {
  conversationId: string;
  turnId: number;
  /** 线程内单调递增：断线重连时作为 since 传回补发 */
  seq: number;
}

/** 卡片/旁白事件：与 ports.postUI 一一对应，宿主渲染的唯一依据 */
export interface AgentUiEvent extends AgentEventBase {
  method: "event/ui";
  kind: ChatUIKind;
  content: string;
  meta?: ChatUIEventMeta;
}

/** 逐字流事件：begin 起气泡，delta 追加，end 收口（定稿仍走 event/ui 的 fromStream） */
export interface AgentStreamEvent extends AgentEventBase {
  method: "event/stream";
  phase: "begin" | "delta" | "end";
  text?: string;
}

/** 回合边界事件：started 之后才有 delta；ended 带 outcome，宿主据此收尾预算显示 */
export interface AgentTurnEvent extends AgentEventBase {
  method: "event/turn";
  phase: "started" | "ended";
  outcome?: {
    usedTokens: number;
    steps: number;
    interrupted?: boolean;
    stopped?: boolean;
    budgetExhausted?: boolean;
  };
}

export interface AgentErrorEvent extends AgentEventBase {
  method: "event/error";
  message: string;
}

export type AgentEvent =
  | AgentUiEvent
  | AgentStreamEvent
  | AgentTurnEvent
  | AgentApprovalEvent
  | AgentHostToolEvent
  | AgentErrorEvent;

// ---------- JSON-RPC 信封 ----------

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string;
  method: AgentRpcMethod;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: AgentEventMethod;
  params: AgentEvent;
}

/** 标准码沿用 JSON-RPC 规范，-320xx 起是本协议自有语义（宿主可据此换文案） */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** 线程不存在（或已被回收） */
  THREAD_NOT_FOUND: -32010,
  /** 回合已在跑：turn/start 的幂等保护 */
  TURN_RUNNING: -32011,
  /** 没有挂起的反问可应答 */
  NO_PENDING_ASK: -32012,
  /** 模型连接不可用（不存在/未启用/缺凭据） */
  MODEL_UNAVAILABLE: -32013,
  /** 协议版本不匹配 */
  PROTOCOL_MISMATCH: -32014,
  /** 审批请求已超时或已被应答 */
  APPROVAL_STALE: -32015,
  /** 反向工具请求已超时或已被应答 */
  TOOL_REQUEST_STALE: -32016,
} as const;

export function jsonRpcResult(id: string, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(
  id: string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** 只校验信封形状，不校验 params（各方法自己校验，错误才报得出具体字段） */
export function parseJsonRpcRequest(body: unknown): { ok: true; request: JsonRpcRequest } | { ok: false; code: number; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: RPC.INVALID_REQUEST, message: "请求体必须是一个 JSON 对象" };
  }
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, code: RPC.INVALID_REQUEST, message: `jsonrpc 必须是 "${JSONRPC_VERSION}"` };
  }
  if (typeof b.id !== "string" || !b.id) {
    return { ok: false, code: RPC.INVALID_REQUEST, message: "id 必须是非空字符串（本服务不支持无 id 的请求）" };
  }
  if (typeof b.method !== "string" || !b.method) {
    return { ok: false, code: RPC.INVALID_REQUEST, message: "method 必须是非空字符串" };
  }
  return { ok: true, request: { jsonrpc: JSONRPC_VERSION, id: b.id, method: b.method as AgentRpcMethod, params: b.params } };
}

/** params 必填字符串字段校验：缺哪个就报哪个，别让宿主猜 */
export function requireString(params: unknown, key: string): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const v = p[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new RpcParamError(`params.${key} 必须是非空字符串`);
  }
  return v;
}

/** params 里取一个对象（可缺省） */
export function optionalObject<T = Record<string, unknown>>(params: unknown, key: string): T | undefined {
  const v = ((params ?? {}) as Record<string, unknown>)[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new RpcParamError(`params.${key} 必须是一个对象`);
  return v as T;
}

export class RpcParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcParamError";
  }
}

// ---------- SSE 帧编解码（事件流的唯一一份解析器） ----------

/**
 * 一帧：`id: <seq>` + `event: <method>` + `data: <json>`。
 * 带 id 是为了浏览器 EventSource 原生支持 Last-Event-ID 续传。
 */
export function encodeSseFrame(event: AgentEvent): string {
  const payload: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method: event.method, params: event };
  return (
    `id: ${event.seq}\n` +
    `event: ${event.method}\n` +
    `data: ${JSON.stringify(payload)}\n\n`
  );
}

/** 心跳注释帧：长连接没事件时用来判定对端还活着，浏览器会直接忽略 */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * 增量 SSE 解析器：喂进任意切分的文本块，吐出完整帧（不依赖 EventSource，Node 里 fetch+reader 也能用）。
 * 只取 data 里的 JSON-RPC 通知，忽略注释行与未知 event 类型。
 */
export function createSseParser(): (chunk: string) => JsonRpcNotification[] {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    const out: JsonRpcNotification[] = [];
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue;
      try {
        const parsed = JSON.parse(dataLines.join("\n")) as JsonRpcNotification;
        if (parsed && parsed.jsonrpc === JSONRPC_VERSION && typeof parsed.method === "string") out.push(parsed);
      } catch {
        /* 半截帧已由 \n\n 边界兜住；解析不了就丢掉这帧，不炸整个流 */
      }
    }
    return out;
  };
}

/** 事件 → 通知（服务端广播与客户端消费共用，避免两边各写一遍包装） */
export function toNotification(event: AgentEvent): JsonRpcNotification {
  return { jsonrpc: JSONRPC_VERSION, method: event.method, params: event };
}
