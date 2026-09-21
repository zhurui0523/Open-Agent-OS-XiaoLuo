/**
 * 小逻 v3 —— 证据账本（Evidence Ledger，路线图③：知识工作场景）
 *
 * 对齐 AgentCore evidence_ledger + #rN 引用机制：
 *  - 检索/读文件/跑命令/看网页得到的事实材料，统一入账并分配 #rN 编号；
 *  - 小逻写报告/给结论时引用 #rN，交付时附引用清单——事实可溯源；
 *  - 纯内存账本（随对话生命周期），不落盘：引用服务于当轮交付质量。
 *
 * 接线点：chat-agent 在 web_search / read_file / run_command / browse_page
 * 结果回流时调 add()；收尾前把 renderForPrompt() 注入提示，
 * closing posture 检查正文是否实际使用了引用编号。
 */

export type EvidenceSource = "web" | "file" | "command" | "page" | "service";

export interface EvidenceItem {
  /** 引用编号（从 1 递增，展示为 #r1、#r2…） */
  id: number;
  /** 材料来源类别 */
  source: EvidenceSource;
  /** 定位符：URL / 文件路径 / 命令串 */
  locator: string;
  /** 摘录正文（裁剪后，防上下文膨胀） */
  excerpt: string;
  addedAt: number;
}

/** 单条摘录上限（字符）：超长材料截断，引用只留关键段 */
const EXCERPT_LIMIT = 600;
/** 账本容量上限：超出后淘汰最旧（引用编号保持原值不回缩） */
const LEDGER_LIMIT = 24;

export class EvidenceLedger {
  private items: EvidenceItem[] = [];
  private seq = 0;

  /** 入账一条证据，返回其引用编号文本（如 "#r3"） */
  add(source: EvidenceSource, locator: string, excerpt: string): string {
    this.seq += 1;
    this.items.push({
      id: this.seq,
      source,
      locator: locator.slice(0, 200),
      excerpt: excerpt.trim().slice(0, EXCERPT_LIMIT),
      addedAt: Date.now(),
    });
    if (this.items.length > LEDGER_LIMIT) this.items.shift();
    return `#r${this.seq}`;
  }

  all(): EvidenceItem[] {
    return [...this.items];
  }

  /** 是否收过 web 类证据（closing posture 用它判定"报告应当带引用"） */
  hasWebEvidence(): boolean {
    return this.items.some((i) => i.source === "web" || i.source === "page");
  }

  /** 注入 LLM 上下文的材料清单（供小逻引用时查编号） */
  renderForPrompt(): string {
    if (this.items.length === 0) return "";
    const lines = this.items.map(
      (i) => `#r${i.id} [${i.source}] ${i.locator}\n${i.excerpt}`,
    );
    return `[证据账本]\n${lines.join("\n\n")}\n引用事实时请在正文标注对应编号（如 #r2）。`;
  }

  /** 交付正文末尾的引用清单（markdown） */
  renderCitations(): string {
    if (this.items.length === 0) return "";
    const lines = this.items.map((i) => `- #r${i.id} ${i.locator}`);
    return ["**参考来源**", ...lines].join("\n");
  }
}
