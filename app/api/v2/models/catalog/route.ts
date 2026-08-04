import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  modelCatalogEntries,
  modelConnections,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import {
  canAccessRegistryResource,
  modelAccessScope,
} from "../../../../lib/registry-access";

function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const connectionId = new URL(request.url).searchParams
      .get("connectionId")
      ?.trim();
    const db = await getDb();
    const connections = await db
      .select({
        id: modelConnections.id,
        createdBy: modelConnections.createdBy,
        uiSchemaJson: modelConnections.uiSchemaJson,
      })
      .from(modelConnections)
      .where(eq(modelConnections.workspaceId, workspaceId));
    const visibleConnectionIds = connections
      .filter((connection) =>
        canAccessRegistryResource({
          scope: modelAccessScope(
            parseJson<Record<string, unknown>>(
              connection.uiSchemaJson,
              {},
            ),
          ),
          createdBy: connection.createdBy,
          userId: user.id,
          platformRole: user.platformRole,
        }),
      )
      .map((connection) => connection.id);
    if (connectionId) {
      if (!visibleConnectionIds.includes(connectionId)) {
        return Response.json({ error: "模型连接不存在" }, { status: 404 });
      }
    }
    if (!visibleConnectionIds.length) {
      return Response.json({ models: [] });
    }
    const rows = await db
      .select()
      .from(modelCatalogEntries)
      .where(
        connectionId
          ? and(
              eq(modelCatalogEntries.workspaceId, workspaceId),
              eq(modelCatalogEntries.connectionId, connectionId),
              eq(modelCatalogEntries.available, true),
            )
          : and(
              eq(modelCatalogEntries.workspaceId, workspaceId),
              eq(modelCatalogEntries.available, true),
              inArray(
                modelCatalogEntries.connectionId,
                visibleConnectionIds,
              ),
            ),
      )
      .orderBy(desc(modelCatalogEntries.lastSeenAt))
      .limit(1000);
    return Response.json({
      models: rows.map((row) => ({
        id: row.id,
        connectionId: row.connectionId,
        modelId: row.modelId,
        displayName: row.displayName,
        modalities: parseJson<string[]>(row.modalitiesJson, []),
        metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
        lastSeenAt: row.lastSeenAt,
      })),
    });
  } catch (error) {
    return jsonError(error, "读取动态模型目录失败");
  }
}
