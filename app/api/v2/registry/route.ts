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
import { requireWorkspaceAccess } from "../../../lib/authorization";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import type {
  ModelProviderTemplate,
  NodeKind,
} from "../../../types";
import type { XiaoLuoPackageManifest } from "../../../lib/package-contract";
import {
  canAccessRegistryResource,
  modelAccessScope,
  packageAccessScope,
} from "../../../lib/registry-access";

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Registry unavailable";
  if (message.includes("no such table")) {
    return "注册表正在初始化，请稍后刷新。";
  }
  return message;
}

function modelProviderTemplates(
  packageRows: Array<typeof packages.$inferSelect>,
): ModelProviderTemplate[] {
  return packageRows.flatMap((owner) => {
    if (!owner.enabled || owner.lifecycleState === "uninstalled") return [];
    try {
      const manifest = JSON.parse(owner.manifestJson) as XiaoLuoPackageManifest;
      return (manifest.contributes?.modelProviders ?? []).map((provider) => ({
        id: provider.id,
        packageId: owner.id,
        packageVersion: owner.version,
        title: provider.title,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        modalities: provider.modalities ?? (["text"] as NodeKind[]),
        parameterSchema: provider.parameterSchema ?? {},
        uiSchema: provider.uiSchema ?? {},
        capabilityTags: provider.capabilityTags ?? [],
      }));
    } catch {
      return [];
    }
  });
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const access = await requireWorkspaceAccess(user.id, workspaceId, "view");
    const ownershipContext = {
      userId: user.id,
      platformRole: user.platformRole,
      canManage: access.role === "owner" || access.role === "admin",
    };
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
            portsJson: packageCapabilities.portsJson,
            modelRequirementsJson: packageCapabilities.modelRequirementsJson,
            executionMode: packageCapabilities.executionMode,
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
          .where(eq(modelConnections.workspaceId, workspaceId))
          .orderBy(
            asc(modelConnections.priority),
            asc(modelConnections.createdAt),
            asc(modelConnections.id),
          ),
        db
          .select()
          .from(registryEvents)
          .where(eq(registryEvents.workspaceId, workspaceId))
          .orderBy(desc(registryEvents.createdAt))
          .limit(20),
      ]);
    const visiblePackageRows = packageRows.filter((row) => {
      let manifest: XiaoLuoPackageManifest | null = null;
      try {
        manifest = JSON.parse(row.manifestJson) as XiaoLuoPackageManifest;
      } catch {
        return false;
      }
      return canAccessRegistryResource({
        scope: packageAccessScope(manifest),
        createdBy: row.createdBy,
        userId: user.id,
        platformRole: user.platformRole,
      });
    });
    const visiblePackageMap = new Map(
      visiblePackageRows.map((row) => [row.id, row]),
    );
    const visibleModelRows = modelRows.filter((row) => {
      let uiSchema: Record<string, unknown> = {};
      try {
        uiSchema = JSON.parse(row.uiSchemaJson) as Record<string, unknown>;
      } catch {
        uiSchema = {};
      }
      return canAccessRegistryResource({
        scope: modelAccessScope(uiSchema),
        createdBy: row.createdBy,
        userId: user.id,
        platformRole: user.platformRole,
      });
    });

    return Response.json({
      packages: visiblePackageRows.map((row) =>
        serializePackage(row, ownershipContext),
      ),
      capabilities: capabilityRows.flatMap((row) => {
        const owner = visiblePackageMap.get(row.packageId);
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
      models: visibleModelRows.map((row) =>
        serializeModel(row, ownershipContext),
      ),
      modelProviders: modelProviderTemplates(visiblePackageRows),
      events: eventRows.map(serializeEvent),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: routeError(error) }, { status: 500 });
  }
}
