import type {
  KernelUpstreamInput,
  ModelInputAssetKind,
  ModelInputConstraints,
  NodeKind,
} from "../types";

export const MODEL_INPUT_ASSET_KINDS: ModelInputAssetKind[] = [
  "image",
  "video",
  "audio",
  "document",
];

const emptyTypeLimits = (): ModelInputConstraints["maxByType"] => ({
  image: 0,
  video: 0,
  audio: 0,
  document: 0,
});

function boundedLimit(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.trunc(parsed)));
}

export function defaultModelInputConstraints(
  kind: NodeKind,
  protocol?: string,
): ModelInputConstraints {
  if (kind === "video") {
    if (
      protocol === "runninghub-sparkvideo-mini" ||
      protocol === "runninghub-sparkvideo"
    ) {
      return {
        maxTotal: 2,
        maxByType: { image: 2, video: 0, audio: 0, document: 0 },
      };
    }
    return {
      maxTotal: 12,
      maxByType: { image: 9, video: 3, audio: 3, document: 0 },
    };
  }
  if (kind === "image") {
    if (protocol === "dall-e-3") {
      return { maxTotal: 0, maxByType: emptyTypeLimits() };
    }
    return {
      maxTotal: 14,
      maxByType: { image: 14, video: 0, audio: 0, document: 0 },
    };
  }
  return { maxTotal: 0, maxByType: emptyTypeLimits() };
}

export function normalizeModelInputConstraints(
  value: unknown,
  kind: NodeKind,
  protocol?: string,
): ModelInputConstraints {
  const fallback = defaultModelInputConstraints(kind, protocol);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const input = value as Partial<ModelInputConstraints>;
  const rawByType: Partial<Record<ModelInputAssetKind, unknown>> =
    input.maxByType &&
    typeof input.maxByType === "object" &&
    !Array.isArray(input.maxByType)
      ? (input.maxByType as Partial<Record<ModelInputAssetKind, unknown>>)
      : {};
  return {
    maxTotal: boundedLimit(input.maxTotal, fallback.maxTotal),
    maxByType: Object.fromEntries(
      MODEL_INPUT_ASSET_KINDS.map((assetKind) => [
        assetKind,
        boundedLimit(rawByType[assetKind], fallback.maxByType[assetKind]),
      ]),
    ) as ModelInputConstraints["maxByType"],
  };
}

export interface ModelInputValidation {
  total: number;
  counts: Record<ModelInputAssetKind, number>;
  errors: string[];
  valid: boolean;
}

export function validateModelInputAssets(
  constraints: ModelInputConstraints,
  inputs: Array<Pick<KernelUpstreamInput, "kind">>,
): ModelInputValidation {
  const counts = emptyTypeLimits();
  for (const input of inputs) {
    if (
      input.kind &&
      MODEL_INPUT_ASSET_KINDS.includes(input.kind as ModelInputAssetKind)
    ) {
      counts[input.kind as ModelInputAssetKind] += 1;
    }
  }
  const total = MODEL_INPUT_ASSET_KINDS.reduce(
    (sum, assetKind) => sum + counts[assetKind],
    0,
  );
  const errors: string[] = [];
  if (total > constraints.maxTotal) {
    errors.push(
      `输入素材共 ${total} 个，当前模型最多支持 ${constraints.maxTotal} 个`,
    );
  }
  const labels: Record<ModelInputAssetKind, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    document: "文档",
  };
  for (const assetKind of MODEL_INPUT_ASSET_KINDS) {
    const count = counts[assetKind];
    const maximum = constraints.maxByType[assetKind];
    if (count > maximum) {
      errors.push(
        maximum === 0
          ? `当前模型不支持${labels[assetKind]}参考素材`
          : `${labels[assetKind]}素材有 ${count} 个，当前模型最多支持 ${maximum} 个`,
      );
    }
  }
  return { total, counts, errors, valid: errors.length === 0 };
}

export function parseModelInputConstraints(
  value: string | null | undefined,
  kind: NodeKind,
  protocol?: string,
) {
  try {
    return normalizeModelInputConstraints(
      value ? JSON.parse(value) : undefined,
      kind,
      protocol,
    );
  } catch {
    return defaultModelInputConstraints(kind, protocol);
  }
}
