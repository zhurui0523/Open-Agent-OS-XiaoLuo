import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  intentConversations,
  intentPlans,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { mysqlNow } from "../../../../lib/mysql";

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      planId?: string;
      action?: "confirm" | "reject";
    };
    if (!payload.canvasId || !payload.planId || !payload.action) {
      return Response.json(
        { error: "canvasId、planId 和 action 必填" },
        { status: 400 },
      );
    }
    await requireCanvasAccess(user.id, payload.canvasId, "edit");
    const db = await getDb();
    const [ownedPlan] = await db
      .select({ id: intentPlans.id })
      .from(intentPlans)
      .innerJoin(
        intentConversations,
        eq(intentConversations.id, intentPlans.conversationId),
      )
      .where(
        and(
          eq(intentPlans.id, payload.planId),
          eq(intentConversations.canvasId, payload.canvasId),
          eq(intentConversations.createdBy, user.id),
        ),
      )
      .limit(1);
    if (!ownedPlan) {
      return Response.json({ error: "计划不存在" }, { status: 404 });
    }
    const now = mysqlNow();
    await db
      .update(intentPlans)
      .set({
        status: payload.action === "confirm" ? "confirmed" : "rejected",
        ...(payload.action === "confirm" ? { confirmedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(intentPlans.id, payload.planId));
    return Response.json({ ok: true, status: payload.action });
  } catch (error) {
    return jsonError(error, "更新 Intent 计划失败");
  }
}
