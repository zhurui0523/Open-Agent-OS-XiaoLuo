/**
 * 小逻 v3 —— 结果验收器（closing posture）
 *
 * 参照 AgentCore runtime/closing_posture（防空交付/空洞结果），裁剪为纯规则检查：
 * 不调用 LLM，产出后同步判定"能不能算完成"。
 *
 * 两条验收线：
 *  1. validateNodeResult：节点/产物级验收（write_code 产出、generate_media 回流前）；
 *  2. closingCheck（路线图③补全）：轮末正文交付检查——hollow（空洞正文）、
 *     empty_handoff（无产物也无实质结论）、missing_citation（用了检索却不引用）。
 */

import type { Modality, NodeRunResult, PlanStep } from "./types";
import { validateCodeResult } from "./code";

export interface ValidationVerdict {
  ok: boolean;
  /** 不合格原因（ok=false 时拼进 tool result 喂回 CEO） */
  problems: string[];
  /** 非阻断告警（如代码风险签名）：ok 仍可为 true，但需 CEO 如实告知老板 */
  warnings?: string[];
}

/** 媒体类产物必须有可访问地址 */
const MEDIA_MODALITIES: Modality[] = ["image", "video", "audio", "document"];

/**
 * 单节点验收：
 * 1. 失败节点直接不合格（带错误原因）
 * 2. 文本产物非空且长度达标（防空交付）
 * 3. 媒体产物必须有 assetUrl（防"显示成功但地址丢失"——历史踩过的坑）
 * 4. 声明了下游依赖的产物必须可被消费（outputSummary 或 assetUrl 至少其一）
 */
export function validateNodeResult(
  step: PlanStep | undefined,
  result: NodeRunResult,
  hasDownstream: boolean,
): ValidationVerdict {
  const problems: string[] = [];

  if (result.status === "cancelled") {
    return { ok: false, problems: ["执行被取消"] };
  }

  if (result.status === "failed") {
    return { ok: false, problems: [result.error || "执行失败（无错误详情）"] };
  }

  // reused 节点沿用既有产物，只查产物存在性
  if (result.reused && !result.assetUrl && !result.outputSummary) {
    problems.push("复用上游结果但产物快照为空");
  }

  const modality = step?.modality;

  // 代码产物：结构完整性 + 风险扫描（一期代码即交付物，不执行）
  if (modality === "code") {
    const verdict = validateCodeResult(result);
    // 三期交付节点：必须产出结构化交付包（清单 + 安装/运行指引）
    if (step?.skillId === "code-deliver" && !result.delivery) {
      verdict.problems.push("交付节点未产出结构化交付包（delivery 字段缺失）");
    }
    return { ...verdict, ok: verdict.ok && problems.length === 0, problems: [...verdict.problems, ...problems] };
  }

  if (modality === "text" || modality === "document") {
    const text = (result.outputSummary || "").trim();
    if (!text) {
      problems.push("文本产物为空");
    } else if (modality === "text" && text.length < 10) {
      // 空交付哨兵：过短的文本大概率是占位/失败回显
      problems.push(`文本产物过短（${text.length} 字），疑似空洞结果`);
    }
  }

  if (modality && MEDIA_MODALITIES.includes(modality)) {
    if (!result.assetUrl || !/^https?:\/\//.test(result.assetUrl)) {
      problems.push(`${modality} 产物缺少有效资源地址`);
    }
  }

  if (hasDownstream && !result.assetUrl && !(result.outputSummary || "").trim()) {
    problems.push("下游节点依赖此产物，但产物摘要与地址均为空");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 整批验收：给 CEO 的 tool result 文案。
 * 全部合格 → 简短确认；有不合格 → 逐条列出，供 CEO 决定重规划还是 ask_user。
 */
export function summarizeValidation(
  results: Array<{ step: PlanStep | undefined; result: NodeRunResult; verdict: ValidationVerdict }>,
): string {
  const failed = results.filter((r) => !r.verdict.ok);
  const warned = results
    .map((r) => ({ title: r.step?.title ?? r.result.nodeId, warnings: r.verdict.warnings ?? [] }))
    .filter((r) => r.warnings.length > 0);
  if (failed.length === 0) {
    const base = `验收通过：${results.length} 个节点全部产出有效产物。可以 finish 交付。`;
    if (warned.length === 0) return base;
    const lines = warned.flatMap(({ title, warnings }) =>
      warnings.map((w) => `- 「${title}」${w}：交付时请如实提醒老板`),
    );
    return [base, "注意：以下告警需在 finish 时如实告知老板：", ...lines].join("\n");
  }
  const lines = failed.map(({ step, result, verdict }) => {
    const title = step?.title ?? result.nodeId;
    return `- 「${title}」不合格：${verdict.problems.join("；")}`;
  });
  const warnLines = warned.flatMap(({ title, warnings }) =>
    warnings.map((w) => `- 「${title}」${w}：交付时请如实提醒老板`),
  );
  return [
    `验收未通过：${results.length} 个节点中 ${failed.length} 个不合格。`,
    ...lines,
    ...(warnLines.length > 0 ? ["另需注意：", ...warnLines] : []),
    "请决定：修改计划重新规划（避免重复已成功的节点），或 ask_user 请老板决策。",
  ].join("\n");
}

// ---------- closing posture：轮末正文交付检查（路线图③） ----------

export interface ClosingContext {
  /** 小逻本轮的最终正文 */
  content: string;
  /** 本轮是否产出过实体产物（代码卡/媒体卡/文件写入） */
  hadArtifact: boolean;
  /** 证据账本是否有 web 类材料（用过检索/看过网页） */
  hasWebEvidence: boolean;
}

/** 空洞判定阈值：去掉 markdown 符号与空白后的有效字符数 */
const HOLLOW_LIMIT = 20;

/**
 * 轮末交付检查（纯规则，不用 LLM）：
 *  1. hollow：正文过短且无产物——疑似空洞回复；
 *  2. empty_handoff：没产物、正文也没有实质结论词（空手交付）；
 *  3. missing_citation：用过检索/网页却不标注 #rN 引用（事实无源）。
 * 不合格不阻断交付（对话型不打断老板），由 Agent 注入提醒下轮自补。
 */
export function closingCheck(ctx: ClosingContext): ValidationVerdict {
  const problems: string[] = [];
  const stripped = ctx.content
    .replace(/[#>*_`~\-|]/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!ctx.hadArtifact && stripped.length < HOLLOW_LIMIT) {
    problems.push("正文过短且本轮无产物，疑似空洞回复，请给出实质内容");
  }

  if (ctx.hasWebEvidence && !/#r\d+/.test(ctx.content)) {
    problems.push("本轮用过检索/网页材料但正文未标注 #rN 引用，请补上事实来源编号");
  }

  return { ok: problems.length === 0, problems };
}
