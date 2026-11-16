/**
 * Guardian 审查（第 7.9 项，学 Codex `guardian-context` 的异步打分）
 *
 * 小逻已有两道理性闸：命令风险分级（blocked / needs_approval / safe）+ 宿主四档审批。
 * 但闸门只认"命令长什么样"，不认"这条命令和老板这轮要干的事是否自洽"。Guardian 补的正是这一层：
 *   1. 规则信号：凭据文件外发、越界批量删除、管道执行远端脚本等组合模式（零成本、永远在）；
 *   2. 模型复核（可选，hooks.toml `[guardian] review = "model"` 才开）：
 *      给"需要审批/命中信号"的命令加一次上下文判断——本轮目标是否覆盖它、是否不可逆、是否碰凭据；
 *      模型只回答 allow / review / deny + 一句理由，8 秒超时按 review 兜底（绝不因超时自动放行高危）。
 *
 * 边界：这是第三道建议线，不是沙箱；deny 只对"规则明确命中"生效，模型 deny 需给出理由并记账，
 * 老板仍可在 UI 里看到被拦原因并改口。guardian 不替代宿主的审批门。
 */

export type GuardianDecision = "allow" | "review" | "deny";
export type GuardianLevel = "low" | "medium" | "high";

export interface GuardianConfig {
  /** 总开关；hooks.toml 写 `[guardian] enabled = false` 可关（默认开） */
  enabled: boolean;
  /** 复核方式：rules=只跑规则；model=规则 + 模型第二意见 */
  review: "rules" | "model";
  /** 复核用的模型名（缺省用当前主模型） */
  model?: string;
}

export interface GuardianVerdict {
  decision: GuardianDecision;
  level: GuardianLevel;
  reason: string;
  source: "rule" | "model" | "config" | "fallback";
  /** 命中的信号标签（给 UI/日志用） */
  signals: string[];
}

/** 解析 hooks.toml 里的 [guardian] 段；坏行忽略，缺省 enabled=true、review=rules */
export function parseGuardianConfig(raw: string): GuardianConfig {
  const cfg: GuardianConfig = { enabled: true, review: "rules" };
  let inSection = false;
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed.slice(1, -1).trim().toLowerCase() === "guardian";
      continue;
    }
    if (!inSection || !trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (key === "enabled") cfg.enabled = value === "true" || value === "1";
    else if (key === "review") cfg.review = value === "model" ? "model" : "rules";
    else if (key === "model") cfg.model = value;
  }
  return cfg;
}

/** 凭据类文件（读它们 + 联网 = 典型外发前奏） */
const SECRET_FILE = /(?:^|[\/\s"'=])(?:\.env(?:\.\w+)?|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.ssh[\/\\]|credentials|secrets\.json|mcp\.json|\.git-credentials)(?:$|[\s"'\/\\])/i;
/** 网络外发动作 */
const NETWORK_TOOL = /\b(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|nc|ncat|netcat|scp|rsync|ftp|telnet)\b/i;
/** 管道执行远端/编码内容 */
const PIPE_EXEC = /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sh|bash|zsh|node|python|python3|pwsh|powershell|iex|Invoke-Expression)\b/i;
/** 读凭据后直接打编码（防 base64 搬运） */
const ENCODE_SECRET = /\b(?:base64|xxd|openssl\s+enc)\b/i;
/** 越界批量删除（盘符根/用户目录整层） */
const MASS_DELETE = /\b(?:rm\s+-rf|rmdir\s+\/s|del\s+\/f\s+\/s|Remove-Item\b[^\n]*-Recurse[^\n]*-Force)\b/i;
const DANGEROUS_ROOT = /(?:\bC:\s*\\|\\Windows\\|\/etc\/|\/usr\/|\/var\/|\/Users\/|\/home\/|%USERPROFILE%\\)/i;
/** 强制推送历史改写 */
const FORCE_PUSH = /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|-f\b)/i;
/** 关闭审计/清空日志（反取证） */
const ANTI_FORENSIC = /\b(?:wevtutil\s+cl|Clear-EventLog|history\s+-c|Remove-Item\s+.*\.log)\b/i;

/**
 * 规则信号分级：
 *  - high → deny（凭据外发组合、管道执行远端脚本、强制推送、反取证）
 *  - medium → review（越界批量删除、编码凭据、疑似删除系统目录）
 *  - low → allow
 */
export function scanGuardianSignals(command: string): { level: GuardianLevel; signals: string[] } {
  const text = String(command ?? "");
  const signals: string[] = [];
  let level: GuardianLevel = "low";
  const mark = (label: string, lv: GuardianLevel) => {
    if (!signals.includes(label)) signals.push(label);
    if (lv === "high" || (lv === "medium" && level === "low")) level = lv;
  };

  if (SECRET_FILE.test(text) && (NETWORK_TOOL.test(text) || ENCODE_SECRET.test(text))) {
    mark("凭据文件读取 + 外发/编码", "high");
  }
  if (PIPE_EXEC.test(text)) mark("远端脚本直接管道执行", "high");
  if (FORCE_PUSH.test(text)) mark("强制推送改写远端历史", "high");
  if (ANTI_FORENSIC.test(text)) mark("清理审计/日志（反取证）", "high");

  if (MASS_DELETE.test(text) && DANGEROUS_ROOT.test(text)) mark("越界批量删除（系统/用户目录）", "medium");
  if (SECRET_FILE.test(text) && ENCODE_SECRET.test(text)) mark("凭据内容编码", "medium");

  return { level, signals };
}

export function buildGuardianPrompt(input: {
  command: string;
  cwd?: string;
  goal?: string;
  riskReasons?: string[];
  signals?: string[];
}): string {
  const goal = input.goal?.trim() ? input.goal.trim().slice(0, 600) : "（本轮没有明确目标）";
  return [
    "你是小逻的命令审查员（guardian）。只判断这一条命令是否应该被执行，不要改写命令、不要解释技术细节。",
    "判定标准（按顺序）：",
    "1. 与老板本轮目标无关、或明显超出目标范围 → deny；",
    "2. 会造成不可逆损害（删库/强制改写远端历史/清空日志/泄露凭据）→ deny；",
    "3. 目标可能覆盖它，但风险边界不清楚（越界路径、批量删除、网络外发）→ review；",
    "4. 常规、可逆、与目标一致 → allow。",
    "只输出一行 JSON：{\"verdict\":\"allow|review|deny\",\"reason\":\"不超过 60 字的中文理由\"}",
    "本轮目标：" + goal,
    "命令：" + input.command.slice(0, 1200),
    input.cwd ? "工作目录：" + input.cwd : "",
    input.riskReasons?.length ? "风险分级命中：" + input.riskReasons.join("、") : "",
    input.signals?.length ? "Guardian 规则信号：" + input.signals.join("、") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 容错解析模型回包：只认第一个 JSON 对象，verdict 非法按 review */
export function parseGuardianModelReply(text: string): { verdict: GuardianDecision; reason: string } {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { verdict: "review", reason: "审查回包无法解析，按需复核处理" };
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { verdict?: string; reason?: string };
    const v = String(obj.verdict ?? "").toLowerCase();
    const verdict: GuardianDecision = v === "allow" || v === "deny" ? (v as GuardianDecision) : "review";
    return { verdict, reason: String(obj.reason ?? "").slice(0, 120) || "模型未给理由" };
  } catch {
    return { verdict: "review", reason: "审查回包 JSON 解析失败，按需复核处理" };
  }
}

/** 规则 +（可选）模型复核合成最终裁决；模型失败/超时一律 review，绝不自动 allow 高危 */
export async function runGuardianReview(input: {
  command: string;
  cwd?: string;
  goal?: string;
  riskLevel?: string;
  riskReasons?: string[];
  config: GuardianConfig;
  /** 调用模型的函数（不实现则只跑规则） */
  callModel?: (prompt: string, model?: string) => Promise<string>;
}): Promise<GuardianVerdict> {
  const { config } = input;
  if (!config.enabled) {
    return { decision: "allow", level: "low", reason: "guardian 已在 hooks.toml 关闭", source: "config", signals: [] };
  }
  const rule = scanGuardianSignals(input.command);
  if (rule.level === "high") {
    return {
      decision: "deny",
      level: "high",
      reason: "命中高危组合：" + rule.signals.join("、"),
      source: "rule",
      signals: rule.signals,
    };
  }
  const callModel = input.callModel;
  const wantsModel = config.review === "model" && typeof callModel === "function";
  if (!wantsModel || !callModel) {
    return {
      decision: rule.level === "medium" ? "review" : "allow",
      level: rule.level,
      reason: rule.level === "medium" ? "命中信号：" + rule.signals.join("、") : "未命中风险信号",
      source: "rule",
      signals: rule.signals,
    };
  }
  try {
    const prompt = buildGuardianPrompt({
      command: input.command,
      cwd: input.cwd,
      goal: input.goal,
      riskReasons: input.riskReasons,
      signals: rule.signals,
    });
    const reply = await callModel(prompt, config.model);
    const parsed = parseGuardianModelReply(reply);
    return {
      decision: parsed.verdict,
      level: parsed.verdict === "deny" ? "high" : rule.level === "low" ? "medium" : rule.level,
      reason: parsed.reason,
      source: "model",
      signals: rule.signals,
    };
  } catch (error) {
    // 审查通道不可用不等于命令安全：按 review 回流，让老板自己拍板
    return {
      decision: "review",
      level: rule.level === "low" ? "medium" : rule.level,
      reason: "guardian 模型复核失败（" + (error instanceof Error ? error.message.slice(0, 80) : "未知错误") + "），按需复核处理",
      source: "fallback",
      signals: rule.signals,
    };
  }
}
