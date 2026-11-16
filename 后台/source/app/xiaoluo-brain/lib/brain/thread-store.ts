/**
 * 线程库（第 7.5 项，学 Codex `thread-store` / `rollout` 的最小实用版）
 *
 * 小逻已有 append-only 事件流（`event-log.ts`）与重建，但缺三件"能治理"的能力：
 *   1. 列表：不读全文也能拿到每个会话的最后序号、体积、更新时间（反向扫描文件尾）；
 *   2. 检索：跨会话搜历史消息（Codex 的 reference_index / search）；
 *   3. 归档：老线程按"保留最近 N 条"裁剪，前缀搬进 .archive，当前文件原子重写
 *      （Codex 的 compression，这里用归档 + 原子重写，不引入 zstd 依赖）。
 *
 * 边界：检索是逐文件全文扫描（没有倒排索引）；单文件超过上限会被跳过并在结果里留痕。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { THREAD_EVENTS_ROOT, threadEventPath, type ThreadEvent } from "./event-log";

const TAIL_WINDOW_BYTES = 256 * 1024;
const SEARCH_MAX_FILE_BYTES = 32 * 1024 * 1024;
const SEARCH_MAX_HITS = 200;

export interface ThreadFileInfo {
  userId: string;
  conversationId: string;
  file: string;
  sizeBytes: number;
  updatedAt: number;
  /** 文件里最后一条事件的 seq（空文件 = 0） */
  lastSeq: number;
  /** 最后一条事件的时间戳（空文件 = 0） */
  lastTs: number;
  /** 尾部窗口里能数到的事件数（不代表总量） */
  tailEventCount: number;
}

/** 把 `user__conversation.jsonl` 还原成两个 id（文件名里的非法字符已被替换，只能当展示用） */
export function parseThreadFileName(fileName: string): { userId: string; conversationId: string } | null {
  if (!fileName.endsWith(".jsonl")) return null;
  const stem = fileName.slice(0, -".jsonl".length);
  const at = stem.indexOf("__");
  if (at < 0) return null;
  return { userId: stem.slice(0, at), conversationId: stem.slice(at + 2) };
}

function parseLines(text: string): { events: ThreadEvent[]; badLines: number } {
  const out: ThreadEvent[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ThreadEvent;
      if (typeof parsed?.seq === "number" && typeof parsed?.type === "string" && parsed?.payload && typeof parsed.payload === "object") {
        out.push(parsed);
      } else {
        badLines += 1;
      }
    } catch {
      // 崩溃留下的半行：计数跳过，由调用方决定是否归档（不因此判整份坏）
      badLines += 1;
    }
  }
  return { events: out, badLines };
}

/** 反向读文件尾：只读最后一段，避免为拿一个 seq 把整个长会话读进内存 */
export async function readTailEvents(userId: string, conversationId: string, count = 20): Promise<ThreadEvent[]> {
  const file = threadEventPath(userId, conversationId);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return [];
  }
  try {
    const stat = await handle.stat();
    let window = Math.min(stat.size, TAIL_WINDOW_BYTES);
    for (;;) {
      const start = Math.max(0, stat.size - window);
      const buf = Buffer.alloc(window);
      await handle.read(buf, 0, window, start);
      const text = buf.toString("utf8");
      // 窗口没到文件头时，首行可能是被截断的半条：丢掉第一行
      const usable = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      const parsedTail = parseLines(usable);
      const events = parsedTail.events;
      if (parsedTail.badLines > 0 && events.length === 0) {
        // 整段都是坏行：交给调用方按"没读到"处理，而不是回一堆空事件充数
        return [];
      }
      if (events.length >= count || start === 0 || window >= stat.size) {
        return events.slice(-count);
      }
      window = Math.min(stat.size, window * 4);
    }
  } finally {
    await handle.close();
  }
}

/** 列线程：目录扫描 + 尾部窗口，不读全文 */
export async function listThreads(): Promise<ThreadFileInfo[]> {
  let names: string[];
  try {
    names = await fs.readdir(THREAD_EVENTS_ROOT);
  } catch {
    return []; // 还没有任何会话事件：空列表而不是报错
  }
  const out: ThreadFileInfo[] = [];
  for (const name of names) {
    const ids = parseThreadFileName(name);
    if (!ids) continue;
    const file = path.join(THREAD_EVENTS_ROOT, name);
    try {
      const stat = await fs.stat(file);
      const tail = await readTailEvents(ids.userId, ids.conversationId, 200);
      out.push({
        userId: ids.userId,
        conversationId: ids.conversationId,
        file,
        sizeBytes: stat.size,
        updatedAt: stat.mtimeMs,
        lastSeq: tail.length ? tail[tail.length - 1].seq : 0,
        lastTs: tail.length ? tail[tail.length - 1].ts : 0,
        tailEventCount: tail.length,
      });
    } catch {
      // 读不了的单个文件跳过：权限/瞬时锁不该让整个列表失败
      continue;
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export interface ThreadSearchHit {
  userId: string;
  conversationId: string;
  seq: number;
  ts: number;
  type: string;
  /** 命中位置前后各 60 字的摘要 */
  snippet: string;
}

export interface ThreadSearchResult {
  hits: ThreadSearchHit[];
  scannedFiles: number;
  skippedFiles: Array<{ conversationId: string; reason: string }>;
  truncated: boolean;
}

/**
 * 跨会话检索：query 为空直接返回空（不把整库当"全部命中"）。
 * 命中文本来自 payload 的 JSON 序列化——消息、压缩原因、meta 都能搜到。
 */
export async function searchThreads(
  query: string,
  opts?: { conversationId?: string; limit?: number },
): Promise<ThreadSearchResult> {
  const needle = String(query ?? "").trim();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);
  const result: ThreadSearchResult = { hits: [], scannedFiles: 0, skippedFiles: [], truncated: false };
  if (!needle) return result;
  const lower = needle.toLowerCase();

  let names: string[];
  try {
    names = await fs.readdir(THREAD_EVENTS_ROOT);
  } catch {
    return result;
  }
  for (const name of names) {
    const ids = parseThreadFileName(name);
    if (!ids) continue;
    if (opts?.conversationId && ids.conversationId !== opts.conversationId) continue;
    const file = path.join(THREAD_EVENTS_ROOT, name);
    let text: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > SEARCH_MAX_FILE_BYTES) {
        result.skippedFiles.push({ conversationId: ids.conversationId, reason: "文件超过检索上限 " + SEARCH_MAX_FILE_BYTES + " 字节" });
        continue;
      }
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      result.skippedFiles.push({ conversationId: ids.conversationId, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.scannedFiles += 1;
    const parsedThread = parseLines(text);
    for (const event of parsedThread.events) {
      const hay = JSON.stringify(event.payload ?? {});
      const at = hay.toLowerCase().indexOf(lower);
      if (at < 0) continue;
      const from = Math.max(0, at - 60);
      result.hits.push({
        userId: ids.userId,
        conversationId: ids.conversationId,
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        snippet: (from > 0 ? "…" : "") + hay.slice(from, at + needle.length + 60) + (at + needle.length + 60 < hay.length ? "…" : ""),
      });
      if (result.hits.length >= limit) {
        result.truncated = true;
        return result;
      }
    }
  }
  result.hits.sort((a, b) => b.ts - a.ts);
  return result;
}

export interface CompactResult {
  before: number;
  kept: number;
  archived: number;
  archiveFile: string | null;
}

/**
 * 归档裁剪：保留最近 keepLast 条事件，其余搬进 `.archive/`。
 * 不重编 seq（回放和 lastSeq 都靠真实 seq）；重写走临时文件 + rename，崩了也不会留半份。
 */
export async function compactThreadEvents(userId: string, conversationId: string, keepLast: number): Promise<CompactResult> {
  const keep = Math.max(1, Math.floor(keepLast));
  const file = threadEventPath(userId, conversationId);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { before: 0, kept: 0, archived: 0, archiveFile: null };
  }
  const rawLines = text.split("\n").filter((line) => line.trim());
  const parsed = parseLines(text);
  const events = parsed.events;
  if (events.length <= keep) {
    return { before: events.length, kept: events.length, archived: 0, archiveFile: null };
  }
  const keepSeqs = new Set(events.slice(-keep).map((e) => e.seq));
  // 以 seq 为准挑出要保留/归档的原始行：坏行一律跟着归档，别让它在主文件里继续占位
  const keepLines: string[] = [];
  const archiveLines: string[] = [];
  for (const line of rawLines) {
    let seq = NaN;
    try {
      seq = Number((JSON.parse(line) as ThreadEvent).seq);
    } catch {
      // 坏行解析不了：直接归到归档侧，绝不让它留在主文件继续占位
      archiveLines.push(line);
      continue;
    }
    if (Number.isFinite(seq) && keepSeqs.has(seq)) keepLines.push(line);
    else archiveLines.push(line);
  }
  const archiveDir = path.join(THREAD_EVENTS_ROOT, ".archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const archiveName = path.basename(file).replace(/\.jsonl$/, "") + "." + Date.now() + ".jsonl";
  const archiveFile = path.join(archiveDir, archiveName);
  await fs.writeFile(archiveFile, archiveLines.join("\n") + (archiveLines.length ? "\n" : ""), "utf8");
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, keepLines.join("\n") + (keepLines.length ? "\n" : ""), "utf8");
  await fs.rename(tmp, file);
  return { before: events.length, kept: keepLines.length, archived: archiveLines.length, archiveFile };
}
