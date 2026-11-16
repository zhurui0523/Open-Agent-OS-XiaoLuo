/**
 * 小逻 v3 —— 服务端 Node 端口（P3：app-server 的能力面）
 *
 * 这是 agent-ports.ts 那份契约的第二份实现：第一份在浏览器 hook 里（走 HTTP 打到 /api/v2/brain/*），
 * 这一份直接跑在 Next.js 服务进程里，就近 import brain-sandbox / 网关核心，不再自己调自己。
 *
 * 安全纪律（与浏览器宿主逐字对齐，一点不能少）：
 *  - 命令 / 会话 / git push 都过 app/lib/brain-command-gate.ts 的三道门，审批语义只有一份；
 *  - 「要不要问老板」由宿主决定：浏览器是 confirm，这里是 event/approval → approval/decide 走线；
 *  - 同类同参 30 分钟内批准过就不再问（与浏览器宿主的会话级记忆同口径），拒绝时给同一句回流文案；
 *  - 就近调用不等于少一道门：服务启动走 startGatedService（与 run_command 同一份三道门），
 *    检索与网页抓取分别走 lib/brain-search.ts、lib/brain-browse.ts 那两份与 HTTP 路由共用的核心，
 *    SSRF 闸门和风险分级都是动作的一部分，不是某条路由的一部分；
 *  - vision / desktop / webdriver / uia / ssh / generateMedia / deploy / mcp 物理上只在宿主里
 *    （画布节点、内嵌浏览器、CDP、Windows UIA、本机密钥、本机程序目录、MCP 子进程与凭据）。
 *    服务端不猜、也不假装有：宿主在 thread/start 用 hostTools 声明能代跑哪几口，声明过的才注册，
 *    方法调用隔 event/tool-request 搬出去跑。没声明 = 工具面里没有这个工具，
 *    小逻不会去向一台没有浏览器的机器要一张截图；
 *  - mcp 口的工具清单由宿主随声明一并上报（mcpTools），内核只收 mcp__ 前缀的公开名：
 *    连接与凭据始终在宿主手里，服务端只负责把这一跳搬到线上。
 *    （协议与挂起账见 agent-wire 的 host tool 一节、agent-server 的 requestHostTool。）
 *
 * 本文件不出现任何浏览器全局：journal 在没有 indexedDB 时自动降级为内存账，引擎照跑。
 */

import {
  cancelSandboxedCommands,
  deleteSandboxPath,
  findSandboxFiles,
  fuzzyFindSandboxFiles,
  grepSandboxFiles,
  listBrainServices,
  listBrainStdinSessions,
  listSandboxDir,
  moveSandboxPath,
  readSandboxFile,
  runSandboxedGit,
  setupBrainService,
  stopBrainService,
  writeSandboxFile,
  type SandboxGitOp,
} from "../../../lib/brain-sandbox";
import {
  openGatedSession,
  runGatedCommand,
  startGatedService,
  writeGatedSession,
  type CommandGateDenial,
} from "../../../lib/brain-command-gate";
import { BrainGatewayError, callBrainModel, type BrainModelCall, type CallBrainModelInput } from "../../../lib/brain-llm-gateway";
import { BrowseError, fetchPageDigest } from "../../../lib/brain-browse";
import { FileMemoryStore } from "../../../lib/brain-memory";
import { saveProgram as saveBrainProgram } from "../../../lib/brain-programs";
import { runWebSearch } from "../../../lib/brain-search";
import type { ChatAgentPorts, DesktopPort, SshPort, UiaPort, VisionPort, WebDriverPort } from "./agent-ports";
import type { HostToolPort, PermissionMode } from "./agent-wire";
import {
  mapCompletionResponse,
  modelErrorFromStatus,
  parseModelSSE,
  replyFromStreamAccum,
  salvageStreamInterruption,
  toWireMessages,
  type ModelSSEProtocol,
  type StreamAccum,
  type WireCompletion,
} from "./llm-wire";
import {
  BrainLLMError,
  type CodeArtifact,
  type CommandResult,
  type DeployProgramResult,
  type GitOp,
  type McpToolInfo,
  type NodeRunResult,
  type PageDigest,
  type ServiceRunInfo,
  type SetupServicePayload,
  type SetupServiceResult,
  type StdinSessionResult,
} from "./types";
import type { GenerateMediaArgs } from "./chat-tools";

/** 审批请求（宿主实现：发 event/approval 并等 approval/decide） */
export type ApprovalRequest = {
  scope: "command" | "stdin" | "git" | "service" | "service-setup";
  subject: string;
  action: string;
  reasons: string[];
};

/** 模型调用实现：服务端默认那份与嵌入式宿主/测试替换的那份共用同一形状 */
export type ModelCaller = (input: CallBrainModelInput) => Promise<BrainModelCall>;

export interface ServerPortsOptions {
  userId: string;
  /** 这条端口面服务哪条对话：程序库按对话 upsert，没有它就每次都新建一个文件夹 */
  conversationId: string;
  /** LLM 网关的准入画布 */
  canvasId: string;
  /** 默认模型连接 id；引擎每轮传的 model 优先 */
  modelId: string;
  /**
   * 文件口档位，缺省 default（绝对路径一律拒）。
   * 这一份由宿主在 thread/* 报上来，与 /api/v2/brain/fs 的 mode 同一个口径、同一个调用方：
   * 浏览器面板以前就是带着它直调那条路由读文件的，内核搬进服务进程后不能悄悄把门加高。
   * 命令口不吃这一份 —— 它有自己的风险分级与审批门，越界落点照样拦。
   */
  permissionMode?: PermissionMode;
  /**
   * 换掉「问哪个模型」这一步：桌面宿主可接本机引擎，bare-Node 测试可接桩。
   * 只有这一项可换——闸门、沙箱、审批记忆全都还是服务端这同一份实现。
   */
  callModel?: ModelCaller;
  emitUi: ChatAgentPorts["postUI"];
  /**
   * 逐字显形通道：宿主给一份，引擎就会带 onDelta 让本端口走流式。
   * 谁攒、多久发一次是宿主的口径（服务端线程宿主按 80ms 合并成 event/stream delta），这里只是透传。
   */
  streamUI?: ChatAgentPorts["streamUI"];
  /** 要老板批准：宿主返回 true/false；超时按 false */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  /**
   * 反向工具通道（P6）：内核在服务进程里，但画布节点、内嵌浏览器截屏、CDP、Windows UIA、
   * 本机 SSH 密钥物理上只在宿主那边。这一口把「调哪个方法的哪几个参数」搬到线上，等宿主回执。
   * 宿主跑不了就抛 —— 错误原样回流给模型，服务端绝不假装有这些能力。
   */
  requestHostTool(port: HostToolPort, call: string, args: unknown[]): Promise<unknown>;
  /** 本宿主声明能代跑哪几口（thread/start 时交上来那份）：没声明的口不注册，工具面直接窄一点 */
  hostTools?: HostToolPort[];
  /** 宿主报上来的 MCP 工具清单（只有声明了 mcp 口才用）：注册面就是这份，服务端不猜宿主连了啥 */
  mcpTools?: McpToolInfo[];
  /** 当前模型有没有视觉（宿主判定）：只有 inspect_screen 用，所以每次调用现读，换模型不用重搭端口面 */
  getHostModelVision?(): boolean;
  /** 程序库落盘用的任务名（线程上老板的第一句原话）；没有就退回「未命名程序」，与面板宿主同口径 */
  getTaskTitle?(): string;
  /** 审批决策留痕（浏览器宿主落 localStorage，这里交给线程 journal） */
  auditApproval?(entry: { ts: number; scope: string; subject: string; ok: boolean; reasons: string[] }): void;
}

/** 会话级批准记忆：同类同参 30 分钟内批过就不再问（与面板宿主同口径） */
const APPROVAL_GRANT_TTL_MS = 30 * 60_000;
const approvalGrants = new Map<string, number>();

function approvalKey(scope: string, subject: string): string {
  return scope + "|" + subject.replace(/\s+/g, " ").trim().slice(0, 500);
}

function wasApproved(scope: string, subject: string): boolean {
  const ts = approvalGrants.get(approvalKey(scope, subject));
  return typeof ts === "number" && Date.now() - ts < APPROVAL_GRANT_TTL_MS;
}

/** 仅供测试与宿主主动清账：进程重启本来就会清空 */
export function clearApprovalGrants(): void {
  approvalGrants.clear();
}

export function approvalGrantCount(): number {
  return approvalGrants.size;
}

/**
 * 一次审批：先查会话级记忆，没批过才问宿主；拒绝就抛回原话，让模型知道要改做法。
 * 与面板 postBrainCommand 的文案逐字一致（小逻在两种宿主里看到的理由不能变）。
 */
async function approveOrDeny(opts: ServerPortsOptions, req: ApprovalRequest): Promise<boolean> {
  if (wasApproved(req.scope, req.subject)) return true;
  const ok = await opts.requestApproval(req);
  opts.auditApproval?.({ ts: Date.now(), scope: req.scope, subject: req.subject, ok, reasons: req.reasons });
  if (!ok) return false;
  approvalGrants.set(approvalKey(req.scope, req.subject), Date.now());
  return true;
}

function denied(subject: string): Error {
  return new Error(
    "老板未批准「" + subject + "」，已取消执行。请改用更保守的做法或先向老板说明理由。",
  );
}

/** 闸门拒绝 → 端口异常：blocked 直接给理由，approval_required 已被拒也给理由 */
function gateError(denial: CommandGateDenial): Error {
  return new Error(denial.error + (denial.reasons.length ? "（" + denial.reasons.join("；") + "）" : ""));
}

export function createServerPorts(opts: ServerPortsOptions): ChatAgentPorts {
  const mode = opts.permissionMode ?? "default";
  const callModel = opts.callModel ?? callBrainModel;

  /** 需要批准才能继续的几道门：blocked 直接拒，ask 先查记忆再问宿主，然后带 approved=true 重试一次 */
  async function withApproval<T>(
    req: ApprovalRequest,
    run: (approved: boolean) => Promise<{ ok: true; data: T } | { ok: false; denial: CommandGateDenial }>,
    onDeny: (req: ApprovalRequest) => Error = (r) => denied(r.subject),
  ): Promise<T> {
    const first = await run(false);
    if (first.ok) return first.data;
    if (first.denial.code !== "approval_required") throw gateError(first.denial);
    // 理由要跟着送出去：浏览器宿主的确认框里有「路径围栏：工作区外写入 xxx」这一行，
    // 隔着协议的宿主少了它就只能看到「需要批准」，老板无从判断自己在批什么
    const granted = await approveOrDeny(opts, { ...req, reasons: first.denial.reasons });
    if (!granted) throw onDeny(req);
    const second = await run(true);
    if (!second.ok) throw gateError(second.denial);
    return second.data;
  }

  // ---------- 宿主代跑的口（反向通道）：每个方法只是「把这一跳搬到线上，等宿主回执」 ----------
  // 注册与否只看宿主声明：工具面窄一点没关系，注册一个服务端跑不动、宿主又没接的口才是事故。
  const declared = new Set(opts.hostTools ?? []);
  const serves = (port: HostToolPort): boolean => declared.has(port);
  const hostCall = <T,>(port: HostToolPort, call: string, args: unknown[]): Promise<T> =>
    opts.requestHostTool(port, call, args) as Promise<T>;

  /** 画布媒体生成：直派节点，宿主里跑的是 startRunServer，服务端只会等结果 */
  const generateMedia = serves("generateMedia")
    ? async (req: GenerateMediaArgs): Promise<NodeRunResult> => await hostCall<NodeRunResult>("generateMedia", "generateMedia", [req])
    : undefined;

  const vision: VisionPort | undefined = serves("vision")
    ? {
        capture: async (region) => await hostCall<{ dataUrl: string; width: number; height: number }>("vision", "capture", [region]),
        operate: async (req) => await hostCall<string>("vision", "operate", [req]),
        dom: async (urlMatch) => await hostCall<string>("vision", "dom", [urlMatch]),
        navigate: async (url) => await hostCall<string>("vision", "navigate", [url]),
        // 现读：宿主换了、模型换了都不必重搭端口面
        get modelVision() {
          return opts.getHostModelVision?.() ?? false;
        },
      }
    : undefined;

  const desktop: DesktopPort | undefined = serves("desktop")
    ? {
        capture: async () => await hostCall<{ dataUrl: string; width: number; height: number }>("desktop", "capture", []),
        operate: async (req) => await hostCall<string>("desktop", "operate", [req]),
      }
    : undefined;

  const webdriver: WebDriverPort | undefined = serves("webdriver")
    ? {
        navigate: async (url) => await hostCall<string>("webdriver", "navigate", [url]),
        dom: async (mode, max) => await hostCall<string>("webdriver", "dom", [mode, max]),
        capture: async () => await hostCall<{ dataUrl: string; width: number; height: number }>("webdriver", "capture", []),
        operate: async (req) => await hostCall<string>("webdriver", "operate", [req]),
        eval: async (js, awaitPromise) => await hostCall<string>("webdriver", "eval", [js, awaitPromise]),
        record: async (req) => await hostCall<string>("webdriver", "record", [req]),
        replay: async (req) => await hostCall<string>("webdriver", "replay", [req]),
      }
    : undefined;

  const uia: UiaPort | undefined = serves("uia")
    ? { inspect: async (req) => await hostCall<string>("uia", "inspect", [req]) }
    : undefined;

  const ssh: SshPort | undefined = serves("ssh")
    ? { exec: async (req) => await hostCall<string>("ssh", "exec", [req]) }
    : undefined;

  /** 本机程序落盘：写的是宿主这台机器的目录，服务端没有那个目录，所以只能请宿主代跑 */
  const deployProgram = serves("deploy")
    ? async (artifact: CodeArtifact, name?: string): Promise<DeployProgramResult> =>
        await hostCall<DeployProgramResult>("deploy", "deployProgram", [artifact, name])
    : undefined;

  /**
   * MCP：连接与凭据都在宿主手里（stdio 子进程由桌面主进程托管）。
   * 工具清单用宿主上报的那份，调用把 (公开名, 参数) 原样搬过去 —— 宿主没接的口一个也不会注册进来。
   */
  const mcp = serves("mcp")
    ? {
        tools: opts.mcpTools ?? [],
        callTool: async (qualifiedName: string, args: Record<string, unknown>) =>
          await hostCall<string>("mcp", "callTool", [qualifiedName, args]),
      }
    : undefined;

  return {
    async callLLM(req) {
      const modelId = req.model || opts.modelId;
      if (!modelId) {
        throw new BrainLLMError("请先在设置里启用一个文本大模型", { retryable: false });
      }
      let call;
      try {
        call = await callModel({
          userId: opts.userId,
          canvasId: opts.canvasId,
          modelId,
          messages: toWireMessages(req.messages),
          tools: req.tools,
          // 宿主给了逐字通道才要流式：引擎只在主回合首试传 onDelta，重试那几次走非流式防 UI 卡占位
          stream: Boolean(req.onDelta),
          signal: req.signal,
        });
      } catch (e) {
        if (req.signal?.aborted) throw e; // 老板点了停止：原样上抛让 Agent 按中止收尾
        if (e instanceof BrainGatewayError) throw new BrainLLMError(e.message, { retryable: false });
        throw new BrainLLMError(e instanceof Error ? e.message : String(e), { retryable: true });
      }
      if (call.streamBody) {
        // 上游按 SSE 回话：边收边喂 onDelta，拼完与整包同形；解析口径与浏览器宿主共用 llm-wire 那一份
        const protocol: ModelSSEProtocol = (call.contentType ?? "").includes("profile=anthropic-sse") ? "anthropic" : "openai";
        let acc: StreamAccum | undefined;
        try {
          acc = await parseModelSSE(call.streamBody, protocol, req.onDelta);
        } catch (e) {
          if (req.signal?.aborted) throw e;
          return salvageStreamInterruption(acc);
        }
        return replyFromStreamAccum(acc);
      }
      if (!call.body) {
        throw new BrainLLMError("模型没有返回可解析的响应", { retryable: true });
      }
      let data: WireCompletion;
      try {
        data = JSON.parse(call.body) as WireCompletion;
      } catch {
        // 上游 200 但吐了 HTML（网关拦截/协议不符）：不能当正文吞掉
        throw modelErrorFromStatus(call.status, call.body.slice(0, 400));
      }
      if (data.error) throw modelErrorFromStatus(call.status, data.error);
      if (call.status < 200 || call.status >= 300) throw modelErrorFromStatus(call.status, data);
      return mapCompletionResponse(data);
    },

    postUI: opts.emitUi,

    ...(opts.streamUI ? { streamUI: opts.streamUI } : {}),

    // 以下八口全部由宿主代跑：宿主没在 thread/start 声明，这里就是 undefined，工具面里也就没有
    ...(generateMedia ? { generateMedia } : {}),
    ...(vision ? { vision } : {}),
    ...(desktop ? { desktop } : {}),
    ...(webdriver ? { webdriver } : {}),
    ...(uia ? { uia } : {}),
    ...(ssh ? { ssh } : {}),
    ...(deployProgram ? { deployProgram } : {}),
    ...(mcp ? { mcp } : {}),

    fs: {
      async listDir(path) {
        return listSandboxDir(opts.userId, path, mode);
      },
      async readFile(path, window) {
        return readSandboxFile(opts.userId, path, { offset: window?.offset, limit: window?.limit }, mode);
      },
      async writeFile(path, content) {
        await writeSandboxFile(opts.userId, path, content, undefined, mode);
      },
      async grep(pattern, o) {
        return grepSandboxFiles(opts.userId, pattern, { path: o?.path, maxResults: o?.maxResults }, mode);
      },
      async find(name, o) {
        return findSandboxFiles(opts.userId, name, { path: o?.path, maxResults: o?.maxResults }, mode);
      },
      async fuzzyFind(query, o) {
        return fuzzyFindSandboxFiles(opts.userId, query, { path: o?.path, maxResults: o?.maxResults });
      },
      async movePath(from, to) {
        await moveSandboxPath(opts.userId, from, to, mode);
      },
      async deletePath(path) {
        await deleteSandboxPath(opts.userId, path);
      },
    },

    /** 子 Agent 口（第 4 项）：允许并行只读调研；写权限显式开（写仍走同一个沙箱 fs 口与路径围栏） */
    subagent: { maxDepth: 1, write: true },

    command: {
      async run(command, o): Promise<CommandResult> {
        return withApproval<CommandResult>(
          { scope: "command", subject: command, action: "执行这条命令", reasons: [] },
          (approved) =>
            runGatedCommand({ userId: opts.userId, command, approved, cwd: o?.cwd, timeoutMs: o?.timeoutMs }),
        );
      },
      cancelAll() {
        cancelSandboxedCommands();
      },
      async startSession(command, o): Promise<StdinSessionResult> {
        const info = await withApproval(
          { scope: "command", subject: command, action: "开一个交互式会话跑这条命令", reasons: [] },
          (approved) =>
            openGatedSession({ userId: opts.userId, command, approved, cwd: o?.cwd, ttlMs: o?.ttlMs, pty: o?.pty }),
        );
        return toSessionResult(info);
      },
      async writeSession(sessionId, input, o): Promise<StdinSessionResult> {
        const info = await withApproval(
          { scope: "stdin", subject: input ?? "", action: "向交互会话写入这行输入", reasons: [] },
          (approved) =>
            writeGatedSession({ userId: opts.userId, sessionId, input, approved, waitMs: o?.waitMs, close: o?.close }),
        );
        return toSessionResult(info);
      },
      async listSessions() {
        return listBrainStdinSessions(opts.userId);
      },
    },

    git: {
      async exec(op: GitOp, _repoPath: string, o): Promise<string> {
        // 服务端 git 只在用户工作区上跑（repoPath 由沙箱决定），与浏览器宿主同一实现
        if (op === "push") {
          const granted = await approveOrDeny(opts, {
            scope: "git",
            subject: "git push",
            action: "推送本地提交到远端仓库",
            reasons: ["推送本地提交到远端仓库"],
          });
          if (!granted) throw denied("git push");
        }
        return runSandboxedGit(opts.userId, op as SandboxGitOp, {
          message: o?.message,
          limit: o?.limit,
          ref: o?.ref,
        });
      },
    },

    /**
     * 长驻服务：启动的门与 run_command 同一道（startGatedService 里三道门齐走），
     * 审批文案与浏览器宿主逐字一致——小逻在两种宿主里撞见的拒绝理由不能变。
     */
    service: {
      async start(command, o): Promise<ServiceRunInfo> {
        return withApproval<ServiceRunInfo>(
          { scope: "service", subject: command, action: "启动一个长驻服务", reasons: [] },
          (approved) =>
            startGatedService({ userId: opts.userId, command, approved, cwd: o?.cwd, ttlMs: o?.ttlMs }),
          (req) =>
            new Error(
              "老板未批准启动服务「" + req.subject + "」，已取消。请改用无需启动服务的做法或先向老板说明理由。",
            ),
        );
      },
      async stop(id): Promise<ServiceRunInfo> {
        const info = await stopBrainService(opts.userId, id);
        if (!info) throw new Error("服务不存在或已停止");
        return info;
      },
      async status(id) {
        return listBrainServices(opts.userId, id || undefined);
      },
      /** 本地服务搭建：没有风险分级可判（搭建通道自己不代执行危险命令），必问老板 */
      async setup(payload: SetupServicePayload): Promise<SetupServiceResult> {
        const summary =
          payload.kind +
          (payload.name ? " (" + payload.name + ")" : "") +
          (payload.port ? " 端口 " + payload.port : "");
        const granted = await approveOrDeny(opts, {
          scope: "service-setup",
          subject: summary,
          action: "搭建一个本地服务",
          reasons: ["setup_service:" + payload.kind],
        });
        if (!granted) {
          throw new Error("老板未批准搭建服务「" + summary + "」，已取消。请先向老板说明理由，或换别的做法。");
        }
        return (await setupBrainService(opts.userId, payload as unknown as Record<string, unknown>)) as SetupServiceResult;
      },
    },

    /** 联网检索：与 /api/v2/brain/search 同一份供应商实现（lib/brain-search.ts） */
    async webSearch(query) {
      return (await runWebSearch(query)).text;
    },

    /** 网页抓取：SSRF 闸门在 lib/brain-browse.ts 里，换宿主也绕不开 */
    browser: {
      async fetchPage(url): Promise<PageDigest> {
        try {
          return await fetchPageDigest(url);
        } catch (e) {
          if (e instanceof BrowseError) throw new Error(e.message);
          throw e;
        }
      },
    },

    /** 长期记忆：档在 .data/brain-memory/{userId}.json，与 /api/v2/memory 那份镜像同一个文件 */
    memory: new FileMemoryStore(opts.userId),

    /**
     * 程序库自动落盘（策略 A）：write_code 每次成功就按对话 upsert 一份，与 /api/v2/brain/programs
     * 走 lib/brain-programs 同一份实现 —— 两种宿主记出来的程序库必须是同一本账（同 id 方案、
     * 同名规则、同「同对话覆盖 + version+1」）。落盘失败由引擎静默吞掉：写档不该打断对话。
     */
    async saveProgram(artifact: CodeArtifact): Promise<void> {
      await saveBrainProgram(opts.userId, {
        conversationId: opts.conversationId,
        name: (opts.getTaskTitle?.() ?? "").trim() || "未命名程序",
        entry: artifact.entryFile ?? artifact.files[0]?.path,
        files: artifact.files,
      });
    },
  };
}

function toSessionResult(info: {
  sessionId: string;
  pid: number;
  output: string;
  status: "running" | "exited";
  exitCode?: number;
  droppedChars?: number;
  pty?: boolean;
  ptyNotice?: string;
}): StdinSessionResult {
  return {
    sessionId: info.sessionId,
    pid: info.pid,
    output: info.output,
    status: info.status,
    ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
    ...(info.droppedChars !== undefined ? { droppedChars: info.droppedChars } : {}),
    ...(info.pty ? { pty: true } : {}),
    ...(info.ptyNotice ? { ptyNotice: info.ptyNotice } : {}),
  };
}
