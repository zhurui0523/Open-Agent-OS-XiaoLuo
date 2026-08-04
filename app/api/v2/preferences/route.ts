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
  let input: Partial<UserPreferences> = {};
  try {
    input = value ? (JSON.parse(value) as Partial<UserPreferences>) : {};
  } catch {
    input = {};
  }
  return {
    canvasBackground: input.canvasBackground === "night" ? "night" : "day",
    gesturePreset:
      input.gesturePreset === "trackpad" ||
      input.gesturePreset === "zoom-wheel"
        ? input.gesturePreset
        : "figma",
    invertZoom: input.invertZoom === true,
    zoomSensitivity:
      input.zoomSensitivity === "slow" || input.zoomSensitivity === "fast"
        ? input.zoomSensitivity
        : "normal",
    keyboardShortcuts: input.keyboardShortcuts !== false,
  };
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
    const next = parsePreferences(JSON.stringify(payload.preferences ?? {}));
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
