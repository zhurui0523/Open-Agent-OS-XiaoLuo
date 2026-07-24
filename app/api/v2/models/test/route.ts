import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { modelConnections, registryEvents } from "../../../../../db/schema";
import { probeModelAdapter } from "../../../../lib/model-adapters";
import { serializeModel } from "../../../../lib/registry-serialization";
import type { ModelProtocol, NodeKind } from "../../../../types";
import { mysqlNow } from "../../../../lib/mysql";
import { requireUser } from "../../../../lib/auth";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import { resolveSecret } from "../../../../lib/secret-vault";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    if (!payload.id) {
      return Response.json({ error: "id 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [row] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) return Response.json({ error: "模型连接不存在" }, { status: 404 });

    let modalities: NodeKind[] = [];
    try {
      modalities = JSON.parse(row.modalitiesJson) as NodeKind[];
    } catch {
      modalities = [];
    }
    const credential = row.secretRefId
      ? await resolveSecret(row.secretRefId, workspaceId)
      : row.credentialRef
        ? process.env[row.credentialRef]
        : undefined;
    const result = await probeModelAdapter({
      protocol: row.protocol as ModelProtocol,
      baseUrl: row.baseUrl,
      modelName: row.modelName,
      modalities,
      credential,
    });
    const checkedAt = mysqlNow();
    await db
      .update(modelConnections)
      .set({
        state: result.state,
        latencyMs: result.latencyMs,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      })
      .where(eq(modelConnections.id, row.id));
    const [updated] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, row.id))
      .limit(1);
    if (!updated) {
      return Response.json({ error: "模型连接不存在" }, { status: 404 });
    }
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType: result.ok ? "model.healthy" : "model.attention",
      entityId: row.id,
      detailJson: JSON.stringify({ message: result.message }),
    });
    return Response.json({ model: serializeModel(updated), probe: result });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "连接测试失败" },
      { status: 500 },
    );
  }
}
