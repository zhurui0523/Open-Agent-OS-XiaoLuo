/**
 * 小逻 v3 —— 任务档案（路线图④：长周期多阶段项目）
 *
 * 对话是流水，任务档案是账：长周期任务（分多天聊、跨多个对话）需要一个
 * 稳定的"任务实体"记录目标、状态、产物引用与时间线。
 *
 * 设计：
 *  - TaskRecord = 任务实体（title/status/artifactRefs/timeline）；
 *  - TaskStore = 持久化口（默认 localStorage；P1 换服务端实现零改动迁移）；
 *  - timeline 素材来自 journal（宿主在轮末把 journal.recent() 的 note 抽进来）。
 */

export type TaskStatus = "active" | "done" | "abandoned";

export interface TaskTimelineEvent {
  ts: number;
  /** 时间线一句话（journal note 直接入库） */
  note: string;
}

export interface TaskRecord {
  id: string;
  /** 任务目标（首轮老板意图的一句话概括，后续可被小逻修订） */
  title: string;
  status: TaskStatus;
  /** 归属对话（一个任务可跨对话，conversationIds 可追加） */
  conversationIds: string[];
  /** 产物引用：代码产物标题 / 媒体 assetUrl / 文档摘要等 */
  artifactRefs: string[];
  /** 时间线（journal 抽取，最多保留 50 条） */
  timeline: TaskTimelineEvent[];
  createdAt: number;
  updatedAt: number;
}

const TIMELINE_LIMIT = 50;

/** 任务档案持久化口（⑦ 同款接缝：默认 localStorage，服务端实现见 api.ts） */
export interface TaskStore {
  list(): Promise<TaskRecord[]>;
  get(id: string): Promise<TaskRecord | null>;
  save(record: TaskRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

const TASK_KEY = "xiaoluo-tasks";

export class LocalStorageTaskStore implements TaskStore {
  async list(): Promise<TaskRecord[]> {
    try {
      const raw = localStorage.getItem(TASK_KEY);
      return raw ? (JSON.parse(raw) as TaskRecord[]) : [];
    } catch {
      return [];
    }
  }
  async get(id: string): Promise<TaskRecord | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }
  async save(record: TaskRecord): Promise<void> {
    const all = (await this.list()).filter((t) => t.id !== record.id);
    all.push(record);
    try {
      localStorage.setItem(TASK_KEY, JSON.stringify(all));
    } catch {
      /* 存储满静默 */
    }
  }
  async remove(id: string): Promise<void> {
    try {
      localStorage.setItem(TASK_KEY, JSON.stringify((await this.list()).filter((t) => t.id !== id)));
    } catch {
      /* 静默 */
    }
  }
}

let taskSeq = 0;
const nextTaskId = () => `task-${Date.now()}-${++taskSeq}`;

/** 新建任务档案 */
export function createTask(title: string, conversationId: string): TaskRecord {
  const now = Date.now();
  return {
    id: nextTaskId(),
    title: title.slice(0, 120),
    status: "active",
    conversationIds: [conversationId],
    artifactRefs: [],
    timeline: [{ ts: now, note: `任务建立：${title.slice(0, 80)}` }],
    createdAt: now,
    updatedAt: now,
  };
}

/** 追加时间线事件（journal note 直接入档） */
export function appendTimeline(record: TaskRecord, notes: Array<{ ts: number; note: string }>): void {
  for (const n of notes) {
    record.timeline.push({ ts: n.ts, note: n.note.slice(0, 160) });
  }
  if (record.timeline.length > TIMELINE_LIMIT) {
    record.timeline = record.timeline.slice(-TIMELINE_LIMIT);
  }
  record.updatedAt = Date.now();
}

/** 任务档案摘要（给老板的"项目看板"文案 / 长对话上下文注入共用口径） */
export function renderTaskSummary(record: TaskRecord): string {
  const state = record.status === "active" ? "进行中" : record.status === "done" ? "已完成" : "已放弃";
  const artifacts = record.artifactRefs.length
    ? `\n产物：${record.artifactRefs.slice(-5).join("；")}`
    : "";
  const recent = record.timeline
    .slice(-5)
    .map((e) => `- ${new Date(e.ts).toLocaleString()} ${e.note}`);
  return [`任务「${record.title}」（${state}）`, artifacts, "最近进展：", ...recent]
    .filter(Boolean)
    .join("\n");
}
