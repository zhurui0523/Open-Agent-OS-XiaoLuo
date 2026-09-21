/**
 * /api/v2/local-ai —— 本地大模型启动器的服务端入口。
 * GET：状态 + 健康同步（设置页轮询）；POST：register/disable/sync 显式动作。
 */
import { requireUser } from "../../../lib/auth";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import {
  disableLocalModelConnection,
  readLocalAiState,
  syncLocalModelConnections,
  upsertLocalModelConnection,
} from "../../../lib/local-ai";

// lib 依赖 node:fs/os 状态文件读写，必须 nodejs runtime
export const runtime = "nodejs";

function errorResponse(error: unknown, status = 400) {
  // 鉴权/工作区校验会直接抛出 Response（跨 realm 时 instanceof 不可靠，鸭子类型判定）
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number" &&
    "headers" in error
  ) {
    return error as Response;
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "操作失败" },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(request, user.id, "view");
    const state = readLocalAiState();
    if (!state) {
      return Response.json({ available: false, engine: null, healthy: false });
    }
    const synced = await syncLocalModelConnections(workspaceId, user.id);
    return Response.json({
      available: true,
      engines: state.engines,
      engine: state.engines.text,
      healthy: synced.healthy,
      registeredModelId: synced.registeredModelId,
      updatedAt: state.updatedAt,
    });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      action?: string;
      workspaceId?: string;
      modelId?: string;
      modelName?: string;
      port?: number;
      modality?: string;
      engine?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    switch (payload.action) {
      case "sync": {
        const synced = await syncLocalModelConnections(workspaceId, user.id);
        return Response.json(synced);
      }
      case "register": {
        const modelId = payload.modelId?.trim();
        const modelName = payload.modelName?.trim();
        const port = Number(payload.port);
        if (!modelId || !modelName || !Number.isInteger(port) || port <= 0) {
          throw new Error("modelId、modelName 和 port 必填");
        }
        const id = await upsertLocalModelConnection({
          workspaceId,
          userId: user.id,
          modelId,
          modelName,
          port,
          modality: payload.modality,
          engine: payload.engine === "diffusion" ? "diffusion" : undefined,
        });
        return Response.json({ ok: true, modelConnectionId: id });
      }
      case "disable": {
        const modelId = payload.modelId?.trim();
        if (!modelId) throw new Error("modelId 必填");
        await disableLocalModelConnection(workspaceId, modelId);
        return Response.json({ ok: true });
      }
      default:
        throw new Error("未知操作：" + payload.action);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
