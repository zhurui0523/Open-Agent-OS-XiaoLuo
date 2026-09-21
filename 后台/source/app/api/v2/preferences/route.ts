import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userPreferences } from "../../../../db/schema";
import type { UserPreferences } from "../../../types";
import { jsonError, requireUser } from "../../../lib/auth";
import { mysqlNow } from "../../../lib/mysql";

const defaults: UserPreferences = {
  canvasBackground: "day",
  gesturePreset: "figma",
  invertZoom: false,
  zoomSensitivity: "normal",
  keyboardShortcuts: true,
};

function parsePreferences(value: string | null | undefined): UserPreferences {
  let input: Record<string, unknown> = {};
  try {
    input = value ? (JSON.parse(value) as Record<string, unknown>) : {};
  } catch {
    input = {};
  }
  // 合并式：未知/扩展字段（如 lastCanvasId）透传保留，已知字段做约束
  const merged = { ...defaults, ...input } as Record<string, unknown>;
  const out: UserPreferences = {
    canvasBackground: "day", // 界面风格功能已移除：仅保留白天
    gesturePreset:
      merged.gesturePreset === "trackpad" || merged.gesturePreset === "zoom-wheel"
        ? (merged.gesturePreset as UserPreferences["gesturePreset"])
        : "figma",
    invertZoom: merged.invertZoom === true,
    zoomSensitivity:
      merged.zoomSensitivity === "slow" || merged.zoomSensitivity === "fast"
        ? (merged.zoomSensitivity as UserPreferences["zoomSensitivity"])
        : "normal",
    keyboardShortcuts: merged.keyboardShortcuts !== false,
  };
  if (typeof merged.lastCanvasId === "string" && merged.lastCanvasId.trim()) {
    out.lastCanvasId = merged.lastCanvasId.trim().slice(0, 100);
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const db = await getDb();
    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1);
    return Response.json({
      preferences: row ? parsePreferences(row.settingsJson) : defaults,
      revision: row?.revision ?? 0,
    });
  } catch (error) {
    return jsonError(error, "读取用户设置失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      preferences?: Partial<UserPreferences>;
    };
    // PATCH 与既有设置合并：只发单个字段（如 lastCanvasId）不覆盖其余偏好
    const prefDb = await getDb();
    const [existing] = await prefDb
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1);
    let oldRaw: Record<string, unknown> = {};
    try {
      oldRaw = existing?.settingsJson ? (JSON.parse(existing.settingsJson) as Record<string, unknown>) : {};
    } catch {
      oldRaw = {};
    }
    const next = parsePreferences(
      JSON.stringify({ ...oldRaw, ...(payload.preferences ?? {}) }),
    );
    const db = await getDb();
    const now = mysqlNow();
    await db
      .insert(userPreferences)
      .values({
        userId: user.id,
        settingsJson: JSON.stringify(next),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          settingsJson: JSON.stringify(next),
          revision: sql`${userPreferences.revision} + 1`,
          updatedAt: now,
        },
      });
    const [saved] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, user.id))
      .limit(1);
    return Response.json({
      preferences: saved ? parsePreferences(saved.settingsJson) : next,
      revision: saved?.revision ?? 1,
    });
  } catch (error) {
    return jsonError(error, "保存用户设置失败");
  }
}
