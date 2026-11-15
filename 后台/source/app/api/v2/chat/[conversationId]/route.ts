/**
 * Xiaoluo brain chat persistence (roadmap item 7): ChatStore over HTTP.
 * Contract with xiaoluo-brain/lib/brain/api.ts (HttpChatStore):
 *   GET /api/v2/chat/{conversationId}  -> ChatPersistence JSON, 404 = no snapshot
 *   PUT /api/v2/chat/{conversationId}  <- ChatPersistence JSON
 * 存储分两层（P1-3）：
 *   - 快照 JSON：读路径加速，整份覆盖写；
 *   - 事件流 JSONL：append-only 事实来源，快照缺失/半份时从这里重建线程。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  appendThreadEvents,
  diffSnapshotEvents,
  readThreadEvents,
  rebuildThread,
} from "../../../../xiaoluo-brain/lib/brain/event-log";
import { recordThreadSnapshot } from "../../../../lib/brain-state-store";

const DATA_DIR = path.join(process.cwd(), ".data", "brain-chat");
const MAX_BODY_BYTES = 512 * 1024;

function snapshotPath(user: { id: string }, conversationId: string) {
  const safe = encodeURIComponent(conversationId).replace(/[^A-Za-z0-9._-]/g, "_");
  const owner = user.id.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(DATA_DIR, owner + "__" + safe + ".json");
}

async function readSnapshot(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;
    if (!conversationId.trim()) {
      return Response.json({ error: "conversationId 必填" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:chat-store", max: 240, windowMs: 60_000 });
    const text = await readSnapshot(snapshotPath(user, conversationId));
    if (text) {
      try {
        JSON.parse(text);
        return new Response(text, { headers: { "content-type": "application/json" } });
      } catch {
        // 快照半份（上次写到一半崩了）：不直接交给前端，往下走事件流重建
      }
    }
    const { events, recovered } = await readThreadEvents(user.id, conversationId);
    if (!events.length) {
      return Response.json({ error: "无存档" }, { status: 404 });
    }
    const rebuilt = rebuildThread(events);
    const body = {
      version: 1,
      conversationId,
      messages: rebuilt.messages,
      usedTokens: rebuilt.usedTokens,
      interrupted: rebuilt.interrupted,
      ...(rebuilt.lastCode !== undefined ? { lastCode: rebuilt.lastCode } : {}),
      // 让前端知道这份是重建出来的，不是原始快照
      rebuiltFromEvents: true,
      recovered,
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  } catch (error) {
    return jsonError(error, "读取小逻对话存档失败");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await params;
    if (!conversationId.trim()) {
      return Response.json({ error: "conversationId 必填" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:chat-store", max: 240, windowMs: 60_000 });
    const text = await request.text();
    if (!text || text.length > MAX_BODY_BYTES) {
      return Response.json({ error: "存档为空或超过大小上限" }, { status: 413 });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "存档必须是合法 JSON" }, { status: 400 });
    }
    const file = snapshotPath(user, conversationId);
    await fs.mkdir(DATA_DIR, { recursive: true });
    // 先追加事件再写快照：真崩在中间时事件流是完整的，读路径能重建；反过来会丢尾部
    const previousText = await readSnapshot(file);
    let previous: Record<string, unknown> | null = null;
    if (previousText) {
      try {
        previous = JSON.parse(previousText) as Record<string, unknown>;
      } catch {
        previous = null;
      }
    }
    const drafts = diffSnapshotEvents(
      previous as { messages?: unknown[]; usedTokens?: number; interrupted?: boolean } | null,
      parsed as { messages?: unknown[]; usedTokens?: number; interrupted?: boolean },
    );
    if (drafts.length) await appendThreadEvents(user.id, conversationId, drafts);
    await fs.writeFile(file, text, "utf8");
    // 派生状态记账（P1-3）：事件流是事实来源，这里补可查询的消息数/token/工具账本；
    // 记账失败不能影响存档成功——存档才是用户的资产
    let state: { backend: string; toolCalls: number } | null = null;
    try {
      state = await recordThreadSnapshot({
        conversationId,
        userId: user.id,
        messages: (parsed.messages ?? []) as Array<{ role?: string; toolName?: string; content?: string; toolCalls?: Array<{ name?: string }> }>,
        usedTokens: typeof parsed.usedTokens === "number" ? parsed.usedTokens : 0,
        interrupted: parsed.interrupted === true,
      });
    } catch {
      state = null;
    }
    return Response.json({ ok: true, events: drafts.length, state });
  } catch (error) {
    return jsonError(error, "保存小逻对话存档失败");
  }
}