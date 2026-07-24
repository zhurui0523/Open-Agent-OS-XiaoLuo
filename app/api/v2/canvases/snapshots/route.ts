import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { canvasSnapshots } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { mysqlNow } from "../../../../lib/mysql";
import {
  readCanvasGraph,
  replaceCanvasGraph,
} from "../../../../lib/workspace-store";
import type { CanvasEdge, CanvasNode } from "../../../../types";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const canvasId = new URL(request.url).searchParams.get("canvasId")?.trim();
    if (!canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, canvasId, "view");
    const db = await getDb();
    const snapshots = await db
      .select({
        id: canvasSnapshots.id,
        revision: canvasSnapshots.revision,
        label: canvasSnapshots.label,
        createdAt: canvasSnapshots.createdAt,
      })
      .from(canvasSnapshots)
      .where(eq(canvasSnapshots.canvasId, canvasId))
      .orderBy(desc(canvasSnapshots.createdAt));
    return Response.json({ snapshots });
  } catch (error) {
    return jsonError(error, "读取画布快照失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      label?: string;
    };
    if (!payload.canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, payload.canvasId, "edit");
    const graph = await readCanvasGraph(payload.canvasId);
    if (!graph) return Response.json({ error: "画布不存在" }, { status: 404 });
    const db = await getDb();
    const id = `snapshot_${crypto.randomUUID()}`;
    await db.insert(canvasSnapshots).values({
      id,
      canvasId: payload.canvasId,
      revision: graph.revision,
      label:
        payload.label?.trim().slice(0, 180) ||
        `版本 ${graph.revision}`,
      graphJson: JSON.stringify(graph),
      createdBy: user.id,
      createdAt: mysqlNow(),
    });
    return Response.json(
      { snapshot: { id, revision: graph.revision } },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "创建画布快照失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      snapshotId?: string;
    };
    if (!payload.canvasId || !payload.snapshotId) {
      return Response.json(
        { error: "canvasId 和 snapshotId 必填" },
        { status: 400 },
      );
    }
    await requireCanvasAccess(user.id, payload.canvasId, "edit");
    const db = await getDb();
    const [snapshot] = await db
      .select()
      .from(canvasSnapshots)
      .where(
        and(
          eq(canvasSnapshots.id, payload.snapshotId),
          eq(canvasSnapshots.canvasId, payload.canvasId),
        ),
      )
      .limit(1);
    if (!snapshot) {
      return Response.json({ error: "快照不存在" }, { status: 404 });
    }
    const current = await readCanvasGraph(payload.canvasId);
    if (!current) return Response.json({ error: "画布不存在" }, { status: 404 });
    const graph = JSON.parse(snapshot.graphJson) as {
      nodes: CanvasNode[];
      edges: CanvasEdge[];
      arrangeMode: "free" | "time" | "type";
      viewport: { x: number; y: number; zoom: number };
    };
    const revision = await replaceCanvasGraph({
      canvasId: payload.canvasId,
      revision: current.revision,
      nodes: graph.nodes,
      edges: graph.edges,
      arrangeMode: graph.arrangeMode,
      viewport: graph.viewport,
    });
    if (revision === null) {
      return Response.json(
        { error: "画布已更新，请刷新后重试", conflict: true },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, revision });
  } catch (error) {
    return jsonError(error, "恢复画布快照失败");
  }
}
