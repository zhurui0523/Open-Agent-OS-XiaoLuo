import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  modelCatalogEntries,
  modelConnections,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

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
    if (connectionId) {
      const [connection] = await db
        .select({ id: modelConnections.id })
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, connectionId),
            eq(modelConnections.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!connection) {
        return Response.json({ error: "模型连接不存在" }, { status: 404 });
      }
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
