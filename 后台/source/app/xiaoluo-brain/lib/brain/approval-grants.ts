/**
 * 小逻 v3 —— 审批放行的会话级记忆与留痕
 *
 * 闸门判定只有一份（app/lib/brain-command-gate.ts），本文件只管老板这一侧的两件事：
 *  1. 「同内容本会话批准过就不再问」：内存表 + 30 分钟 TTL，刷新即清空（不放行跨会话）
 *  2. 决策留痕：localStorage 追加式审计，最近 200 条
 *
 * 面板的 HTTP 适配器与协议宿主（useChatAgent 的 onApproval）都调这一份，
 * 免得两条路各记一本账——老板批准过一次 run_command，不该因为换了条通道再被问一遍。
 */

/** 会话级批准记忆：同类同参操作一次批准全程有效，刷新即清空（安全优先不放行跨会话） */
const approvalGrants = new Map<string, number>();
/** 授权有效期：30 分钟，超时重新询问 */
const APPROVAL_GRANT_TTL_MS = 30 * 60_000;
const AUDIT_KEY = "xiaoluo.approvalAudit.v1";
const AUDIT_MAX = 200;

function approvalKey(scope: string, subject: string): string {
  return scope + "|" + subject.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function wasApproved(scope: string, subject: string): boolean {
  const ts = approvalGrants.get(approvalKey(scope, subject));
  return typeof ts === "number" && Date.now() - ts < APPROVAL_GRANT_TTL_MS;
}

export function markApproved(scope: string, subject: string): void {
  approvalGrants.set(approvalKey(scope, subject), Date.now());
}

/** 审批决策留痕：localStorage 追加式审计（最近 200 条），失败静默 */
export function auditApproval(scope: string, subject: string, ok: boolean, reasons?: string[]): void {
  try {
    const list = JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]") as unknown[];
    list.push({ ts: Date.now(), scope, subject: subject.slice(0, 500), ok, reasons: reasons ?? [] });
    localStorage.setItem(AUDIT_KEY, JSON.stringify(list.slice(-AUDIT_MAX)));
  } catch {
    /* 留痕失败不阻断审批流 */
  }
}

/** 审批弹窗风险摘要：把 reasons 标签翻译成人话，防老板不看内容盲点批准 */
export function riskSummary(reasons?: string[]): string {
  if (!reasons || reasons.length === 0) return "";
  const map: Record<string, string> = {
    全局安装依赖: "会往系统全局环境装软件包（影响所有项目，不只是当前工作区）",
    系统包管理器安装: "会调用 winget/choco/scoop/apt/brew 等系统级包管理器改动本机环境",
    "Python 包安装": "会往 Python 环境装依赖包（pip/uv install）",
  };
  const lines = reasons.map((r) =>
    "⚠ " + (map[r] ?? (/^(网络策略|云元数据|路径围栏)/.test(r) ? r : "命中风险签名：" + r)),
  );
  return "\n【风险摘要·批准前请看清】\n" + lines.join("\n");
}

export interface ApprovalPrompt {
  /** 审批范围（command / stdin / git / service / service-setup）：与闸门同源 */
  scope: string;
  /** 要执行的具体内容（命令原文 / 会话输入 / git 操作），也是放行记忆的键 */
  subject: string;
  /** 文案里的动作，如「执行这条命令」 */
  action: string;
  reasons?: string[];
}

/**
 * 问老板：确认框 + 留痕，返回是否批准。
 * 没有窗口（SSR / 后台宿主）就按拒绝处理——审批的失败方向永远是安全的那一边。
 */
export function confirmApproval(prompt: ApprovalPrompt): boolean {
  if (typeof window === "undefined") return false;
  const reasonLines = (prompt.reasons ?? []).map((r) => "· " + r).join("\n");
  const ok = window.confirm(
    "小逻想" + prompt.action + "，需要你批准：\n\n" +
      prompt.subject +
      riskSummary(prompt.reasons) +
      (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
      "\n\n确定执行吗？（批准后本会话内相同内容不再询问）",
  );
  auditApproval(prompt.scope, prompt.subject, ok, prompt.reasons);
  return ok;
}
