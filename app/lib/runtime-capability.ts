import type {
  modelConnections,
  packageCapabilities,
} from "../../db/schema";
import type { Capability, ModelProtocol, NodeKind } from "../types";

type CapabilityRow = typeof packageCapabilities.$inferSelect;
type ModelRow = typeof modelConnections.$inferSelect;

function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function validateRuntimeModel(
  capability: CapabilityRow | undefined,
  model: ModelRow | undefined,
  kind: NodeKind,
) {
  if (!capability) return;
  if (capability.executionMode === "remote") return;
  const requirements = parseJson<
    NonNullable<Capability["modelRequirements"]>
  >(capability.modelRequirementsJson, {});
  if (requirements.required !== false && !model?.enabled) {
    throw new Error("当前 Skill 需要模型，但节点尚未选择可用模型");
  }
  if (!model) return;
  const modalities = parseJson<NodeKind[]>(model.modalitiesJson, []);
  if (!modalities.includes(kind)) {
    throw new Error(`所选模型不支持 ${kind} 节点`);
  }
  if (
    requirements.protocols?.length &&
    !requirements.protocols.includes(model.protocol as ModelProtocol)
  ) {
    throw new Error("所选模型协议与当前 Skill 不兼容");
  }
  if (
    requirements.modelIds?.length &&
    !requirements.modelIds.includes(model.modelName)
  ) {
    throw new Error("所选模型不在当前 Skill 的允许列表中");
  }
  const modelTags = new Set(
    parseJson<string[]>(model.capabilityTagsJson, []),
  );
  if (
    requirements.capabilityTags?.some((tag) => !modelTags.has(tag))
  ) {
    throw new Error("所选模型缺少当前 Skill 要求的能力标签");
  }
}
