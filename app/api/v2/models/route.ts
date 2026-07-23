import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { modelConnections, registryEvents } from "../../../../db/schema";
import type { ModelConnectionDraft, ModelProtocol, NodeKind } from "../../../types";
import { validateExternalEndpoint } from "../../../lib/model-adapters";
import { serializeModel } from "../../../lib/registry-serialization";

const protocols = new Set<ModelProtocol>([
  "openai-compatible",
  "anthropic-compatible",
  "generic-rest",
]);
const modalities = new Set<NodeKind>(["text", "image", "video"]);

function validateDraft(value: unknown): ModelConnectionDraft {
  if (!value || typeof value !== "object") throw new Error("连接配置必须是对象");
  const draft = value as Partial<ModelConnectionDraft>;
  const name = draft.name?.trim() ?? "";
  const baseUrl = draft.baseUrl?.trim() ?? "";
  const modelName = draft.modelName?.trim() ?? "";
  if (!name || !baseUrl || !modelName) throw new Error("名称、端点和模型 ID 必填");
  if (!draft.protocol || !protocols.has(draft.protocol)) {
    throw new Error("不支持的模型协议");
  }
  const selected = Array.isArray(draft.modalities)
    ? draft.modalities.filter((item): item is NodeKind => modalities.has(item))
    : [];
  if (!selected.length) throw new Error("至少选择一种模态");
  validateExternalEndpoint(baseUrl);
  const credentialRef = draft.credentialRef?.trim();
  if (credentialRef && !/^[A-Z][A-Z0-9_]{2,63}$/.test(credentialRef)) {
    throw new Error("凭据引用必须是大写环境变量名，例如 OPENAI_API_KEY");
  }
  return {
    name,
    protocol: draft.protocol,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    modelName,
    modalities: [...new Set(selected)],
    ...(credentialRef ? { credentialRef } : {}),
  };
}

function errorResponse(error: unknown, status = 400) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Model operation failed" },
    { status },
  );
}

export async function POST(request: Request) {
  try {
    const draft = validateDraft(await request.json());
    const db = await getDb();
    const now = new Date().toISOString();
    const id = `model_${crypto.randomUUID()}`;
    const [saved] = await db
      .insert(modelConnections)
      .values({
        id,
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        modelName: draft.modelName,
        modalitiesJson: JSON.stringify(draft.modalities),
        credentialRef: draft.credentialRef ?? null,
        state: "attention",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      eventType: "model.created",
      entityId: id,
      detailJson: JSON.stringify({ protocol: draft.protocol }),
    });
    return Response.json({ model: serializeModel(saved) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as { id?: string; enabled?: boolean };
    if (!payload.id || typeof payload.enabled !== "boolean") {
      return errorResponse(new Error("id 和 enabled 必填"));
    }
    const db = await getDb();
    const [updated] = await db
      .update(modelConnections)
      .set({ enabled: payload.enabled, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(modelConnections.id, payload.id))
      .returning();
    if (!updated) return errorResponse(new Error("模型连接不存在"), 404);
    return Response.json({ model: serializeModel(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return errorResponse(new Error("id 必填"));
    const db = await getDb();
    const deleted = await db
      .delete(modelConnections)
      .where(eq(modelConnections.id, id))
      .returning({ id: modelConnections.id });
    if (!deleted.length) return errorResponse(new Error("模型连接不存在"), 404);
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      eventType: "model.deleted",
      entityId: id,
      detailJson: "{}",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
