/**
 * 小逻 v3 —— 事件溯源 journal（路线图④：长周期任务的审计与折叠）
 *
 * 对齐 AgentCore journal fold：对话中每个关键动作 append-only 入账，
 * 用途：
 *  1. 审计回放：出问题时能还原"小逻当时干了什么"；
 *  2. 上下文折叠：历史太长时 fold() 压成摘要注入，替代逐条重放；
 *  3. 任务档案的原始素材（tasks.ts 从 journal 抽时间线）。
 *
 * 纯内存 + 可序列化：宿主想落盘/上报，把 entries() 交给自己的存储即可。
 */

export type JournalKind =
  | "turn_start" //   老板发消息（新一轮开始）
  | "turn_end" //     本轮结束（带步数/消耗/结局标记）
  | "tool_call" //    工具调用（name + 参数摘要）
  | "tool_result" //  工具结果（成功/失败 + 摘要）
  | "llm_error" //    LLM 中断/重试
  | "steer" //        老板中途插话
  | "ask" //          反问挂起
  | "answer" //       反问应答
  | "budget" //       预算事件（软顶提示/硬顶截断）
  | "assistant"; //   小逻对老板说的话（账本铁律：可见即留痕）

export interface JournalEntry {
  /** 会话内自增序号 */
  seq: number;
  ts: number;
  kind: JournalKind;
  /** 事件摘要（人可读，折叠与 UI 展示共用） */
  note: string;
  /** 结构化负载（审计回放用，保持小而扁） */
  payload?: Record<string, unknown>;
}

/** 账本容量上限：超出淘汰最旧（保留最近的活动窗口） */
const JOURNAL_LIMIT = 400;

export class Journal {
  private entries: JournalEntry[] = [];
  private seq = 0;

  /** append-only 入账 */
  append(kind: JournalKind, note: string, payload?: Record<string, unknown>): void {
    this.seq += 1;
    this.entries.push({ seq: this.seq, ts: Date.now(), kind, note, payload });
    if (this.entries.length > JOURNAL_LIMIT) this.entries.shift();
  }

  all(): JournalEntry[] {
    return [...this.entries];
  }

  /** 最近 N 条（任务档案时间线用） */
  recent(n: number): JournalEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * fold：把全部事件折叠成一段紧凑摘要（长对话注入上下文用）。
   * 规则：工具调用按名聚合计数，其余事件取 note 串；总长受 maxChars 约束。
   */
  fold(maxChars = 1200): string {
    if (this.entries.length === 0) return "";
    const toolCounts = new Map<string, number>();
    const others: string[] = [];
    for (const e of this.entries) {
      if (e.kind === "tool_call") {
        const name = String(e.payload?.tool ?? "unknown");
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      } else if (e.kind === "turn_start" || e.kind === "turn_end" || e.kind === "budget") {
        others.push(e.note);
      }
    }
    const toolLine =
      toolCounts.size > 0
        ? `工具调用：${[...toolCounts.entries()].map(([k, v]) => `${k}×${v}`).join("、")}`
        : "";
    const text = [toolLine, ...others].filter(Boolean).join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /** 序列化（宿主落盘/上报） */
  serialize(): JournalEntry[] {
    return this.all();
  }
}
