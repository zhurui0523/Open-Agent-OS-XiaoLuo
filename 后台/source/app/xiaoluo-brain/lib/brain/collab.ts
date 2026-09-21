/**
 * 小逻 v3 —— 协作台账 collab（路线图⑥：组织协作平台的度量底座）
 *
 * 对齐 AgentCore collab 台账三类信号，裁剪为轻量记录器：
 *  - boundary_yield：边界交接（对话侧↔画布侧的产物移交，如 generate_media 结果）
 *  - scope_signal：范围信号（老板中途改方向/加需求，防"悄悄膨胀"无迹可查）
 *  - escalation：升级（熔断/预算耗尽/需要老板拍板的时刻）
 *
 * 用途：summarize() 产出"这场协作发生了什么"的度量摘要——
 * 组织场景复盘、长任务汇报、以及提醒小逻自己在 steer 时收敛范围。
 */

export type CollabSignalKind = "boundary_yield" | "scope_signal" | "escalation";

export interface CollabEntry {
  id: number;
  kind: CollabSignalKind;
  /** 信号发起方：boss（老板）/ xiaoluo（小逻）/ canvas（画布侧）/ system（治理） */
  actor: "boss" | "xiaoluo" | "canvas" | "system";
  /** 一句话描述 */
  note: string;
  ts: number;
}

const COLLAB_LIMIT = 200;

export class CollabLedger {
  private entries: CollabEntry[] = [];
  private seq = 0;

  record(kind: CollabSignalKind, actor: CollabEntry["actor"], note: string): void {
    this.seq += 1;
    this.entries.push({ id: this.seq, kind, actor, note: note.slice(0, 200), ts: Date.now() });
    if (this.entries.length > COLLAB_LIMIT) this.entries.shift();
  }

  all(): CollabEntry[] {
    return [...this.entries];
  }

  count(kind: CollabSignalKind): number {
    return this.entries.filter((e) => e.kind === kind).length;
  }

  /** 度量摘要：交接了几次、范围动了几次、升级了几次 + 最近事件 */
  summarize(): string {
    if (this.entries.length === 0) return "";
    const yields = this.count("boundary_yield");
    const scopes = this.count("scope_signal");
    const escalations = this.count("escalation");
    const recent = this.entries
      .slice(-5)
      .map((e) => `- [${e.kind}] ${e.actor}：${e.note}`);
    return [
      `协作台账：产物交接 ${yields} 次；范围调整 ${scopes} 次；升级决策 ${escalations} 次。`,
      "最近事件：",
      ...recent,
    ].join("\n");
  }

  serialize(): CollabEntry[] {
    return this.all();
  }
}
