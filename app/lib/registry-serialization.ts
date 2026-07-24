import type {
  Capability,
  InstalledPackage,
  ModelConnection,
  NodeKind,
  RegistryEvent,
} from "../types";
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

export function serializePackage(row: PackageRow): InstalledPackage {
  const manifest = parseJson<XiaoLuoPackageManifest | null>(
    row.manifestJson,
    null,
  );
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
    integritySha256: row.integritySha256,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
    contributionCount: manifest ? packageContributionCount(manifest) : 0,
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
    title: row.title,
    description: row.description,
    modality: row.modality as NodeKind,
    category: packageType === "skill" ? "SKILL" : "插件",
    enabled: row.enabled && packageEnabled,
    packageVersion,
    parameterHint: `${propertyCount} 个输入字段 · Schema 驱动`,
    packageId: row.packageId,
    contributionType: row.contributionType as "skill" | "node",
    inputSchema,
    uiSchema: parseJson<Record<string, unknown>>(row.uiSchemaJson, {}),
  };
}

export function serializeModel(row: ModelRow): ModelConnection {
  return {
    id: row.id,
    name: row.name,
    provider: row.protocol,
    protocol: row.protocol as ModelConnection["protocol"],
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    credentialRef: row.credentialRef ?? undefined,
    secretRefId: row.secretRefId ?? undefined,
    modalities: parseJson<NodeKind[]>(row.modalitiesJson, []),
    state: row.state as ModelConnection["state"],
    latency:
      typeof row.latencyMs === "number" ? `${row.latencyMs} ms` : "尚未检测",
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt,
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
