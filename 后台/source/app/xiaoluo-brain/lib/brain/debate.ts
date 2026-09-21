/**
 * 小逻 v3 —— 多视角碰撞 debate（路线图⑤：创意与决策任务）
 *
 * 对齐 AgentCore debate 的"主持人 + 多视角"骨架，裁掉 30 模块的重型程序，
 * 保留最有价值的两拍：
 *  1. 各视角独立陈述（并发调用同一模型，互不污染）；
 *  2. 主持人综合（看到全部陈述后给出取舍结论）。
 *
 * 形态：纯函数 + 复用现有 callLLM 口，无新适配器；chat-agent 以
 * debate_ideas 工具调用本模块，老板也可在对话里直接触发（"帮我从几个角度分析"）。
 */

import type { ChatMessage } from "./types";

export interface DebateCallLLM {
  (req: { messages: ChatMessage[]; tools: unknown[]; model: string }): Promise<{
    content: string;
    toolCalls?: unknown;
    usage: { promptTokens: number; completionTokens: number };
  }>;
}

export interface DebateOptions {
  callLLM: DebateCallLLM;
  model: string;
  /** 议题 */
  topic: string;
  /** 视角列表（缺省自动生成三视角：乐观推进/审慎风险/用户视角） */
  viewpoints?: string[];
  /** 每个视角陈述字数上限（默认 300） */
  maxWordsPerView?: number;
}

export interface DebatePosition {
  viewpoint: string;
  statement: string;
}

export interface DebateResult {
  positions: DebatePosition[];
  /** 主持人综合结论（含取舍理由） */
  synthesis: string;
  /** 本次 debate 消耗的 token */
  usedTokens: number;
}

const DEFAULT_VIEWPOINTS = [
  "乐观推进者：只看机会与可行性，给出最积极的落地路径",
  "审慎把关者：只看风险、成本与失败模式，泼必要的冷水",
  "最终用户代言人：只关心老板/用户的真实体验与收益",
];

/** 执行一场多视角碰撞：并发陈述 → 主持人综合 */
export async function runDebate(opts: DebateOptions): Promise<DebateResult> {
  const viewpoints = opts.viewpoints?.length ? opts.viewpoints : DEFAULT_VIEWPOINTS;
  const maxWords = opts.maxWordsPerView ?? 300;
  let usedTokens = 0;

  // 第一拍：各视角独立陈述（并发，互不可见对方观点，防随大流）
  const settled = await Promise.allSettled(
    viewpoints.map(async (vp) => {
      const resp = await opts.callLLM({
        messages: [
          {
            role: "system",
            content: `你正在一场多视角讨论中扮演：${vp}。只从该视角发言，${maxWords} 字以内，直接给观点与理由，不要客套。`,
          },
          { role: "user", content: `议题：${opts.topic}` },
        ],
        tools: [],
        model: opts.model,
      });
      usedTokens += resp.usage.promptTokens + resp.usage.completionTokens;
      return { viewpoint: vp, statement: resp.content.trim() };
    }),
  );

  const positions: DebatePosition[] = settled
    .filter(
      (r): r is PromiseFulfilledResult<DebatePosition> => r.status === "fulfilled" && Boolean(r.value.statement),
    )
    .map((r) => r.value);
  if (positions.length === 0) {
    return { positions: [], synthesis: "多视角讨论未能产出有效陈述（模型调用全部失败）。", usedTokens };
  }

  // 第二拍：主持人综合
  const briefing = positions
    .map((p, i) => `【视角 ${i + 1}：${p.viewpoint}】\n${p.statement}`)
    .join("\n\n");
  const synth = await opts.callLLM({
    messages: [
      {
        role: "system",
        content:
          "你是讨论主持人。基于各视角陈述给出综合结论：采纳什么、放弃什么、理由各一句；有冲突时明确取舍标准。不要和稀泥。",
      },
      { role: "user", content: `议题：${opts.topic}\n\n${briefing}` },
    ],
    tools: [],
    model: opts.model,
  });
  usedTokens += synth.usage.promptTokens + synth.usage.completionTokens;

  return { positions, synthesis: synth.content.trim(), usedTokens };
}

/** 把 debate 结果排成给老板看的文本（工具回流与 UI 共用口径） */
export function renderDebateResult(result: DebateResult): string {
  if (result.positions.length === 0) return result.synthesis;
  const parts = result.positions.map(
    (p, i) => `【视角 ${i + 1}：${p.viewpoint}】\n${p.statement}`,
  );
  return [...parts, `【主持人综合】\n${result.synthesis}`].join("\n\n");
}
