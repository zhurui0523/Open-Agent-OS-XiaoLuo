/**
 * Xiaoluo brain memory persistence (B5): server mirror of long-term memory.
 * Contract with xiaoluo-brain/lib/brain/api.ts (HttpMemoryMirror):
 *   GET /api/v2/memory   -> MemoryEntry[] JSON (no snapshot = 404)
 *   PUT /api/v2/memory   <- MemoryEntry[] JSON (full replace, client owns merge)
 * Storage mirrors the chat store pattern: .data/brain-memory/{userId}.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { jsonError, requireUser } from "../../../lib/auth";
import { enforceRateLimit } from "../../../lib/rate-limit";

const DATA_DIR = path.join(process.cwd(), ".data", "brain-memory");
const MAX_BODY_BYTES = 256 * 1024;

function memoryPath(user: { id: string }) {
  const owner = user.id.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(DATA_DIR, owner + ".json");
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:memory-store", max: 240, windowMs: 60_000 });
    let text: string | null = null;
    try {
      text = await fs.readFile(memoryPath(user), "utf8");
    } catch {
      text = null;
    }
    if (!text) {
      return Response.json({ error: "无记忆存档" }, { status: 404 });
    }
    return new Response(text, { headers: { "content-type": "application/json" } });
  } catch (error) {
    return jsonError(error, "读取小逻记忆存档失败");
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:memory-store", max: 240, windowMs: 60_000 });
    const text = await request.text();
    if (!text || text.length > MAX_BODY_BYTES) {
      return Response.json({ error: "记忆存档为空或超过大小上限" }, { status: 413 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Response.json({ error: "记忆存档必须是合法 JSON" }, { status: 400 });
    }
    if (!Array.isArray(parsed)) {
      return Response.json({ error: "记忆存档必须是条目数组" }, { status: 400 });
    }
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(memoryPath(user), text, "utf8");
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "保存小逻记忆存档失败");
  }
}