import type {
  Capability,
  CanvasNode,
  ModelConnection,
  NodeKind,
} from "../types";

export interface CapabilitySnapshot {
  id: string;
  capabilityKey?: string;
  title: string;
  packageId?: string | null;
  packageVersion: string;
  contributionType?: Capability["contributionType"] | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  ports: NonNullable<Capability["ports"]>;
  executionMode: NonNullable<Capability["executionMode"]>;
  modelRequirements: NonNullable<Capability["modelRequirements"]>;
}

export function snapshotCapability(
  capability: Capability,
): CapabilitySnapshot {
  return {
    id: capability.id,
    capabilityKey: capability.capabilityKey,
    title: capability.title,
    packageId: capability.packageId ?? null,
    packageVersion: capability.packageVersion,
    contributionType: capability.contributionType ?? null,
    inputSchema: capability.inputSchema ?? {},
    outputSchema: capability.outputSchema ?? {},
    uiSchema: capability.uiSchema ?? {},
    ports: capability.ports ?? [],
    executionMode:
      capability.executionMode ??
      (capability.packageId ? "model" : "builtin"),
    modelRequirements: capability.modelRequirements ?? {
      required: capability.executionMode !== "remote",
    },
  };
}

export function nodeCapabilitySnapshot(
  node: Pick<CanvasNode, "parameters">,
): CapabilitySnapshot | null {
  const value = node.parameters?.capabilitySnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<CapabilitySnapshot>;
  if (!snapshot.id || !snapshot.title || !snapshot.packageVersion) return null;
  return {
    id: snapshot.id,
    capabilityKey: snapshot.capabilityKey,
    title: snapshot.title,
    packageId: snapshot.packageId,
    packageVersion: snapshot.packageVersion,
    contributionType: snapshot.contributionType,
    inputSchema: snapshot.inputSchema ?? {},
    outputSchema: snapshot.outputSchema ?? {},
    uiSchema: snapshot.uiSchema ?? {},
    ports: snapshot.ports ?? [],
    executionMode: snapshot.executionMode ?? "model",
    modelRequirements: snapshot.modelRequirements ?? {},
  };
}

export function modelMatchesCapability(
  model: ModelConnection,
  capability: Capability | CapabilitySnapshot | null | undefined,
  kind: NodeKind,
) {
  if (model.enabled === false || !model.modalities.includes(kind)) return false;
  if (!capability || capability.executionMode === "builtin") return true;
  if (capability.executionMode === "remote") return false;
  const requirements = capability.modelRequirements ?? {};
  if (
    requirements.protocols?.length &&
    (!model.protocol || !requirements.protocols.includes(model.protocol))
  ) {
    return false;
  }
  if (
    requirements.modelIds?.length &&
    !requirements.modelIds.includes(model.modelName ?? model.id)
  ) {
    return false;
  }
  if (requirements.capabilityTags?.length) {
    const tags = new Set(model.capabilityTags ?? []);
    if (!requirements.capabilityTags.every((tag) => tags.has(tag))) {
      return false;
    }
  }
  return true;
}

export function preferredCapability(
  capabilities: Capability[],
  kind: NodeKind,
) {
  const compatible = capabilities.filter(
    (capability) => capability.enabled && capability.modality === kind,
  );
  return (
    compatible.find((capability) => Boolean(capability.packageId)) ??
    compatible[0]
  );
}

export function preferredModel(
  models: ModelConnection[],
  capability: Capability | CapabilitySnapshot | null | undefined,
  kind: NodeKind,
) {
  return models
    .filter((model) => modelMatchesCapability(model, capability, kind))
    .sort((left, right) => {
      const health =
        Number(right.state === "healthy") - Number(left.state === "healthy");
      return health || left.priority - right.priority;
    })[0];
}

export function capabilityExecutionParameters(
  parameters: Record<string, unknown> | undefined,
) {
  const source = parameters ?? {};
  const {
    capabilitySnapshot: _capabilitySnapshot,
    modelParameters: _modelParameters,
    kernelOutput: _kernelOutput,
    failurePolicy: _failurePolicy,
    retryLimit: _retryLimit,
    ...capabilityParameters
  } = source;
  return capabilityParameters;
}

export function modelExecutionParameters(
  parameters: Record<string, unknown> | undefined,
) {
  const value = parameters?.modelParameters;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// UI 只展示 schema 默认值、用户改过才落库，执行侧必须补同一份默认值，否则所见与所发不一致
export function parameterSchemaDefaults(
  parameterSchemaJson: string | null | undefined,
) {
  if (!parameterSchemaJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(parameterSchemaJson);
  } catch {
    return {};
  }
  const properties =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).properties
      : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }
  const defaults: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      continue;
    }
    const value = (property as Record<string, unknown>).default;
    if (value !== undefined) defaults[key] = value;
  }
  return defaults;
}

export function nodeExecutionParameters(
  parameters: Record<string, unknown> | undefined,
) {
  return {
    ...capabilityExecutionParameters(parameters),
    ...modelExecutionParameters(parameters),
  };
}
