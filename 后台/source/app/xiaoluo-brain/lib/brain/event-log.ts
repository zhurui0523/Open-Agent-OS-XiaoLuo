/**
 * 小逻 v3 —— 会话线程事件流（路线图 P1-3：上下文持久化）
 *
 * 现状是「整份 ChatPersistence JSON 每秒覆盖写」：写到一半崩就剩半份，也没有历史可回放。
 * 这里对齐 Codex rollout 的做法：每会话一条 append-only JSONL，每行
 * `{"seq","ts","type","payload"}`，追加写、逐行可解析，末行损坏只丢一行不丢整份。
 *
 * 分工：
 *  - 事件流 = 事实来源（崩溃恢复、回放、审计）
 *  - 快照   = 读路径加速（存在且合法就直接用）
 *
 * 事件类型：
 *   messages_append   新消息追加（payload.items，按顺序）
 *   messages_replace  历史被压缩/重写（payload.items 为完整新列表，payload.reason）
 *   meta              累计 token、中断标记等可变元数据
 */
import fs from "node:fs/promises";
import path from "node:path";

export type ThreadEventType = "messages_append" | "messages_replace" | "meta";

export interface ThreadEvent {
  seq: number;
  ts: number;
  type: ThreadEventType;
  payload: Record<string, unknown>;
}

export interface ThreadReadResult {
  events: ThreadEvent[];
  /** 是否发现并跳过损坏行（崩溃中断的痕迹） */
  recovered: boolean;
  skippedLines: number;
}

const ROOT = process.env.XIAOLUO_THREAD_EVENTS_ROOT
  ? path.resolve(process.env.XIAOLUO_THREAD_EVENTS_ROOT)
  : path.join(process.cwd(), ".data", "brain-thread");

/** 线程库（thread-store）要扫同一个目录，这里导出根路径，避免两处路径漂移 */
export const THREAD_EVENTS_ROOT = ROOT;

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function threadEventPath(userId: string, conversationId: string): string {
  return path.join(ROOT, safePart(userId) + "__" + safePart(conversationId) + ".jsonl");
}

/** 由最后一次读取得到的最大 seq（空文件 = 0），保证追加时序号单调 */
export async function lastThreadSeq(userId: string, conversationId: string): Promise<number> {
  const { events } = await readThreadEvents(userId, conversationId);
  return events.length ? events[events.length - 1].seq : 0;
}

export async function appendThreadEvents(
  userId: string,
  conversationId: string,
  drafts: Array<{ type: ThreadEventType; payload: Record<string, unknown> }>,
): Promise<number> {
  if (!drafts.length) return 0;
  const file = threadEventPath(userId, conversationId);
  await fs.mkdir(ROOT, { recursive: true });
  const { events } = await readThreadEvents(userId, conversationId);
  let seq = events.length ? events[events.length - 1].seq : 0;
  const now = Date.now();
  const lines = drafts.map((draft, index) => {
    seq += 1;
    return JSON.stringify({ seq, ts: now + index, type: draft.type, payload: draft.payload });
  });
  // 追加写：并发下可能交错，行序仍 atomic（每行一次 write）
  await fs.appendFile(file, lines.join("\n") + "\n", "utf8");
  return seq;
}

/**
 * 读事件：逐行解析，坏行（通常是崩溃时写了一半的最后一行）跳过并计数，不抛。
 */
export async function readThreadEvents(
  userId: string,
  conversationId: string,
): Promise<ThreadReadResult> {
  let text: string;
  try {
    text = await fs.readFile(threadEventPath(userId, conversationId), "utf8");
  } catch {
    return { events: [], recovered: false, skippedLines: 0 };
  }
  const events: ThreadEvent[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ThreadEvent;
      if (
        typeof parsed?.seq === "number" &&
        typeof parsed?.type === "string" &&
        parsed?.payload &&
        typeof parsed.payload === "object"
      ) {
        events.push(parsed);
        continue;
      }
      skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  events.sort((a, b) => a.seq - b.seq);
  return { events, recovered: skippedLines > 0, skippedLines };
}

export interface RebuiltThread {
  messages: unknown[];
  usedTokens: number;
  interrupted: boolean;
  lastCode?: unknown;
  /** 重建用了多少条事件；0 表示没有事件流 */
  eventCount: number;
  /** 最后一次压缩发生在第几条事件（没有则 null） */
  lastCompactionAt: number | null;
}

/** 从事件重建线程状态：append 累加、replace 覆盖为完整列表、meta 更新可变字段 */
export function rebuildThread(events: ThreadEvent[]): RebuiltThread {
  let messages: unknown[] = [];
  let usedTokens = 0;
  let interrupted = false;
  let lastCode: unknown;
  let lastCompactionAt: number | null = null;
  for (const event of events) {
    if (event.type === "messages_append") {
      const items = event.payload.items;
      if (Array.isArray(items)) messages = messages.concat(items);
      continue;
    }
    if (event.type === "messages_replace") {
      const items = event.payload.items;
      if (Array.isArray(items)) messages = items.slice();
      lastCompactionAt = messages.length;
      continue;
    }
    if (event.type === "meta") {
      if (typeof event.payload.usedTokens === "number") usedTokens = event.payload.usedTokens;
      if (typeof event.payload.interrupted === "boolean") interrupted = event.payload.interrupted;
      if (event.payload.lastCode !== undefined) lastCode = event.payload.lastCode;
    }
  }
  return { messages, usedTokens, interrupted, lastCode, eventCount: events.length, lastCompactionAt };
}

/**
 * 由前后两份快照算出应追加的事件：
 *  - 消息只追加 → messages_append（含新增部分）
 *  - 消息变短/前段被改写（压缩）→ messages_replace（整份覆盖）
 *  - token/中断标记变化 → meta
 */
export function diffSnapshotEvents(
  previous: { messages?: unknown[]; usedTokens?: number; interrupted?: boolean } | null,
  next: { messages?: unknown[]; usedTokens?: number; interrupted?: boolean },
): Array<{ type: ThreadEventType; payload: Record<string, unknown> }> {
  const prevMessages = Array.isArray(previous?.messages) ? previous.messages : [];
  const nextMessages = Array.isArray(next.messages) ? next.messages : [];
  const drafts: Array<{ type: ThreadEventType; payload: Record<string, unknown> }> = [];

  const isPureAppend =
    nextMessages.length >= prevMessages.length &&
    prevMessages.every((item, index) => JSON.stringify(item) === JSON.stringify(nextMessages[index]));

  if (nextMessages.length > prevMessages.length && isPureAppend) {
    drafts.push({ type: "messages_append", payload: { items: nextMessages.slice(prevMessages.length) } });
  } else if (nextMessages.length !== prevMessages.length || !isPureAppend) {
    if (nextMessages.length > 0 || prevMessages.length > 0) {
      drafts.push({
        type: "messages_replace",
        payload: { items: nextMessages, reason: prevMessages.length > nextMessages.length ? "compaction" : "rewrite" },
      });
    }
  }

  const meta: Record<string, unknown> = {};
  if (typeof next.usedTokens === "number" && next.usedTokens !== previous?.usedTokens) {
    meta.usedTokens = next.usedTokens;
  }
  if (typeof next.interrupted === "boolean" && next.interrupted !== previous?.interrupted) {
    meta.interrupted = next.interrupted;
  }
  if (Object.keys(meta).length) drafts.push({ type: "meta", payload: meta });
  return drafts;
}
