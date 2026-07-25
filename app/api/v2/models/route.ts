import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { modelConnections, registryEvents } from "../../../../db/schema";
import type {
  ModelConnectionDraft,
  ModelProtocol,
  NodeKind,
} from "../../../types";
import { validateExternalEndpoint } from "../../../lib/model-adapters";
import { serializeModel } from "../../../lib/registry-serialization";
import { mysqlNow } from "../../../lib/mysql";
import { requireUser } from "../../../lib/auth";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import { saveSecret } from "../../../lib/secret-vault";

const protocols = new Set<ModelProtocol>([
  "openai-compatible",
  "anthropic-compatible",
  "gemini",
  "ark",
  "async-video",
  "generic-rest",
]);
const modalities = new Set<NodeKind>(["text", "image", "video"]);

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

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
    priority: boundedInteger(draft.priority, 100, 1, 1000),
    fallbackModelId: draft.fallbackModelId?.trim() || null,
    maxConcurrency: boundedInteger(draft.maxConcurrency, 2, 1, 20),
    retryLimit: boundedInteger(draft.retryLimit, 3, 1, 5),
    circuitFailureThreshold: boundedInteger(
      draft.circuitFailureThreshold,
      5,
      2,
      20,
    ),
    circuitCooldownSeconds: boundedInteger(
      draft.circuitCooldownSeconds,
      60,
      10,
      600,
    ),
    ...(credentialRef ? { credentialRef } : {}),
  };
}

async function validateFallback(
  workspaceId: string,
  fallbackModelId: string | null | undefined,
  currentModelId?: string,
) {
  if (!fallbackModelId) return;
  if (fallbackModelId === currentModelId) {
    throw new Error("备用模型不能选择当前连接");
  }
  const db = await getDb();
  const [fallback] = await db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.id, fallbackModelId),
        eq(modelConnections.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!fallback) throw new Error("备用模型不存在或不属于当前工作空间");
}

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "Model operation failed" },
    { status },
  );
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as ModelConnectionDraft & {
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const draft = validateDraft(payload);
    await validateFallback(workspaceId, draft.fallbackModelId);
    const storedSecret = payload.secretValue
      ? await saveSecret({
          workspaceId,
          userId: user.id,
          name: payload.secretName || `${draft.name} API Key`,
          value: payload.secretValue,
        })
      : null;
    const db = await getDb();
    const now = mysqlNow();
    const id = `model_${crypto.randomUUID()}`;
    await db
      .insert(modelConnections)
      .values({
        id,
        workspaceId,
        createdBy: user.id,
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        modelName: draft.modelName,
        modalitiesJson: JSON.stringify(draft.modalities),
        credentialRef: draft.credentialRef ?? null,
        secretRefId: storedSecret?.id ?? payload.secretRefId ?? null,
        priority: draft.priority,
        fallbackModelId: draft.fallbackModelId ?? null,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        circuitFailureThreshold: draft.circuitFailureThreshold,
        circuitCooldownSeconds: draft.circuitCooldownSeconds,
        state: "attention",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    const [saved] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, id))
      .limit(1);
    if (!saved) throw new Error("模型连接创建后无法读取");
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType: "model.created",
      entityId: id,
      detailJson: JSON.stringify({
        protocol: draft.protocol,
        priority: draft.priority,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        fallbackModelId: draft.fallbackModelId ?? null,
      }),
    });
    return Response.json({ model: serializeModel(saved) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as Partial<ModelConnectionDraft> & {
      id?: string;
      enabled?: boolean;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    if (!payload.id) return errorResponse(new Error("id 必填"));
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) return errorResponse(new Error("模型连接不存在"), 404);

    let update: Partial<typeof modelConnections.$inferInsert>;
    if (typeof payload.enabled === "boolean" && !payload.name) {
      update = {
        enabled: payload.enabled,
        updatedAt: mysqlNow(),
      };
    } else {
      const draft = validateDraft(payload);
      await validateFallback(workspaceId, draft.fallbackModelId, existing.id);
      const storedSecret = payload.secretValue
        ? await saveSecret({
            workspaceId,
            userId: user.id,
            name: payload.secretName || `${draft.name} API Key`,
            value: payload.secretValue,
          })
        : null;
      update = {
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        modelName: draft.modelName,
        modalitiesJson: JSON.stringify(draft.modalities),
        credentialRef: draft.credentialRef ?? null,
        secretRefId:
          storedSecret?.id ?? payload.secretRefId ?? existing.secretRefId,
        priority: draft.priority,
        fallbackModelId: draft.fallbackModelId ?? null,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        circuitFailureThreshold: draft.circuitFailureThreshold,
        circuitCooldownSeconds: draft.circuitCooldownSeconds,
        state: "attention",
        latencyMs: null,
        lastCheckedAt: null,
        updatedAt: mysqlNow(),
      };
    }
    await db
      .update(modelConnections)
      .set(update)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      );
    const [updated] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!updated) return errorResponse(new Error("模型连接不存在"), 404);
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType:
        typeof payload.enabled === "boolean" && !payload.name
          ? payload.enabled
            ? "model.enabled"
            : "model.disabled"
          : "model.updated",
      entityId: updated.id,
      detailJson: JSON.stringify({
        protocol: updated.protocol,
        priority: updated.priority,
        maxConcurrency: updated.maxConcurrency,
        retryLimit: updated.retryLimit,
        fallbackModelId: updated.fallbackModelId,
      }),
    });
    return Response.json({ model: serializeModel(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
    );
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return errorResponse(new Error("id 必填"));
    const db = await getDb();
    const [existing] = await db
      .select({ id: modelConnections.id })
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) return errorResponse(new Error("模型连接不存在"), 404);
    await db
      .update(modelConnections)
      .set({ fallbackModelId: null, updatedAt: mysqlNow() })
      .where(
        and(
          eq(modelConnections.workspaceId, workspaceId),
          eq(modelConnections.fallbackModelId, id),
        ),
      );
    await db
      .delete(modelConnections)
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      );
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType: "model.deleted",
      entityId: id,
      detailJson: "{}",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
