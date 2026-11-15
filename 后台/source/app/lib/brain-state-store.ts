/**
 * 会话状态库（P1-3 第二步）。
 *
 * 事件流（event-log.ts）是**事实来源**，负责崩溃重建；这里存的是**可查询的派生状态**：
 * 每个会话的消息数、token 用量、工具调用账本——这些以前只在快照 JSON 里，想统计只能全量扫文件。
 *
 * 实现选择：优先 `node:sqlite`（Node 22 内置，无原生编译依赖）；不可用时退回 NDJSON 追加，
 * 保证在没有 sqlite 的环境（旧 Node / 打包裁剪版）里仍然能记账，而不是直接崩。
 * 两套实现共用同一份对外函数，调用方不需要知道底层是哪套。
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface SnapshotFacts {
  conversationId: string;
  userId: string;
  messages: Array<{
    role?: string;
    toolName?: string;
    content?: string;
    toolCalls?: Array<{ name?: string; arguments?: Record<string, unknown> }>;
  }>;
  usedTokens?: number;
  interrupted?: boolean;
}

/** 文件变更一条（从工具调用参数派生：写/改/移动/删除） */
export interface FileChangeRow {
  path: string;
  op: "write" | "move" | "delete";
  from?: string;
}

export interface ThreadStateRow {
  conversationId: string;
  messageCount: number;
  usedTokens: number;
  interrupted: boolean;
  toolCalls: number;
  fileChanges: number;
  updatedAt: number;
  /** 记账后端：sqlite / ndjson（排查时能知道这份数据从哪来） */
  backend: "sqlite" | "ndjson";
}

const STATE_DIR = path.join(process.cwd(), ".data", "brain-state");
const DB_FILE = path.join(STATE_DIR, "brain-state.db");

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function openDb(): Promise<{ db: any; backend: "sqlite" | "ndjson" }> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  try {
    const sqlite = await import("node:sqlite");
    const db = new (sqlite as any).DatabaseSync(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        interrupted INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        file_changes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS tool_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        result_chars INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        path TEXT NOT NULL,
        op TEXT NOT NULL,
        from_path TEXT,
        at INTEGER NOT NULL
      );
    `);
    return { db, backend: "sqlite" };
  } catch {
    return { db: null, backend: "ndjson" };
  }
}

/** 从快照消息里抽事实：工具账本按 tool 轮记，文件变更不在消息里，故这里只记工具 */
export function extractSnapshotFacts(facts: SnapshotFacts): {
  messageCount: number;
  usedTokens: number;
  toolCalls: Array<{ tool: string; resultChars: number }>;
} {
  const toolCalls: Array<{ tool: string; resultChars: number }> = [];
  for (const message of facts.messages ?? []) {
    if (message?.role === "tool" && message.toolName) {
      toolCalls.push({ tool: message.toolName, resultChars: String(message.content ?? "").length });
    } else if (message?.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (call?.name) toolCalls.push({ tool: call.name, resultChars: 0 });
      }
    }
  }
  return {
    messageCount: (facts.messages ?? []).length,
    usedTokens: Math.max(0, Math.trunc(facts.usedTokens ?? 0)),
    toolCalls,
  };
}

/**
 * 从工具调用参数派生文件变更（P1-3 收尾）。
 * 好处：不改客户端协议——快照里的 assistant.toolCalls 本来就带 arguments；
 * 口径与工具语义一一对应，move 记两条（源删除 + 目标写入）会误导，所以 move 只记目标并带 from。
 */
export function extractFileChanges(facts: SnapshotFacts): FileChangeRow[] {
  const rows: FileChangeRow[] = [];
  const seen = new Set<string>();
  const push = (row: FileChangeRow) => {
    const key = row.op + "|" + (row.from ?? "") + "|" + row.path;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  for (const message of facts.messages ?? []) {
    if (message?.role !== "assistant" || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      const name = call?.name;
      const args = call?.arguments ?? {};
      const pathArg = typeof args.path === "string" ? args.path.trim() : "";
      if ((name === "write_file" || name === "edit_file") && pathArg) {
        push({ path: pathArg, op: "write" });
      } else if (name === "move_file") {
        const from = typeof args.from === "string" ? args.from.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (to) push({ path: to, op: "move", ...(from ? { from } : {}) });
      } else if (name === "delete_file" && pathArg) {
        push({ path: pathArg, op: "delete" });
      }
    }
  }
  return rows;
}

/** 记录一次快照落盘产生的派生状态（幂等：同一会话覆盖写，账本按增量追加） */
export async function recordThreadSnapshot(
  facts: SnapshotFacts,
): Promise<{ backend: "sqlite" | "ndjson"; toolCalls: number; fileChanges: number }> {
  const extracted = extractSnapshotFacts(facts);
  const changes = extractFileChanges(facts);
  const now = Date.now();
  const { db, backend } = await openDb();

  if (backend === "sqlite" && db) {
    try {
      const existing = db
        .prepare("SELECT tool_calls FROM threads WHERE conversation_id = ? AND user_id = ?")
        .get(facts.conversationId, facts.userId) as { tool_calls?: number } | undefined;
      const previous = Number(existing?.tool_calls ?? 0);
      // 快照是全量的：用「本次抽取到的调用数」覆盖，而不是累加（覆盖写就重复记了）
      db.prepare(
        `INSERT INTO threads (conversation_id, user_id, message_count, used_tokens, interrupted, tool_calls, file_changes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, user_id) DO UPDATE SET
           message_count = excluded.message_count,
           used_tokens = excluded.used_tokens,
           interrupted = excluded.interrupted,
           tool_calls = excluded.tool_calls,
           file_changes = excluded.file_changes,
           updated_at = excluded.updated_at`,
      ).run(
        facts.conversationId,
        facts.userId,
        extracted.messageCount,
        extracted.usedTokens,
        facts.interrupted ? 1 : 0,
        extracted.toolCalls.length,
        changes.length,
        now,
      );
      if (extracted.toolCalls.length > previous) {
        const insert = db.prepare(
          "INSERT INTO tool_ledger (conversation_id, user_id, tool, result_chars, at) VALUES (?, ?, ?, ?, ?)",
        );
        for (const call of extracted.toolCalls.slice(previous)) {
          insert.run(facts.conversationId, facts.userId, call.tool, call.resultChars, now);
        }
      }
      // 变更表整份替换：快照即全量事实，反复 PUT 不该把同一个文件记成十条
      db.prepare("DELETE FROM file_changes WHERE conversation_id = ? AND user_id = ?").run(
        facts.conversationId,
        facts.userId,
      );
      const insertChange = db.prepare(
        "INSERT INTO file_changes (conversation_id, user_id, path, op, from_path, at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const change of changes) {
        insertChange.run(facts.conversationId, facts.userId, change.path, change.op, change.from ?? null, now);
      }
      return { backend, toolCalls: extracted.toolCalls.length, fileChanges: changes.length };
    } finally {
      db.close?.();
    }
  }

  // NDJSON 兜底：一行一份派生状态，读时取最后一行
  const file = path.join(STATE_DIR, safeName(facts.userId) + "__" + safeName(facts.conversationId) + ".jsonl");
  await fs.appendFile(
    file,
    JSON.stringify({
      conversationId: facts.conversationId,
      userId: facts.userId,
      messageCount: extracted.messageCount,
      usedTokens: extracted.usedTokens,
      interrupted: Boolean(facts.interrupted),
      toolCalls: extracted.toolCalls.length,
      fileChanges: changes.length,
      changes,
      updatedAt: now,
    }) + "\n",
    "utf8",
  );
  return { backend, toolCalls: extracted.toolCalls.length, fileChanges: changes.length };
}

/** 查询某用户最近活跃的会话状态（调试/统计用；不带任何消息正文） */
export async function listThreadState(userId: string, limit = 20): Promise<ThreadStateRow[]> {
  const { db, backend } = await openDb();
  if (backend === "sqlite" && db) {
    try {
      const rows = db
        .prepare(
          "SELECT conversation_id, message_count, used_tokens, interrupted, tool_calls, file_changes, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(userId, limit) as Array<Record<string, number | string>>;
      return rows.map((row) => ({
        conversationId: String(row.conversation_id),
        messageCount: Number(row.message_count),
        usedTokens: Number(row.used_tokens),
        interrupted: Number(row.interrupted) === 1,
        toolCalls: Number(row.tool_calls),
        fileChanges: Number(row.file_changes ?? 0),
        updatedAt: Number(row.updated_at),
        backend,
      }));
    } finally {
      db.close?.();
    }
  }
  // NDJSON：逐个文件取最后一行
  const names = await fs.readdir(STATE_DIR).catch(() => [] as string[]);
  const prefix = safeName(userId) + "__";
  const rows: ThreadStateRow[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
    const lines = (await fs.readFile(path.join(STATE_DIR, name), "utf8").catch(() => "")).trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) continue;
    try {
      const parsed = JSON.parse(last) as Record<string, unknown>;
      rows.push({
        conversationId: String(parsed.conversationId ?? ""),
        messageCount: Number(parsed.messageCount ?? 0),
        usedTokens: Number(parsed.usedTokens ?? 0),
        interrupted: Boolean(parsed.interrupted),
        toolCalls: Number(parsed.toolCalls ?? 0),
        fileChanges: Number(parsed.fileChanges ?? 0),
        updatedAt: Number(parsed.updatedAt ?? 0),
        backend,
      });
    } catch {
      // 坏行跳过：状态库不该因为一行损坏整份读不出
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 查询单个会话的文件变更清单（谁改了什么，排序按变更顺序） */
export async function listFileChanges(userId: string, conversationId: string, limit = 50): Promise<FileChangeRow[]> {
  const { db, backend } = await openDb();
  if (backend === "sqlite" && db) {
    try {
      const rows = db
        .prepare(
          "SELECT path, op, from_path FROM file_changes WHERE user_id = ? AND conversation_id = ? ORDER BY id ASC LIMIT ?",
        )
        .all(userId, conversationId, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        path: String(row.path),
        op: String(row.op) as FileChangeRow["op"],
        ...(row.from_path ? { from: String(row.from_path) } : {}),
      }));
    } finally {
      db.close?.();
    }
  }
  const file = path.join(STATE_DIR, safeName(userId) + "__" + safeName(conversationId) + ".jsonl");
  const lines = (await fs.readFile(file, "utf8").catch(() => "")).trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return [];
  try {
    const parsed = JSON.parse(last) as { changes?: FileChangeRow[] };
    return (parsed.changes ?? []).slice(0, limit);
  } catch {
    return [];
  }
}
