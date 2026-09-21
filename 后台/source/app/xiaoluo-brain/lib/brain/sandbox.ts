/**
 * 小逻大脑 v2 —— 代码受控执行（二期脚手架）
 *
 * 架构立场（v3 同样成立：对话层零改动）：
 *  - 代码执行仍是“生成/工具链路之后”的事，由适配层在代码产物要求执行时调用；
 *    ChatAgent / useChatAgent 不感知沙箱。
 *  - 本文件只定义契约与纯函数：适配器按契约实现（Docker 容器 / WASM /
 *    本地受控子进程均可），不实现则整个二期不激活（一期行为不变）。
 *
 * 安全三原则（对齐 AgentCore gvisor 的意图，但用轻量手段）：
 *  1. 网络默认禁：出口白名单显式声明（如 npm/pypi 源），其余全封；
 *  2. 风险签名升级为审批门：一期 scanCodeRisk 的告警在二期变为"不批准不执行"；
 *  3. 资源硬顶：超时 / 内存 / 输出截断，防止跑飞与日志炸上下文。
 */

import type { CodeArtifact, NodeRunResult } from "./types";
import { scanCodeRisk, summarizeCodeArtifact } from "./code";

// ---------- 执行契约（适配器实现此口） ----------

/** 网络出口策略：默认全封，白名单显式放行 */
export interface SandboxNetworkPolicy {
  /** true = 完全断网（默认，纯计算/测试场景推荐） */
  denyAll: boolean;
  /** 白名单域名（仅 denyAll=false 时生效），如 registry.npmjs.org */
  allowHosts?: string[];
}

export interface CodeExecutionRequest {
  /** 待执行的代码交付物（先落盘到沙箱工作区再执行） */
  artifact: CodeArtifact;
  /** 执行命令（如 "npm test" / "python -m pytest"）；缺省用 entryFile 推断 */
  command: string;
  /** 超时毫秒（默认 60s；到期强杀，按超时失败处理） */
  timeoutMs?: number;
  /** 网络策略（默认 denyAll） */
  network?: SandboxNetworkPolicy;
}

export interface CodeExecutionResult {
  exitCode: number;
  /** stdout 尾部（截断到 ≤2000 字符，防炸 CEO 上下文） */
  stdoutTail: string;
  /** stderr 尾部（同上） */
  stderrTail: string;
  /** 实测耗时毫秒 */
  durationMs: number;
  /** 因超时被强杀 */
  timedOut?: boolean;
  /** 从输出解析出的测试信号（解析不到则为空，验收层会按 exitCode 兜底） */
  testReport?: { passed?: number; failed?: number; summary?: string };
}

/** 沙箱适配器口：runNodes 适配器在代码节点"要求执行"时调用 */
export type SandboxRunner = (req: CodeExecutionRequest) => Promise<CodeExecutionResult>;

/** 执行请求的默认值与硬顶 */
export const SANDBOX_LIMITS = {
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 300_000,
  maxOutputTailChars: 2_000,
} as const;

export function normalizeExecutionRequest(req: CodeExecutionRequest): CodeExecutionRequest {
  return {
    ...req,
    timeoutMs: Math.min(
      Math.max(req.timeoutMs ?? SANDBOX_LIMITS.defaultTimeoutMs, 1_000),
      SANDBOX_LIMITS.maxTimeoutMs,
    ),
    network: req.network ?? { denyAll: true },
  };
}

// ---------- 审批门：一期风险签名在二期的升级路径 ----------

export type ExecutionRiskLevel = "safe" | "needs_approval" | "blocked";

/** 命令级危险签名（与 code.ts 的内容级签名互补：这里管"怎么跑"） */
const DANGEROUS_COMMAND_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "递归删除", pattern: /rm\s+-rf|Remove-Item\s+.*-Recurse/i },
  { label: "管道直执行远程脚本", pattern: /curl\s+[^\n|]*\|\s*(sh|bash|powershell)/i },
  { label: "系统级包写入（sudo apt/brew install）", pattern: /sudo\s+(apt|brew|choco|winget)/i },
  { label: "发布/推送类副作用（npm publish / git push）", pattern: /npm\s+publish|git\s+push/i },
];

/**
 * 执行前分级：
 *  - safe：内容无风险签名且命令干净 → 直接执行
 *  - needs_approval：内容或命令命中风险签名 → 必须由老板批准（走计划确认横幅/ask_user）
 *  - blocked：命令要求断网白名单之外的网络且命中高危 → 拒绝执行（fail-closed）
 */
export function classifyExecutionRisk(
  artifact: CodeArtifact,
  command: string,
): { level: ExecutionRiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  reasons.push(...scanCodeRisk(artifact));
  for (const risk of DANGEROUS_COMMAND_PATTERNS) {
    if (risk.pattern.test(command)) {
      reasons.push(`[风险] 执行命令：${risk.label}`);
    }
  }
  if (reasons.length === 0) return { level: "safe", reasons };
  const hasBlocked = reasons.some((r) => r.includes("不可逆数据库操作"));
  return { level: hasBlocked ? "blocked" : "needs_approval", reasons };
}

// ---------- 测试信号解析（stdout → testReport） ----------

interface TestSignalRule {
  pattern: RegExp;
  extract: (m: RegExpMatchArray) => { passed?: number; failed?: number; summary?: string };
}

/** 常见测试输出的信号规则（jest / pytest / vitest / go test 口径） */
const TEST_SIGNAL_RULES: TestSignalRule[] = [
  {
    // jest/vitest: Tests: 3 failed, 12 passed, 15 total
    pattern: /Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*passed)?[^]*?(\d+)\s*total/i,
    extract: (m) => ({
      failed: m[1] ? Number(m[1]) : 0,
      passed: m[2] ? Number(m[2]) : Number(m[3]) - (m[1] ? Number(m[1]) : 0),
      summary: m[0].trim(),
    }),
  },
  {
    // pytest: 12 passed, 3 failed in 1.23s
    pattern: /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i,
    extract: (m) => ({
      passed: Number(m[1]),
      failed: m[2] ? Number(m[2]) : 0,
      summary: m[0].trim(),
    }),
  },
  {
    // go test: ok / FAIL 行计数
    pattern: /^(ok|FAIL)\s+\S+/gm,
    extract: (m) => {
      const text = m[0];
      const ok = (text.match(/^ok /gm) || []).length;
      const fail = (text.match(/^FAIL /gm) || []).length;
      return { passed: ok, failed: fail, summary: `go test: ${ok} ok / ${fail} fail` };
    },
  },
];

/** 从执行输出提取测试信号；无匹配返回 undefined（验收层按 exitCode 兜底） */
export function parseTestSignals(
  exec: Pick<CodeExecutionResult, "stdoutTail" | "stderrTail">,
): CodeExecutionResult["testReport"] {
  const text = `${exec.stdoutTail}\n${exec.stderrTail}`;
  for (const rule of TEST_SIGNAL_RULES) {
    const m = text.match(rule.pattern);
    if (m) return rule.extract(m);
  }
  return undefined;
}

// ---------- 结果映射（执行结果 → NodeRunResult，供适配器直接回传循环） ----------

/**
 * 把沙箱执行结果映射成循环认识的 NodeRunResult：
 *  - 超时/非零退出 → failed（带尾部日志，供 CEO 重规划）
 *  - 成功 → code 产物保留 + testReport 填实测信号
 */
export function toNodeRunResult(
  stepId: string,
  nodeId: string,
  artifact: CodeArtifact,
  exec: CodeExecutionResult,
): NodeRunResult {
  if (exec.timedOut) {
    return {
      stepId,
      nodeId,
      status: "failed",
      outputSummary: summarizeCodeArtifact(artifact),
      code: artifact,
      error: `执行超时（已强杀）。stderr 尾部：${exec.stderrTail.slice(-400) || "（无）"}`,
    };
  }
  if (exec.exitCode !== 0) {
    return {
      stepId,
      nodeId,
      status: "failed",
      outputSummary: summarizeCodeArtifact(artifact),
      code: artifact,
      error: `退出码 ${exec.exitCode}。stderr 尾部：${exec.stderrTail.slice(-400) || "（无）"}`,
    };
  }
  return {
    stepId,
    nodeId,
    status: "succeeded",
    outputSummary: `${summarizeCodeArtifact(artifact)}；执行通过（${exec.durationMs}ms）`,
    code: { ...artifact, testReport: exec.testReport ?? parseTestSignals(exec) },
  };
}

/**
 * 集成备注（给 runNodes 适配器实现者）：
 * 1. 代码节点配置"执行模式"时：normalizeExecutionRequest → classifyExecutionRisk
 *    → safe 直接跑；needs_approval 先走计划确认/ask_user，老板批准再跑；blocked 直接 failed。
 * 2. 执行实现任选：Docker（推荐，网络用 --network none + 代理白名单）/ WASM / 受控子进程；
 *    工作区用临时目录，执行完即销毁，绝不碰老板真实文件系统。
 * 3. 结果一律走 toNodeRunResult 映射后回传——循环侧看到的仍是普通节点结果，
 *    验收（validate.ts 的 code 分支）会自动消费 testReport 实测信号。
 */
