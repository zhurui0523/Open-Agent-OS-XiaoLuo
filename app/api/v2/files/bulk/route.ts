import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { assets } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlNow } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      ids?: string[];
      action?: "trash" | "restore" | "move" | "favorite" | "tags";
      folderId?: string | null;
      favorite?: boolean;
      tags?: string[];
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      payload,
    );
    const ids = Array.isArray(payload.ids)
      ? [...new Set(payload.ids.map(String))].slice(0, 500)
      : [];
    if (!ids.length || !payload.action) {
      return Response.json({ error: "批量操作参数无效" }, { status: 400 });
    }
    const db = await getDb();
    const now = mysqlNow();
    const tags = Array.isArray(payload.tags)
      ? [...new Set(payload.tags.map((tag) => tag.trim()).filter(Boolean))].slice(
          0,
          30,
        )
      : [];
    await db
      .update(assets)
      .set({
        ...(payload.action === "trash" ? { trashedAt: now } : {}),
        ...(payload.action === "restore" ? { trashedAt: null } : {}),
        ...(payload.action === "move"
          ? { folderId: payload.folderId || null }
          : {}),
        ...(payload.action === "favorite"
          ? { favorite: Boolean(payload.favorite) }
          : {}),
        ...(payload.action === "tags"
          ? {
              tagsJson: JSON.stringify(tags),
              searchText: sql`concat(${assets.searchText}, '\n', ${tags.join(" ")})`,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(assets.workspaceId, workspaceId),
          inArray(assets.id, ids),
        ),
      );
    return Response.json({ ok: true, affected: ids.length });
  } catch (error) {
    return jsonError(error, "批量资产操作失败");
  }
}
