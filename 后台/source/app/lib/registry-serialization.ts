import type {
  Capability,
  InstalledPackage,
  ModelConnection,
  NodeKind,
  RegistryEvent,
} from "../types";
import { parseModelInputConstraints } from "./model-input-constraints";
import type {
  modelConnections,
  packageCapabilities,
  packages,
  registryEvents,
} from "../../db/schema";
import {
  packageContributionCount,
  type XiaoLuoPackageManifest,
} from "./package-contract";
import { skillInstructionsFromSchema } from "./skill-markdown";
import {
  canManageRegistryResource,
  modelAccessScope,
  packageAccessScope,
} from "./registry-access";

type PackageRow = typeof packages.$inferSelect;
type CapabilityRow = typeof packageCapabilities.$inferSelect;
type ModelRow = typeof modelConnections.$inferSelect;
type EventRow = typeof registryEvents.$inferSelect;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface OwnershipContext {
  userId?: string;
  platformRole?: "system_admin" | "user";
  canManage?: boolean;
}

function ownerScope(rowCreatedBy: string, context?: OwnershipContext) {
  return rowCreatedBy === context?.userId
    ? ("personal" as const)
    : ("administrator" as const);
}

export function serializePackage(
  row: PackageRow,
  context?: OwnershipContext,
): InstalledPackage {
  const manifest = parseJson<XiaoLuoPackageManifest | null>(
    row.manifestJson,
    null,
  );
  const accessScope = packageAccessScope(manifest);
  return {
    id: row.id,
    packageKey: row.packageKey,
    name: row.name,
    version: row.version,
    description: row.description,
    packageType: row.packageType as InstalledPackage["packageType"],
    runtimeType: row.runtimeType as InstalledPackage["runtimeType"],
    runtimeUrl: row.runtimeUrl,
    permissions: parseJson<string[]>(row.permissionsJson, []),
    enabled: row.enabled,
    lifecycleState: row.lifecycleState,
    healthStatus: row.healthStatus,
    trustState: row.trustState,
    integritySha256: row.integritySha256,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
    contributionCount: manifest ? packageContributionCount(manifest) : 0,
    runtimeLanguage: manifest?.runtime.language,
    createdBy: row.createdBy,
    ownerScope: ownerScope(row.createdBy, context),
    accessScope,
    canManage: canManageRegistryResource({
      scope: accessScope,
      createdBy: row.createdBy,
      userId: context?.userId,
      platformRole: context?.platformRole,
      canManageWorkspace: context?.canManage,
    }),
    manifest: manifest
      ? (manifest as unknown as Record<string, unknown>)
      : undefined,
    nodeContributions: (manifest?.contributes?.nodes ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description ?? "",
      modality: item.modality,
      inputSchema: item.inputSchema ?? {},
      outputSchema: item.outputSchema ?? {},
      uiSchema: item.uiSchema ?? {},
      ports: item.ports ?? [],
    })),
  };
}

export function serializeCapability(
  row: CapabilityRow,
  packageVersion: string,
  packageType: string,
  packageEnabled: boolean,
): Capability {
  const inputSchema = parseJson<Record<string, unknown>>(row.inputSchemaJson, {});
  const propertyCount =
    typeof inputSchema.properties === "object" && inputSchema.properties
      ? Object.keys(inputSchema.properties).length
      : 0;
  return {
    id: row.id,
    capabilityKey: row.capabilityKey,
    title: row.title,
    description: row.description,
    modality: row.modality as NodeKind,
    category:
      packageType === "skill"
        ? "SKILL"
        : packageType === "agent"
          ? "Agent"
          : packageType === "workflow"
            ? "Workflow"
            : "插件",
    enabled: row.enabled && packageEnabled,
    packageVersion,
    parameterHint: `${propertyCount} 个输入字段 · Schema 驱动`,
    packageId: row.packageId,
    contributionType: row.contributionType as Capability["contributionType"],
    inputSchema,
    outputSchema: parseJson<Record<string, unknown>>(row.outputSchemaJson, {}),
    uiSchema: parseJson<Record<string, unknown>>(row.uiSchemaJson, {}),
    ports: parseJson<Capability["ports"]>(row.portsJson, []),
    executionMode: row.executionMode as Capability["executionMode"],
    modelRequirements: parseJson<Capability["modelRequirements"]>(
      row.modelRequirementsJson,
      {},
    ),
    instructions: skillInstructionsFromSchema(inputSchema),
  };
}

export function serializeModel(
  row: ModelRow,
  context?: OwnershipContext,
): ModelConnection {
  const uiSchema = parseJson<Record<string, unknown>>(row.uiSchemaJson, {});
  const accessScope = modelAccessScope(uiSchema);
  const modalities = parseJson<NodeKind[]>(row.modalitiesJson, []);
  const protocol = row.protocol as ModelConnection["protocol"];
  return {
    id: row.id,
    name: row.name,
    provider: row.protocol,
    createdAt: row.createdAt
      ? new Date(row.createdAt).toISOString()
      : undefined,
    protocol,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    credentialRef: row.credentialRef ?? undefined,
    secretRefId: row.secretRefId ?? undefined,
    priority: row.priority,
    fallbackModelId: row.fallbackModelId,
    maxConcurrency: row.maxConcurrency,
    retryLimit: row.retryLimit,
    circuitFailureThreshold: row.circuitFailureThreshold,
    circuitCooldownSeconds: row.circuitCooldownSeconds,
    circuitState: row.circuitState as ModelConnection["circuitState"],
    activeRequests: row.activeRequests,
    catalogSyncedAt: row.catalogSyncedAt,
    modalities,
    state: row.state as ModelConnection["state"],
    latency:
      typeof row.latencyMs === "number" ? `${row.latencyMs} ms` : "尚未检测",
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt,
    parameterSchema: parseJson<Record<string, unknown>>(
      row.parameterSchemaJson,
      {},
    ),
    uiSchema,
    inputConstraints: parseModelInputConstraints(
      row.inputConstraintsJson,
      modalities[0] ?? "text",
      protocol,
    ),
    capabilityTags: parseJson<string[]>(row.capabilityTagsJson, []),
    createdBy: row.createdBy,
    ownerScope: ownerScope(row.createdBy, context),
    accessScope:
      accessScope === "personal" ? "personal" : "workspace",
    canManage: canManageRegistryResource({
      scope: accessScope,
      createdBy: row.createdBy,
      userId: context?.userId,
      platformRole: context?.platformRole,
      canManageWorkspace: context?.canManage,
    }),
  };
}

export function serializeEvent(row: EventRow): RegistryEvent {
  return {
    id: row.id,
    eventType: row.eventType,
    entityId: row.entityId,
    detail: parseJson<Record<string, unknown>>(row.detailJson, {}),
    createdAt: row.createdAt,
  };
}
