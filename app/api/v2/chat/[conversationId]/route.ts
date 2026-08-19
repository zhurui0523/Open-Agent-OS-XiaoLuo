/**
 * Xiaoluo brain chat persistence (roadmap item 7): ChatStore over HTTP.
 * Contract with xiaoluo-brain/lib/brain/api.ts (HttpChatStore):
 *   GET /api/v2/chat/{conversationId}  -> ChatPersistence JSON, 404 = no snapshot
 *   PUT /api/v2/chat/{conversationId}  <- ChatPersistence JSON
 * Current stage uses file storage under .data/brain-chat/ (temporary service
 * on 127.0.0.1:3001); swap for a DB table when persistence goes production.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";

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
    if (!text) {
      return Response.json({ error: "无存档" }, { status: 404 });
    }
    return new Response(text, { headers: { "content-type": "application/json" } });
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
    try {
      JSON.parse(text);
    } catch {
      return Response.json({ error: "存档必须是合法 JSON" }, { status: 400 });
    }
    const file = snapshotPath(user, conversationId);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "保存小逻对话存档失败");
  }
}