import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { modelConnections, registryEvents } from "../../../../../db/schema";
import { probeModelAdapter } from "../../../../lib/model-adapters";
import { serializeModel } from "../../../../lib/registry-serialization";
import type { ModelProtocol, NodeKind } from "../../../../types";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { id?: string };
    if (!payload.id) {
      return Response.json({ error: "id 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [row] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, payload.id))
      .limit(1);
    if (!row) return Response.json({ error: "模型连接不存在" }, { status: 404 });

    let modalities: NodeKind[] = [];
    try {
      modalities = JSON.parse(row.modalitiesJson) as NodeKind[];
    } catch {
      modalities = [];
    }
    const credential = row.credentialRef
      ? process.env[row.credentialRef]
      : undefined;
    const result = await probeModelAdapter({
      protocol: row.protocol as ModelProtocol,
      baseUrl: row.baseUrl,
      modelName: row.modelName,
      modalities,
      credential,
    });
    const checkedAt = new Date().toISOString();
    const [updated] = await db
      .update(modelConnections)
      .set({
        state: result.state,
        latencyMs: result.latencyMs,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      })
      .where(eq(modelConnections.id, row.id))
      .returning();
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      eventType: result.ok ? "model.healthy" : "model.attention",
      entityId: row.id,
      detailJson: JSON.stringify({ message: result.message }),
    });
    return Response.json({ model: serializeModel(updated), probe: result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "连接测试失败" },
      { status: 500 },
    );
  }
}
