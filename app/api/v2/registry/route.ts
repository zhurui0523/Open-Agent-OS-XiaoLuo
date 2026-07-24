import { and, asc, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  modelConnections,
  packageCapabilities,
  packages,
  registryEvents,
} from "../../../../db/schema";
import {
  serializeCapability,
  serializeEvent,
  serializeModel,
  serializePackage,
} from "../../../lib/registry-serialization";
import { requireUser } from "../../../lib/auth";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Registry unavailable";
  if (message.includes("no such table")) {
    return "注册表正在初始化，请稍后刷新。";
  }
  return message;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const db = await getDb();
    const [packageRows, capabilityRows, modelRows, eventRows] =
      await Promise.all([
        db
          .select()
          .from(packages)
          .where(
            and(
              eq(packages.workspaceId, workspaceId),
              ne(packages.lifecycleState, "uninstalled"),
            ),
          )
          .orderBy(desc(packages.updatedAt)),
        db
          .select({
            id: packageCapabilities.id,
            capabilityKey: packageCapabilities.capabilityKey,
            packageId: packageCapabilities.packageId,
            title: packageCapabilities.title,
            description: packageCapabilities.description,
            modality: packageCapabilities.modality,
            contributionType: packageCapabilities.contributionType,
            inputSchemaJson: packageCapabilities.inputSchemaJson,
            outputSchemaJson: packageCapabilities.outputSchemaJson,
            uiSchemaJson: packageCapabilities.uiSchemaJson,
            enabled: packageCapabilities.enabled,
          })
          .from(packageCapabilities)
          .innerJoin(packages, eq(packages.id, packageCapabilities.packageId))
          .where(
            and(
              eq(packages.workspaceId, workspaceId),
              ne(packages.lifecycleState, "uninstalled"),
            ),
          ),
        db
          .select()
          .from(modelConnections)
          .where(
            and(
              eq(modelConnections.workspaceId, workspaceId),
              eq(modelConnections.enabled, true),
            ),
          )
          .orderBy(
            asc(modelConnections.priority),
            desc(modelConnections.updatedAt),
          ),
        db
          .select()
          .from(registryEvents)
          .where(eq(registryEvents.workspaceId, workspaceId))
          .orderBy(desc(registryEvents.createdAt))
          .limit(20),
      ]);
    const packageMap = new Map(packageRows.map((row) => [row.id, row]));

    return Response.json({
      packages: packageRows.map(serializePackage),
      capabilities: capabilityRows.flatMap((row) => {
        const owner = packageMap.get(row.packageId);
        return owner
          ? [
              serializeCapability(
                row,
                owner.version,
                owner.packageType,
                owner.enabled,
              ),
            ]
          : [];
      }),
      models: modelRows.map(serializeModel),
      events: eventRows.map(serializeEvent),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: routeError(error) }, { status: 500 });
  }
}
