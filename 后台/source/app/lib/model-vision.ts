/**
 * 模型视觉能力判定（宿主侧启发式，供 inspect_screen / desktop_screenshot 决定要不要把图片塞进上下文）。
 *
 * 优先级：登记处的输入约束（能收几张图）> 登记 modalities > 模型族名字。
 * 约束里 image=0 是明确否定，不能被名字覆盖；image>0 是明确肯定，不必猜。
 */
import type { ModelInputConstraints } from "../types";

export interface VisionProbe {
  modelId: string;
  modalities?: string[];
  inputConstraints?: ModelInputConstraints | null;
}

export function modelSupportsVision(probe: VisionProbe): boolean {
  const imageLimit = probe.inputConstraints?.maxByType?.image;
  if (typeof imageLimit === "number") return imageLimit > 0;
  if ((probe.modalities ?? []).some((mm) => /image|vision|video/.test(mm))) return true;
  return modelLikelyVisionByName(probe.modelId ?? "");
}

/** 名字启发式：只在登记处没有能力信息时兜底 */
export function modelLikelyVisionByName(modelId: string): boolean {
  const id = (modelId || "").toLowerCase();
  if (!id) return false;
  if (/(vl|vision|visual|multimodal|qvq|internvl)/.test(id)) return true;
  if (/(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|o3|o4|claude|gemini)/.test(id)) return true;
  if (/(doubao.*(vision|seed)|seed-1\.6|seed-2\.0|seed-2\.5)/.test(id)) return true;
  if (/(glm-4v|hunyuan.*vision|step-1v|step-3|qwen.*(vl|max)|kimi.*vision|minimax.*vl)/.test(id)) return true;
  return false;
}
