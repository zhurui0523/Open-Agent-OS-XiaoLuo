import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { canvasShareLinks } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { mysqlNow } from "../../../../lib/mysql";
import { readCanvasGraph } from "../../../../lib/workspace-store";
import { sanitizeWorkflowGraph } from "../../../../lib/workflow-marketplace";

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token")?.trim();
    const db = await getDb();
    if (token) {
      const [share] = await db
        .select()
        .from(canvasShareLinks)
        .where(
          and(
            eq(canvasShareLinks.tokenHash, await tokenHash(token)),
            isNull(canvasShareLinks.revokedAt),
          ),
        )
        .limit(1);
      if (
        !share ||
        (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())
      ) {
        return Response.json(
          { error: "分享链接不存在或已过期" },
          { status: 404 },
        );
      }
      return Response.json({
        share: {
          id: share.id,
          mode: share.mode,
          graph: JSON.parse(share.graphJson),
          expiresAt: share.expiresAt,
        },
      });
    }
    const user = await requireUser(request);
    const canvasId = url.searchParams.get("canvasId")?.trim();
    if (!canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, canvasId, "manage");
    const shares = await db
      .select({
        id: canvasShareLinks.id,
        mode: canvasShareLinks.mode,
        expiresAt: canvasShareLinks.expiresAt,
        revokedAt: canvasShareLinks.revokedAt,
        createdAt: canvasShareLinks.createdAt,
      })
      .from(canvasShareLinks)
      .where(eq(canvasShareLinks.canvasId, canvasId))
      .orderBy(desc(canvasShareLinks.createdAt));
    return Response.json({ shares });
  } catch (error) {
    return jsonError(error, "读取画布分享失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      mode?: "read_only" | "workflow";
      expiresInDays?: number;
    };
    if (
      !payload.canvasId ||
      !["read_only", "workflow"].includes(payload.mode ?? "")
    ) {
      return Response.json({ error: "分享参数无效" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, payload.canvasId, "manage");
    const graph = await readCanvasGraph(payload.canvasId);
    if (!graph) return Response.json({ error: "画布不存在" }, { status: 404 });
    const sharedGraph =
      payload.mode === "workflow"
        ? sanitizeWorkflowGraph(graph).graph
        : graph;
    const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const id = `share_${crypto.randomUUID()}`;
    const days = Math.min(365, Math.max(1, payload.expiresInDays ?? 30));
    const expiresAt = new Date(Date.now() + days * 86_400_000)
      .toISOString()
      .slice(0, 23)
      .replace("T", " ");
    const db = await getDb();
    await db.insert(canvasShareLinks).values({
      id,
      canvasId: payload.canvasId,
      tokenHash: await tokenHash(token),
      mode: payload.mode as "read_only" | "workflow",
      graphJson: JSON.stringify(sharedGraph),
      createdBy: user.id,
      expiresAt,
      createdAt: mysqlNow(),
    });
    const origin = new URL(request.url).origin;
    return Response.json(
      {
        share: {
          id,
          mode: payload.mode,
          url: `${origin}/share/${token}`,
          expiresAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "创建画布分享失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id")?.trim();
    const canvasId = url.searchParams.get("canvasId")?.trim();
    if (!id || !canvasId) {
      return Response.json({ error: "分享参数无效" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, canvasId, "manage");
    const db = await getDb();
    await db
      .update(canvasShareLinks)
      .set({ revokedAt: mysqlNow() })
      .where(
        and(
          eq(canvasShareLinks.id, id),
          eq(canvasShareLinks.canvasId, canvasId),
        ),
      );
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "撤销画布分享失败");
  }
}
