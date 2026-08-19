import type {
  Capability,
  ModelConnection,
  NodeKind,
} from "../types";
import {
  modelMatchesCapability,
  preferredCapability,
} from "./capability-sync.ts";

export type ProfessionalGeneratorKind = Extract<
  NodeKind,
  "text" | "image" | "video" | "audio"
>;

export function professionalGeneratorCapabilities(
  capabilities: Capability[],
  kind: ProfessionalGeneratorKind,
) {
  const modalityCapabilities = capabilities.filter(
    (capability) =>
      capability.enabled &&
      capability.category === "SKILL" &&
      capability.modality === kind,
  );
  const packageCapabilities = modalityCapabilities.filter((capability) =>
    Boolean(capability.packageId),
  );
  return packageCapabilities.length
    ? packageCapabilities
    : modalityCapabilities;
}

export function resolveProfessionalGeneratorRules(input: {
  capabilities: Capability[];
  models: ModelConnection[];
  kind: ProfessionalGeneratorKind;
  requestedCapabilityId?: string;
  requestedModelId?: string;
}) {
  const compatibleCapabilities = professionalGeneratorCapabilities(
    input.capabilities,
    input.kind,
  );
  const explicitlyWithoutSkill = input.requestedCapabilityId === "none";
  const requestedCapability = explicitlyWithoutSkill
    ? undefined
    : compatibleCapabilities.find(
        (capability) => capability.id === input.requestedCapabilityId,
      );
  const capability = explicitlyWithoutSkill
    ? null
    : (requestedCapability ??
      preferredCapability(compatibleCapabilities, input.kind) ??
      null);
  const sourceOrder = new Map(
    input.models.map((model, index) => [model.id, index]),
  );
  const compatibleModels = input.models
    .filter((model) =>
      modelMatchesCapability(model, capability, input.kind),
    )
    .sort((left, right) => {
      const leftInstalledAt = left.createdAt
        ? Date.parse(left.createdAt)
        : Number.NaN;
      const rightInstalledAt = right.createdAt
        ? Date.parse(right.createdAt)
        : Number.NaN;
      if (
        Number.isFinite(leftInstalledAt) &&
        Number.isFinite(rightInstalledAt) &&
        leftInstalledAt !== rightInstalledAt
      ) {
        return leftInstalledAt - rightInstalledAt;
      }
      return (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0);
    });
  const requestedModel = compatibleModels.find(
    (model) => model.id === input.requestedModelId,
  );
  const model =
    capability?.executionMode === "remote"
      ? null
      : (requestedModel ?? compatibleModels[0] ?? null);

  return {
    compatibleCapabilities,
    compatibleModels,
    capability,
    model,
    usesSkillRuntime: capability?.executionMode === "remote",
  };
}
