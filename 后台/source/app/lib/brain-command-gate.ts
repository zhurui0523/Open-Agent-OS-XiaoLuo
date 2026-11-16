/**
 * 小逻 v3 —— 命令审批闸门（风险 / 网络 / 路径围栏三道门）
 *
 * 原来这三道门写在 app/api/v2/brain/command/route.ts 里，只有走 HTTP 的命令才过门。
 * app-server 化之后，跑在服务端进程里的小逻直接调 brain-sandbox，绝不能因为「就近调用」
 * 就绕过审批——所以把闸门本身抽成函数，路由与 Node 端口共用同一份语义：
 *
 *   风险分级（shared/command-policy）→ 网络策略（hooks.toml [sandbox] network）→ 路径围栏（工作区外写删）
 *
 * 一次性命令、交互会话、长驻服务三种入口共用这一份判定：入口不同，门不能深浅不一。
 *
 * 三道门只判定，不询问老板：`approved` 由宿主决定怎么要（浏览器是 confirm 弹窗，
 * app-server 是 event/approval → approval/decide 走线）。审批记忆与留痕也留在宿主侧，
 * 因为「谁批准过什么」是宿主的审计，不是闸门的职责。
 */

import {
  brainWorkspaceRoot,
  checkForbiddenTargetsOf,
  checkPathFence,
  classifyCommandRisk,
  decideCommandNetwork,
  runSandboxedCommand,
  startBrainService,
  startBrainStdinSession,
  writeBrainStdinSession,
  type NetworkDecision,
  type SandboxCommandResult,
  type ServiceInfo,
  type StdinSessionInfo,
} from "./brain-sandbox";
import { decideApproval, resolveApprovalMode } from "../../shared/command-policy.mjs";

export type CommandGateCode = "blocked" | "approval_required" | "network_blocked";

/** 审批档位从环境读：缺省 on-request（与既有行为一致），XIAOLUO_APPROVAL_MODE 可切四档 */
function approvalModeFromEnv(): string {
  return resolveApprovalMode(process.env.XIAOLUO_APPROVAL_MODE) as string;
}

export interface CommandGateDenial {
  code: CommandGateCode;
  error: string;
  reasons: string[];
  /** 宿主据此回 HTTP 状态码；Node 侧只用来判是不是「老板没批」 */
  status: number;
}

export type CommandGateOutcome =
  | { ok: true; network?: NetworkDecision }
  | { ok: false; denial: CommandGateDenial };

/**
 * 一次性命令与会话启动走这道门；会话续写 withNetwork=false（策略在开席那刻已定）。
 * blocked = 无论批不批都不能执行；approval_required = 老板点头就能执行。
 * 第 0 道门是硬禁区：系统目录/凭据目录的写删，批了也不放行，所以放在风险分级之前。
 */
export async function gateCommand(opts: {
  userId: string;
  text: string;
  approved: boolean;
  withNetwork: boolean;
  /** 审批档位（never / on-request / unless-trusted / granular）；缺省读 XIAOLUO_APPROVAL_MODE */
  approvalMode?: string;
}): Promise<CommandGateOutcome> {
  const approvalMode = resolveApprovalMode(opts.approvalMode ?? approvalModeFromEnv());
  const forbidden = checkForbiddenTargetsOf(opts.text);
  if (forbidden.length > 0) {
    return {
      ok: false,
      denial: {
        code: "blocked",
        error: "命令指向系统目录/凭据目录（" + forbidden.join("、") + "），属硬禁区，批准也不放行。",
        reasons: forbidden.map((h) => "硬禁区：" + h),
        status: 403,
      },
    };
  }
  const risk = classifyCommandRisk(opts.text);
  const verdict = decideApproval(risk, approvalMode) as { action: "allow" | "ask" | "deny" };
  if (verdict.action === "deny") {
    return {
      ok: false,
      denial: {
        code: "blocked",
        error: "命令被安全策略拦截（" + risk.reasons.join("、") + "），请改用工作区内可恢复的做法。",
        reasons: risk.reasons,
        status: 403,
      },
    };
  }
  if (verdict.action === "ask" && !opts.approved) {
    return {
      ok: false,
      denial: { code: "approval_required", error: "该命令需要老板批准后才能执行", reasons: risk.reasons, status: 403 },
    };
  }
  if (!opts.withNetwork) return { ok: true };
  const network = await decideCommandNetwork(opts.userId, opts.text, opts.approved);
  if (network.level === "deny") {
    return {
      ok: false,
      denial: {
        code: "network_blocked",
        error:
          "命令被网络策略拒绝（" +
          network.reasons.join("；") +
          "）。确需访问请把 hooks.toml 的 [sandbox] network 调宽并请老板确认。",
        reasons: network.reasons,
        status: 403,
      },
    };
  }
  if (network.level === "ask" && !opts.approved) {
    // never 档下不问老板：网络类需要请示的一律按拒绝处理（宁可不跑，也不静默放行）
    if (approvalMode === "never") {
      return {
        ok: false,
        denial: {
          code: "network_blocked",
          error: "审批档位 never：该命令按网络策略需要批准外联，当前档位不询问老板，故不执行。",
          reasons: network.reasons,
          status: 403,
        },
      };
    }
    return {
      ok: false,
      denial: { code: "approval_required", error: "该命令按网络策略需要老板批准后才能外联", reasons: network.reasons, status: 403 },
    };
  }
  return { ok: true, network };
}

/** 硬沙箱路径围栏：写/删指向工作区外 → 未批准时拦截；已批准视为老板确认边界 */
export function fenceDenial(
  userId: string,
  text: string,
  approved: boolean,
  /** 拒绝文案里的主语：一次性命令说「该命令」，会话续写说「这条输入」 */
  noun = "该命令",
): CommandGateDenial | null {
  const fenceHits = checkPathFence(text, brainWorkspaceRoot(userId));
  if (fenceHits.length === 0 || approved) return null;
  return {
    code: "approval_required",
    error: noun + "会写入/删除工作区之外的文件，需要老板批准",
    reasons: fenceHits.map((p) => "路径围栏：工作区外写入 " + p),
    status: 403,
  };
}

/** 会话续写的入参校验（长度与命令签名都过门，否则「把 rm -rf 敲进 shell 会话」就绕过了整道门） */
export async function gateSessionInput(opts: {
  userId: string;
  input: string;
  approved: boolean;
}): Promise<CommandGateDenial | null> {
  if (!opts.input.trim()) return null;
  const gated = await gateCommand({ userId: opts.userId, text: opts.input, approved: opts.approved, withNetwork: false });
  if (!gated.ok) return gated.denial;
  return fenceDenial(opts.userId, opts.input, opts.approved, "这条输入");
}

export interface GatedCommandRequest {
  userId: string;
  command: string;
  approved: boolean;
  cwd?: string;
  timeoutMs?: number;
}

export type GatedCommandResult = { ok: true; data: SandboxCommandResult } | { ok: false; denial: CommandGateDenial };

/** 一次性命令：三道门 + 执行，宿主拿到的要么是结果要么是拒绝理由 */
export async function runGatedCommand(req: GatedCommandRequest): Promise<GatedCommandResult> {
  const gated = await gateCommand({ userId: req.userId, text: req.command, approved: req.approved, withNetwork: true });
  if (!gated.ok) return { ok: false, denial: gated.denial };
  const fence = fenceDenial(req.userId, req.command, req.approved);
  if (fence) return { ok: false, denial: fence };
  const data = await runSandboxedCommand(req.userId, req.command, {
    timeoutMs: req.timeoutMs,
    networkMode: gated.network!.effective,
    cwd: req.cwd,
  });
  return { ok: true, data };
}

export type GatedSessionResult = { ok: true; data: StdinSessionInfo } | { ok: false; denial: CommandGateDenial };

/** 开一个常驻 stdin 会话：与一次性命令同一道门，网络策略在开席那刻定下；pty=true 优先真终端 */
export async function openGatedSession(
  req: GatedCommandRequest & { ttlMs?: number; pty?: boolean },
): Promise<GatedSessionResult> {
  const gated = await gateCommand({ userId: req.userId, text: req.command, approved: req.approved, withNetwork: true });
  if (!gated.ok) return { ok: false, denial: gated.denial };
  const fence = fenceDenial(req.userId, req.command, req.approved);
  if (fence) return { ok: false, denial: fence };
  const data = await startBrainStdinSession(req.userId, req.command, {
    cwd: req.cwd,
    ttlMs: req.ttlMs,
    networkMode: gated.network!.effective,
    pty: req.pty,
  });
  return { ok: true, data };
}

/** 向会话写一行：input 过命令签名与路径围栏，不重复扫网络 */
export async function writeGatedSession(req: {
  userId: string;
  sessionId: string;
  input?: string;
  approved: boolean;
  waitMs?: number;
  close?: boolean;
}): Promise<GatedSessionResult> {
  if (req.input !== undefined && req.input.trim()) {
    const denial = await gateSessionInput({ userId: req.userId, input: req.input, approved: req.approved });
    if (denial) return { ok: false, denial };
  }
  const data = await writeBrainStdinSession(req.userId, req.sessionId, req.input, {
    waitMs: req.waitMs,
    close: req.close,
  });
  return { ok: true, data };
}

export type GatedServiceResult = { ok: true; data: ServiceInfo } | { ok: false; denial: CommandGateDenial };

/**
 * 启动长驻服务：过与一次性命令完全相同的三道门。
 * 服务进程同样是这条命令拉起来的，少一道门就等于「把危险命令换个入口跑」——
 * start_service 从前只在路由里判风险分级，路径围栏和网络策略都没走。
 */
export async function startGatedService(req: GatedCommandRequest & { ttlMs?: number }): Promise<GatedServiceResult> {
  const gated = await gateCommand({ userId: req.userId, text: req.command, approved: req.approved, withNetwork: true });
  if (!gated.ok) return { ok: false, denial: gated.denial };
  const fence = fenceDenial(req.userId, req.command, req.approved);
  if (fence) return { ok: false, denial: fence };
  const data = await startBrainService(req.userId, req.command, { cwd: req.cwd, ttlMs: req.ttlMs });
  return { ok: true, data };
}
