/**
 * 小逻 v3 —— app-server 客户端（P3：宿主的这一侧）
 *
 * 浏览器面板、CLI、桌面主进程都只跟这一份代码说话：方法名与事件名全部来自 agent-wire，
 * 本文件不含任何内核逻辑，因此「内核在服务进程里」这件事对宿主是透明的。
 *
 * 传输是被注入的（AgentCallTransport）：
 *  - httpTransport()：真实服务（POST 信封 + GET SSE），CLI / 桌面用；
 *  - 测试可以直接把 transport 接到 handleAgentRpc + attachThreadListener 上，
 *    在同一个 Node 进程里跑通「宿主 → 协议 → 内核 → 事件」整条路，不用起服务。
 *
 * 存档所有权仍在宿主：客户端只提供 threadRead（拿快照）与 thread/start|resume（交快照），
 * 存到哪（localStorage / IndexedDB / 文件）由宿主自己决定。
 *
 * 宿主的两条应答线都由本文件自动回执（P6）：
 *  - event/approval → approval/decide：宿主只管"批不批"，不操心信封；
 *  - event/tool-request → tool/decide：宿主只管"这一跳怎么在这台机器上跑"，
 *    返回值原样交回内核，跑不了就抛 —— 不接 onHostTool 的宿主会当场答"不支持"，
 *    内核不会挂等，模型立刻看见失败。
 */

import {
  JSONRPC_VERSION,
  createSseParser,
  RPC,
  jsonRpcError,
  type AgentApprovalEvent,
  type AgentEvent,
  type AgentHostToolEvent,
  type AgentRpcMethod,
  type HostToolPort,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ThreadCapabilitiesResult,
  type ThreadForkParams,
  type ThreadForkResult,
  type ThreadHandleResult,
  type ThreadJournalEntry,
  type ThreadReadResult,
  type ThreadResumeParams,
  type ThreadStartParams,
  type TurnStartParams,
  type TurnStartResult,
} from "./agent-wire";
import type { AskUserAnswer, McpToolInfo } from "./types";

/** 协议层错误（含 -320xx 自定义码）：宿主按 code 决定「重建线程」还是「换说法」 */
export class AgentRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "AgentRpcError";
    this.code = code;
  }
}

/** 线程不在了（未启动或已闲置回收）：宿主该走 thread/resume 重建再重试 */
export function isThreadGone(e: unknown): boolean {
  return e instanceof AgentRpcError && e.code === RPC.THREAD_NOT_FOUND;
}

/** 一条 JSON-RPC 往返 + 一路事件订阅的最小契约 */
export interface AgentCallTransport {
  request(body: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** 订阅某条线程的事件流；返回取消函数。onEvent 可能被同步调用多次 */
  subscribe(conversationId: string, since: number, onEvent: (event: AgentEvent) => void): () => void;
}

export interface AgentClientOptions {
  transport: AgentCallTransport;
  /** 全量事件回调（渲染卡片、逐字流、回合边界都从这里来） */
  onEvent?: (event: AgentEvent) => void;
  /**
   * 审批回调：不接就一律拒绝。
   * 默认保守是有意的——宿主没把批准 UI 接上之前，内核不该把危险操作当成已获授权。
   */
  onApproval?: (event: AgentApprovalEvent) => boolean | Promise<boolean>;
  /**
   * 本宿主能代跑的端口名（随 thread/start|resume 一并交出）。
   * 没说口的能力内核不会去注册：小逻的工具面里就没有它，也不会向这台机器要一张截屏。
   */
  hostTools?: HostToolPort[];
  /**
   * 宿主已发现的 MCP 工具清单（声明 mcp 口才有效）：工具面按这份注册。
   * 清单变了要重新 thread/start|resume 交一次——注册面是从端口推出来的，不报就还是上一批。
   */
  mcpTools?: McpToolInfo[];
  /**
   * 反向工具代跑：返回值原样交回内核；抛错则把错误文案回流给模型。
   * 只有声明在 hostTools 里的口才会被问到，所以这里可以放心只写自己真跑得动的那几个。
   */
  onHostTool?: (event: AgentHostToolEvent) => Promise<unknown> | unknown;
  /** 当前模型是否具备视觉能力（宿主判定）：vision 口的 inspect_screen 靠它决定截屏还是 DOM 快照 */
  hostModelVision?: boolean | (() => boolean);
}

export interface AgentTurnOutcome {
  usedTokens: number;
  steps: number;
  interrupted?: boolean;
  stopped?: boolean;
  budgetExhausted?: boolean;
}

export interface WatchHandle {
  conversationId: string;
  close(): void;
}

export class AgentClient {
  private readonly transport: AgentCallTransport;
  private readonly onEvent?: (event: AgentEvent) => void;
  private readonly onApproval?: (event: AgentApprovalEvent) => boolean | Promise<boolean>;
  private readonly onHostTool?: (event: AgentHostToolEvent) => Promise<unknown> | unknown;
  private readonly hostTools: HostToolPort[];
  private readonly mcpTools: McpToolInfo[];
  private readonly hostModelVision?: boolean | (() => boolean);
  private requestSeq = 0;
  /** 每条线程看到的最大 seq：重连时作为 since 传回，避免补发重复 */
  private readonly highWater = new Map<string, number>();
  private readonly watches = new Map<string, { detach: () => void; refs: number }>();
  /** 等待中的回合：turnId → 结算函数（runTurn 用它把事件流折成一个 Promise） */
  private readonly pendingTurns = new Map<string, (outcome: AgentTurnOutcome | null) => void>();

  constructor(opts: AgentClientOptions) {
    this.transport = opts.transport;
    this.onEvent = opts.onEvent;
    this.onApproval = opts.onApproval;
    this.onHostTool = opts.onHostTool;
    // 没接 onHostTool 就等于一个口都跑不了：声明留着只会让内核注册出一个没人应答的工具
    this.hostTools = opts.onHostTool ? opts.hostTools ?? [] : [];
    this.mcpTools = opts.hostTools?.includes("mcp") && opts.onHostTool ? opts.mcpTools ?? [] : [];
    this.hostModelVision = opts.hostModelVision;
  }

  /** 宿主身份随每次起线程交出：换宿主（桌面↔标签页）时服务端据此重谈工具面 */
  private hostDecl(): { hostTools: HostToolPort[]; hostModelVision: boolean; mcpTools: McpToolInfo[] } {
    return {
      hostTools: this.hostTools,
      mcpTools: this.mcpTools,
      hostModelVision: typeof this.hostModelVision === "function" ? this.hostModelVision() : this.hostModelVision === true,
    };
  }

  // ---------- 信封往返 ----------

  async call<T>(method: AgentRpcMethod, params?: unknown): Promise<T> {
    this.requestSeq += 1;
    const body: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: "r" + this.requestSeq + "-" + Date.now().toString(36),
      method,
      ...(params === undefined ? {} : { params }),
    };
    const resp = await this.transport.request(body);
    if ("error" in resp) throw new AgentRpcError(resp.error.code, resp.error.message);
    return resp.result as T;
  }

  // ---------- thread/* ----------

  threadStart(params: ThreadStartParams & { snapshot?: ThreadResumeParams["snapshot"] }): Promise<ThreadHandleResult> {
    return this.call<ThreadHandleResult>("thread/start", { ...this.hostDecl(), ...params });
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadHandleResult> {
    return this.call<ThreadHandleResult>("thread/resume", { ...this.hostDecl(), ...params });
  }

  threadFork(params: ThreadForkParams): Promise<ThreadForkResult> {
    return this.call<ThreadForkResult>("thread/fork", { ...this.hostDecl(), ...params });
  }

  threadRead(conversationId: string): Promise<ThreadReadResult> {
    return this.call<ThreadReadResult>("thread/read", { conversationId });
  }

  /**
   * 按内核交回的 seq 重定事件水位：seq 只在一根线程活着期间递增，服务重启或闲置回收后重建的那根又从 1 开始。
   * 只有往回退才认这一世（旧读数继续拿去过滤就等于把每条新事件都当重复丢掉）；往前是还没消费的旧事件，不动。
   */
  rebaseSeq(conversationId: string, seq: number): void {
    const current = this.highWater.get(conversationId) ?? 0;
    if (seq < current) this.highWater.set(conversationId, seq);
  }

  threadCapabilities(conversationId: string): Promise<ThreadCapabilitiesResult> {
    return this.call<ThreadCapabilitiesResult>("thread/capabilities", { conversationId });
  }

  threadModelUpdate(conversationId: string, model: string): Promise<{ conversationId: string; model: string }> {
    return this.call("thread/model/update", { conversationId, model });
  }

  threadArtifactEdit(conversationId: string, edits: Array<{ path: string; content: string }>): Promise<{ changed: boolean }> {
    return this.call("thread/artifact/edit", { conversationId, edits });
  }

  threadJournal(conversationId: string, limit = 12): Promise<{ entries: ThreadJournalEntry[] }> {
    return this.call("thread/journal", { conversationId, limit });
  }

  // ---------- turn/* ----------

  turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    return this.call<TurnStartResult>("turn/start", params);
  }

  turnSteer(conversationId: string, text: string): Promise<{ conversationId: string; queued: boolean; running: boolean }> {
    return this.call("turn/steer", { conversationId, text });
  }

  turnAnswer(conversationId: string, answer: AskUserAnswer): Promise<{ conversationId: string; answered: boolean }> {
    return this.call("turn/answer", { conversationId, answer });
  }

  turnInterrupt(conversationId: string): Promise<{ conversationId: string; wasRunning: boolean }> {
    return this.call("turn/interrupt", { conversationId });
  }

  approvalDecide(conversationId: string, approvalId: string, approved: boolean): Promise<{ decided: boolean; reason?: string }> {
    return this.call("approval/decide", { conversationId, approvalId, approved });
  }

  /** 反向工具应答：内核等着这一跳的结果（或理由）才继续下一步 */
  toolDecide(
    conversationId: string,
    requestId: string,
    reply: { ok: boolean; result?: unknown; error?: string },
  ): Promise<{ settled: boolean; reason?: string }> {
    return this.call("tool/decide", { conversationId, requestId, ...reply });
  }

  // ---------- 事件流 ----------

  /**
   * 订阅一条线程的事件流（幂等：同一 cid 多次调用共用一路连接，close 计数归零才真断）。
   * 审批事件在派发给用户之前先由客户端应答：宿主只需在 onApproval 里返回 true/false。
   */
  watch(conversationId: string): WatchHandle {
    const existing = this.watches.get(conversationId);
    if (existing) {
      existing.refs += 1;
      return this.handleFor(conversationId);
    }
    const since = this.highWater.get(conversationId) ?? 0;
    const detach = this.transport.subscribe(conversationId, since, (event) => this.dispatchEvent(event));
    this.watches.set(conversationId, { detach, refs: 1 });
    return this.handleFor(conversationId);
  }

  /** 是否已在订阅（宿主重渲染时避免重复 watch） */
  isWatched(conversationId: string): boolean {
    return this.watches.has(conversationId);
  }

  private handleFor(conversationId: string): WatchHandle {
    return {
      conversationId,
      close: () => {
        const entry = this.watches.get(conversationId);
        if (!entry) return;
        entry.refs -= 1;
        if (entry.refs > 0) return;
        this.watches.delete(conversationId);
        entry.detach();
      },
    };
  }

  private dispatchEvent(event: AgentEvent) {
    const seen = this.highWater.get(event.conversationId) ?? 0;
    if (event.seq > seen) this.highWater.set(event.conversationId, event.seq);
    if (event.method === "event/turn" && event.phase === "ended") {
      this.pendingTurns.get(event.conversationId)?.(event.outcome ?? null);
      this.pendingTurns.delete(event.conversationId);
    }
    if (event.method === "event/error") {
      // 回合抛了：把这轮当作「无 outcome 结束」结算，宿主不会永远卡在 await
      this.pendingTurns.get(event.conversationId)?.(null);
      this.pendingTurns.delete(event.conversationId);
    }
    this.onEvent?.(event);
    if (event.method === "event/approval") {
      void this.settleApproval(event);
    }
    if (event.method === "event/tool-request") {
      void this.settleHostTool(event);
    }
  }

  private async settleApproval(event: AgentApprovalEvent): Promise<void> {
    let approved = false;
    if (this.onApproval) {
      try {
        approved = await this.onApproval(event);
      } catch {
        // 宿主回调炸了按拒绝处理：审批的失败方向永远是安全的那一边
      }
    }
    await this.approvalDecide(event.conversationId, event.approvalId, approved).catch(() => undefined);
  }

  /**
   * 代跑完（或跑不了）都要回执：内核那一步正挂在这个 Promise 上。
   * 没接 onHostTool 时不是静默不回，而是当场答"本宿主没有这项能力"——
   * 让模型立刻看见失败，比等一个永远不会来的应答强。
   */
  private async settleHostTool(event: AgentHostToolEvent): Promise<void> {
    let reply: { ok: boolean; result?: unknown; error?: string };
    if (!this.onHostTool) {
      reply = { ok: false, error: "本宿主没有接反向工具通道，跑不了 " + event.port + "." + event.call };
    } else {
      try {
        reply = { ok: true, result: await this.onHostTool(event) };
      } catch (e) {
        reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    await this.toolDecide(event.conversationId, event.requestId, reply).catch(() => undefined);
  }

  /**
   * 起一轮并等它跑完（事件流折成 Promise）。
   * 已有回合在跑时不当错误：改成插话（对齐 Codex turn/start 撞车后走 steer 的用法）。
   */
  async runTurn(params: TurnStartParams): Promise<AgentTurnOutcome | null> {
    const watch = this.watch(params.conversationId);
    const settled = new Promise<AgentTurnOutcome | null>((resolve) => {
      this.pendingTurns.set(params.conversationId, resolve);
    });
    try {
      try {
        await this.turnStart(params);
      } catch (e) {
        if (e instanceof AgentRpcError && e.code === RPC.TURN_RUNNING) {
          // 已有回合在跑：把这轮话并进正在跑的那一轮，等的还是它的结束事件
          await this.turnSteer(params.conversationId, params.text);
        } else {
          throw e;
        }
      }
      return await settled;
    } finally {
      this.pendingTurns.delete(params.conversationId);
      watch.close();
    }
  }
}

// ---------- HTTP 传输 ----------

export interface HttpTransportOptions {
  /** 服务基址；浏览器留空走同源，CLI 传 http://127.0.0.1:3000 */
  baseUrl?: string;
  /** 静态或动态请求头（CLI 从环境变量注入 cookie） */
  headers?: Record<string, string> | (() => Record<string, string>);
  fetchImpl?: typeof fetch;
  /** 事件流出错（断开、非 200）：宿主据此决定是否重连；不传就静默 */
  onStreamError?: (error: Error) => void;
}

const AGENT_ENDPOINT = "/api/v2/brain/agent";

async function resolveHeaders(headers: HttpTransportOptions["headers"]): Promise<Record<string, string>> {
  if (!headers) return {};
  return typeof headers === "function" ? headers() : headers;
}

/** 走真实服务的传输：POST 信封 + GET SSE */
export function httpTransport(opts: HttpTransportOptions = {}): AgentCallTransport {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = (opts.baseUrl ?? "").replace(/\/+$/, "");

  return {
    async request(body: JsonRpcRequest): Promise<JsonRpcResponse> {
      const resp = await doFetch(base + AGENT_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await resolveHeaders(opts.headers)) },
        body: JSON.stringify(body),
        credentials: "include",
      });
      const text = await resp.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // 非 JSON 响应（网关错误页、登录跳转）：包成协议错误，宿主仍能看到原因
        return jsonRpcError(body.id, RPC.INTERNAL_ERROR, "服务返回的不是 JSON（HTTP " + resp.status + "）：" + text.slice(0, 200));
      }
      if (resp.status >= 400 && typeof parsed === "object" && parsed !== null && !("jsonrpc" in parsed)) {
        const message = typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : "HTTP " + resp.status;
        return jsonRpcError(body.id, RPC.INTERNAL_ERROR, message);
      }
      return parsed as JsonRpcResponse;
    },

    subscribe(conversationId: string, since: number, onEvent: (event: AgentEvent) => void): () => void {
      const ctrl = new AbortController();
      const parse = createSseParser();
      void (async () => {
        const url =
          base + AGENT_ENDPOINT + "?conversationId=" + encodeURIComponent(conversationId) + "&since=" + encodeURIComponent(String(since));
        try {
          const resp = await doFetch(url, {
            method: "GET",
            headers: { accept: "text/event-stream", ...(await resolveHeaders(opts.headers)) },
            credentials: "include",
            signal: ctrl.signal,
          });
          if (!resp.ok || !resp.body) {
            throw new Error("事件流连不上（HTTP " + resp.status + "）");
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const note of parse(decoder.decode(value, { stream: true })) as JsonRpcNotification[]) {
              const event = note.params as AgentEvent;
              if (typeof event?.seq === "number") onEvent(event);
            }
          }
        } catch (e) {
          if (!ctrl.signal.aborted) {
            opts.onStreamError?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
      })();
      return () => ctrl.abort();
    },
  };
}
