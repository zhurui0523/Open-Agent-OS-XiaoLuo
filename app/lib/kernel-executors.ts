import type {
  KernelNodeOutput,
  KernelUpstreamInput,
  ModelInputConstraints,
  NodeKind,
} from "../types";
import {
  capabilityExecutionParameters,
  modelExecutionParameters,
} from "./capability-sync";
import type {
  modelConnections,
  packages,
} from "../../db/schema";
import { getDb } from "../../db";
import type { XiaoLuoPackageManifest } from "./package-contract";
import {
  fetchExternalEndpoint,
  readResponseBytesLimited,
  readResponseJsonLimited,
  validateExternalEndpoint,
} from "./model-adapters";
import {
  modelEndpointKind,
  resolveModelApiEndpoint,
} from "./model-endpoints";
import { resolveSecret } from "./secret-vault";
import { packageSignaturesRequired } from "./server-runtime-config";
import { roleForNode } from "./node-role";
import { modelResponseAssetUrl, modelResponseText } from "./model-response";
import { parseModelInputConstraints } from "./model-input-constraints";
import { externalAssetAccessUrl, getFileBucket, storeAsset } from "./asset-kernel";
import { artifactFormat, artifactName } from "./artifact-format";
import {
  inspectIsolatedExecution,
  isolatedExecutionPolicy,
  submitIsolatedExecution,
  type IsolatedRuntime,
} from "./isolated-worker";

type ModelRow = typeof modelConnections.$inferSelect;
type PackageRow = typeof packages.$inferSelect;

export interface KernelNodeRequest {
  id: string;
  title: string;
  prompt: string;
  kind: NodeKind;
  capabilityId: string;
  modelId: string;
  parameters?: Record<string, unknown>;
  instructions?: string;
}

export interface ExecutorResult {
  executor: string;
  result: string;
  output: KernelNodeOutput;
  asyncJob?: AsyncJobDescriptor;
}

export interface AsyncJobDescriptor {
  externalJobId: string;
  pollUrl: string;
  cancelUrl?: string;
  providerStatus: string;
  progress: number;
}

export class ModelExecutionError extends Error {
  status: number;
  retryAfterMs: number | null;
  code: string;

  constructor(
    message: string,
    options: { status: number; retryAfterMs?: number | null; code?: string },
  ) {
    super(message);
    this.name = "ModelExecutionError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.code = options.code ?? `HTTP_${options.status}`;
  }
}

export interface ModelExecutionContext {
  workspaceId?: string;
}

function inputAssetId(input: KernelUpstreamInput) {
  if (!input.output || typeof input.output !== "object") return undefined;
  const output = input.output as Record<string, unknown>;
  const data =
    output.data && typeof output.data === "object"
      ? (output.data as Record<string, unknown>)
      : undefined;
  if (typeof data?.assetId === "string" && data.assetId.trim()) {
    return data.assetId.trim();
  }
  const assetUrl = modelResponseAssetUrl(input.output);
  if (!assetUrl) return undefined;
  try {
    return new URL(assetUrl, "http://internal.invalid").searchParams.get(
      "assetId",
    ) ?? undefined;
  } catch {
    return undefined;
  }
}

async function providerReadyInputs(
  inputs: KernelUpstreamInput[],
  context?: ModelExecutionContext,
) {
  const assetInputs = inputs.filter((input) =>
    ["image", "video", "audio", "document"].includes(input.kind ?? ""),
  );
  if (!assetInputs.length) return inputs;
  const db = await getDb();
  const resolved = new Map<string, Promise<string>>();
  return Promise.all(
    inputs.map(async (input) => {
      const assetUrl = modelResponseAssetUrl(input.output);
      if (!assetUrl) return input;
      const assetId = inputAssetId(input);
      if (!assetId) {
        if (/^(?:https?:|data:)/i.test(assetUrl)) return input;
        throw new ModelExecutionError(
          "输入素材仍是站内地址，第三方模型无法读取；请重新上传或重新连接该素材",
          { status: 400, code: "MODEL_INPUT_NOT_PUBLIC" },
        );
      }
      if (!context?.workspaceId) {
        throw new ModelExecutionError(
          "缺少素材所属工作区，无法安全地向第三方模型提供素材",
          { status: 400, code: "MODEL_INPUT_CONTEXT_MISSING" },
        );
      }
      let pending = resolved.get(assetId);
      if (!pending) {
        pending = externalAssetAccessUrl(db, {
          assetId,
          workspaceId: context.workspaceId,
        });
        resolved.set(assetId, pending);
      }
      const output = input.output as Record<string, unknown>;
      return {
        ...input,
        output: { ...output, assetUrl: await pending },
      };
    }),
  );
}

function upstreamText(inputs: KernelUpstreamInput[]) {
  if (!inputs.length) return "无上游输入";
  return inputs
    .map((input) => {
      const value =
        typeof input.output === "string"
          ? input.output
          : JSON.stringify(input.output);
      return `${input.title ?? input.nodeId}: ${value?.slice(0, 1600) ?? ""}`;
    })
    .join("\n");
}

type StoredKernelNodeOutput = KernelNodeOutput & { result?: string };

function hasResultValue(value: unknown): value is StoredKernelNodeOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as StoredKernelNodeOutput;
  if (typeof output.result === "string" && output.result.trim()) return true;
  if (typeof output.text === "string" && output.text.trim()) return true;
  if (typeof output.assetUrl === "string" && output.assetUrl.trim()) return true;
  if (output.data === undefined || output.data === null) return false;
  if (
    typeof output.data === "object" &&
    !Array.isArray(output.data) &&
    (output.data as { placeholder?: unknown }).placeholder === true
  ) {
    return false;
  }
  return true;
}

function executionPrompt(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
) {
  return [
    `任务：${node.title}`,
    `要求：${node.prompt}`,
    ...(node.instructions
      ? [`Skill 执行规则（优先遵守）：\n${node.instructions}`]
      : []),
    `输出模态：${node.kind}`,
    `参数：${JSON.stringify(node.parameters ?? {})}`,
    `上游结果：\n${upstreamText(inputs)}`,
  ].join("\n\n");
}

function sunoLyricsPrompt(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
) {
  const upstreamLyrics = inputs
    .filter((input) => !input.kind || input.kind === "text")
    .map((input) => modelResponseText(input.output)?.trim())
    .filter((value): value is string => Boolean(value));

  if (upstreamLyrics.length) {
    return upstreamLyrics.join("\n\n");
  }

  return node.prompt.trim();
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60_000,
  maxResponseBytes = 2 * 1024 * 1024,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const sourceSignal = init.signal;
  const abortFromSource = () => controller.abort();
  sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  try {
    let response: Response;
    try {
      response = await fetchExternalEndpoint(
        url,
        {
          ...init,
          signal: controller.signal,
        },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof ModelExecutionError) throw error;
      const message =
        error instanceof Error
          ? error.message
          : "无法连接远程模型服务，请检查接口地址、服务器网络或服务状态";
      throw new ModelExecutionError(message, {
        status: controller.signal.aborted ? 504 : 502,
        code: controller.signal.aborted
          ? "PROVIDER_TIMEOUT"
          : "PROVIDER_NETWORK_ERROR",
      });
    }
    const payload = await readResponseJsonLimited(
      response,
      maxResponseBytes,
    ).catch(() => null);
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "error" in payload
          ? JSON.stringify(payload.error)
          : `HTTP ${response.status}`;
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
      throw new ModelExecutionError(`执行器返回失败：${detail}`, {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfterSeconds)
          ? Math.max(0, retryAfterSeconds * 1000)
          : null,
        code:
          response.status === 429
            ? "RATE_LIMITED"
            : response.status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : `HTTP_${response.status}`,
      });
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", abortFromSource);
  }
}

function credentialHeaders(model: ModelRow, credential?: string) {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (credential) {
    if (model.protocol === "anthropic-compatible") {
      headers.set("x-api-key", credential);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${credential}`);
    }
  }
  return headers;
}

async function modelCredential(model: ModelRow) {
  if (!model.secretRefId) {
    return model.credentialRef ? process.env[model.credentialRef] : undefined;
  }
  try {
    return await resolveSecret(model.secretRefId, model.workspaceId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ModelExecutionError(
      `模型 API Key 无法解密，请检查本地 SECRET_ENCRYPTION_KEY 是否与保存凭据时一致：${detail}`,
      {
        status: 500,
        code: "MODEL_CREDENTIAL_DECRYPT_FAILED",
      },
    );
  }
}

function normalizeRemoteOutput(
  payload: unknown,
  node: KernelNodeRequest,
  executor: string,
): ExecutorResult {
  const assetUrl = modelResponseAssetUrl(payload);
  const text = modelResponseText(payload);
  const kindLabel = {
    text: "文本",
    image: "图像",
    video: "视频",
    audio: "音频",
    document: "文档",
  }[node.kind];
  const result =
    text ??
    (assetUrl
      ? `${kindLabel}结果已生成`
      : "执行器已返回结构化结果");
  return {
    executor,
    result,
    output: {
      type: assetUrl ? node.kind : text ? "text" : "json",
      ...(text ? { text } : {}),
      ...(assetUrl ? { assetUrl } : {}),
      data: payload,
      executor,
    },
  };
}

function stringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) {
      return String(record[key]);
    }
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  }
  return undefined;
}

export function assertRunningHubBusinessSuccess(payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const record = payload as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const errorCode = stringField(nested, ["errorCode", "error_code", "code"]);
  const errorMessage = stringField(nested, [
    "errorMessage",
    "error_message",
    "message",
  ]);
  const providerStatus = (
    stringField(nested, ["status", "state"]) ?? ""
  ).toLowerCase();
  const failedStatus = [
    "failed",
    "failure",
    "error",
    "canceled",
    "cancelled",
  ].includes(providerStatus);
  const failedCode = Boolean(errorCode && errorCode !== "0");
  if (!failedStatus && !failedCode) return;
  const credentialRejected = /APIKEY_USER_NOT_FOUND|APIKEY_NOT_FOUND|APIKEY_INVALID|AUTHENTICATION/i.test(
    (errorCode || "") + " " + (errorMessage || ""),
  );
  const failureMessage = credentialRejected
    ? "RunningHub API Key 无效或不存在（" + (errorMessage || errorCode) + "）：请在模型连接中检查密钥是否填写正确，标准模型 API 仅支持企业级-共享 API Key"
    : errorMessage || `RunningHub 任务失败${errorCode ? `（${errorCode}）` : ""}`;
  throw new ModelExecutionError(
    failureMessage,
    {
      status: 502,
      code: errorCode ? `RUNNINGHUB_${errorCode}` : "RUNNINGHUB_TASK_FAILED",
    },
  );
}

function asyncDescriptor(
  payload: unknown,
  baseUrl: string,
): AsyncJobDescriptor | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const externalJobId = stringField(nested, [
    "job_id",
    "jobId",
    "task_id",
    "taskId",
    "id",
  ]);
  if (!externalJobId) return undefined;
  const providerStatus = (
    stringField(nested, ["status", "state"]) ?? "submitted"
  ).toLowerCase();
  if (["succeeded", "success", "completed", "done"].includes(providerStatus)) {
    return undefined;
  }
  const base = baseUrl.replace(/\/+$/, "");
  const pollUrl =
    stringField(nested, ["poll_url", "pollUrl", "status_url", "statusUrl"]) ??
    `${base}/${encodeURIComponent(externalJobId)}`;
  const cancelUrl =
    stringField(nested, ["cancel_url", "cancelUrl"]) ?? pollUrl;
  validateExternalEndpoint(pollUrl);
  validateExternalEndpoint(cancelUrl);
  return {
    externalJobId,
    pollUrl,
    cancelUrl,
    providerStatus,
    progress: numberField(nested, ["progress", "percent"]) ?? 5,
  };
}

function isRunningHubVideoProtocol(protocol: ModelRow["protocol"]) {
  return (
    protocol === "runninghub-sparkvideo-mini-multimodal" ||
    protocol === "runninghub-sparkvideo-multimodal" ||
    protocol === "runninghub-minimax-h3" ||
    protocol === "runninghub-seedance"
  );
}

function isRunningHubImageProtocol(protocol: ModelRow["protocol"]) {
  return (
    protocol === "runninghub-rh-image-2" ||
    protocol === "runninghub-nano-banana-2"
  );
}

function isRunningHubAudioProtocol(protocol: ModelRow["protocol"]) {
  return protocol === "runninghub-suno-v5";
}

function isRunningHubProtocol(protocol: ModelRow["protocol"]) {
  return (
    isRunningHubVideoProtocol(protocol) ||
    isRunningHubImageProtocol(protocol) ||
    isRunningHubAudioProtocol(protocol)
  );
}

function runningHubQueryEndpoint(protocol: ModelRow["protocol"]) {
  return isRunningHubImageProtocol(protocol) ||
    isRunningHubAudioProtocol(protocol)
    ? "https://www.runninghub.ai/openapi/v2/query"
    : "https://www.runninghub.cn/openapi/v2/query";
}

function booleanParameter(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function stringParameter(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function stringListParameter(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

type ModelInputAssetReference = {
  kind: "image" | "video" | "audio" | "document";
  url: string;
};

function modelInputAssetReferences(
  inputs: KernelUpstreamInput[],
): ModelInputAssetReference[] {
  const assetInputs = inputs.filter(
    (input) =>
      input.kind === "image" ||
      input.kind === "video" ||
      input.kind === "audio" ||
      input.kind === "document",
  );
  const references = assetInputs.flatMap((input) => {
    const url = modelResponseAssetUrl(input.output);
    return url && input.kind
      ? [{ kind: input.kind as ModelInputAssetReference["kind"], url }]
      : [];
  });
  if (references.length !== assetInputs.length) {
    throw new ModelExecutionError(
      "部分参考素材尚未生成可用地址，请等待上游素材完成后重试",
      { status: 400, code: "MODEL_INPUT_NOT_READY" },
    );
  }
  return references;
}

function onlyImageReferences(
  inputs: KernelUpstreamInput[],
  formatLabel: string,
) {
  const references = modelInputAssetReferences(inputs);
  const unsupported = references.find((reference) => reference.kind !== "image");
  if (unsupported) {
    throw new ModelExecutionError(
      `${formatLabel} 当前只支持图片参考素材，不能提交${unsupported.kind}素材`,
      { status: 400, code: "MODEL_INPUT_FORMAT_UNSUPPORTED" },
    );
  }
  return references;
}

function openAIChatContent(prompt: string, inputs: KernelUpstreamInput[]) {
  const references = onlyImageReferences(inputs, "OpenAI Chat");
  if (!references.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...references.map((reference) => ({
      type: "image_url",
      image_url: { url: reference.url },
    })),
  ];
}

function openAIResponsesInput(prompt: string, inputs: KernelUpstreamInput[]) {
  const references = onlyImageReferences(inputs, "OpenAI Responses");
  if (!references.length) return prompt;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...references.map((reference) => ({
          type: "input_image",
          image_url: reference.url,
        })),
      ],
    },
  ];
}

const defaultAssetMimeTypes: Record<ModelInputAssetReference["kind"], string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/octet-stream",
};

function geminiInputParts(prompt: string, inputs: KernelUpstreamInput[]) {
  const references = modelInputAssetReferences(inputs);
  return [
    { text: prompt },
    ...references.map((reference) => {
      const inline = reference.url.match(
        /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i,
      );
      return inline
        ? {
            inlineData: {
              mimeType: inline[1],
              data: inline[2],
            },
          }
        : {
            fileData: {
              mimeType: defaultAssetMimeTypes[reference.kind],
              fileUri: reference.url,
            },
          };
    }),
  ];
}

function runningHubMultimodalReferences(
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  constraints: ModelInputConstraints,
) {
  const references = inputs.flatMap((input) => {
    const url = modelResponseAssetUrl(input.output);
    if (!url) return [];
    const output =
      input.output && typeof input.output === "object"
        ? (input.output as Record<string, unknown>)
        : undefined;
    const kind =
      input.kind ??
      (typeof output?.type === "string" ? output.type : undefined);
    return kind === "image" || kind === "video" || kind === "audio"
      ? [{ kind, url }]
      : [];
  });
  const labels = { image: "图片", video: "视频", audio: "音频" } as const;
  const urlsFor = (kind: "image" | "video" | "audio") => {
    const configured = stringListParameter(modelParameters[`${kind}Urls`]);
    const connected = references
      .filter((reference) => reference.kind === kind)
      .map((reference) => reference.url);
    const urls = [...new Set([...configured, ...connected])];
    const limit = constraints.maxByType[kind];
    if (urls.length > limit) {
      throw new ModelExecutionError(
        limit === 0
          ? `当前模型不支持${labels[kind]}参考素材`
          : `${labels[kind]}素材有 ${urls.length} 个，当前模型最多支持 ${limit} 个`,
        { status: 400, code: "MODEL_INPUT_CONSTRAINT" },
      );
    }
    return urls;
  };
  const result = {
    imageUrls: urlsFor("image"),
    videoUrls: urlsFor("video"),
    audioUrls: urlsFor("audio"),
  };
  const total =
    result.imageUrls.length + result.videoUrls.length + result.audioUrls.length;
  if (total > constraints.maxTotal) {
    throw new ModelExecutionError(
      `输入素材共 ${total} 个，当前模型最多支持 ${constraints.maxTotal} 个`,
      { status: 400, code: "MODEL_INPUT_CONSTRAINT" },
    );
  }
  return result;
}

function runningHubMinimaxH3Body(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  prompt: string,
  constraints: ModelInputConstraints,
) {
  if (node.kind !== "video") {
    throw new Error("RunningHub MiniMax-H3 仅支持视频节点");
  }

  const references = runningHubMultimodalReferences(
    inputs,
    modelParameters,
    constraints,
  );

  return {
    prompt,
    ...references,
    resolution: "2K",
    duration: stringParameter(modelParameters.duration, "5"),
    ratio: stringParameter(modelParameters.ratio, "adaptive"),
  };
}

function runningHubSparkVideoMultimodalBody(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  prompt: string,
  constraints: ModelInputConstraints,
) {
  if (node.kind !== "video") {
    throw new Error("RunningHub SparkVideo 多模态接口仅支持视频节点");
  }
  const conversionSlot = stringParameter(
    modelParameters.conversionSlots,
    "all",
  );
  return {
    prompt,
    resolution: stringParameter(modelParameters.resolution, "720p"),
    duration: stringParameter(modelParameters.duration, "5"),
    ...runningHubMultimodalReferences(inputs, modelParameters, constraints),
    generateAudio: booleanParameter(modelParameters.generateAudio, true),
    ratio: stringParameter(modelParameters.ratio, "adaptive"),
    realPersonMode: booleanParameter(modelParameters.realPersonMode, true),
    conversionSlots: [conversionSlot],
    returnLastFrame: booleanParameter(modelParameters.returnLastFrame, false),
    seed:
      typeof modelParameters.seed === "number" &&
      Number.isInteger(modelParameters.seed)
        ? modelParameters.seed
        : -1,
  };
}

function runningHubSeedanceBody(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  prompt: string,
  constraints: ModelInputConstraints,
) {
  if (node.kind !== "video") {
    throw new Error("RunningHub Seedance 仅支持视频节点");
  }
  const conversionSlot = stringParameter(
    modelParameters.conversionSlots,
    "all",
  );
  return {
    prompt,
    resolution: stringParameter(modelParameters.resolution, "720p"),
    duration: stringParameter(modelParameters.duration, "5"),
    ...runningHubMultimodalReferences(inputs, modelParameters, constraints),
    generateAudio: booleanParameter(modelParameters.generateAudio, true),
    ratio: stringParameter(modelParameters.ratio, "adaptive"),
    bitrateMode: stringParameter(modelParameters.bitrateMode, "standard"),
    realPersonMode: booleanParameter(modelParameters.realPersonMode, true),
    conversionSlots: [conversionSlot],
    returnLastFrame: booleanParameter(modelParameters.returnLastFrame, false),
    seed:
      typeof modelParameters.seed === "number" &&
      Number.isInteger(modelParameters.seed)
        ? modelParameters.seed
        : -1,
  };
}

function runningHubSunoBody(
  node: KernelNodeRequest,
  modelParameters: Record<string, unknown>,
  prompt: string,
) {
  if (node.kind !== "audio") {
    throw new Error("RunningHub Suno 仅支持音频节点");
  }
  if (!prompt.trim()) {
    throw new ModelExecutionError(
      "Suno 需要歌词作为提示词，请先在节点中输入完整歌词",
      { status: 400, code: "MODEL_INPUT_MISSING" },
    );
  }
  const tags = stringParameter(modelParameters.tags, "").trim();
  if (!tags) {
    throw new ModelExecutionError(
      "Suno 需要在模型参数中填写风格标签（tags），例如：流行,民谣,女声",
      { status: 400, code: "MODEL_INPUT_MISSING" },
    );
  }
  return {
    title: stringParameter(
      modelParameters.title,
      stringParameter(node.title, "未命名歌曲"),
    ).slice(0, 80),
    prompt: prompt.slice(0, 5000),
    tags: tags.slice(0, 1000),
  };
}

function runningHubVideoBody(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  prompt: string,
) {
  if (node.kind !== "video") {
    throw new Error("RunningHub SparkVideo 仅支持视频节点");
  }
  const inputAssetUrls = inputs
    .map((input) => modelResponseAssetUrl(input.output))
    .filter((value): value is string => Boolean(value));
  const firstFrameUrl =
    (typeof modelParameters.firstFrameUrl === "string" &&
      modelParameters.firstFrameUrl) ||
    inputAssetUrls[0];
  if (!firstFrameUrl) {
    throw new Error("SparkVideo 需要连接一张图片作为首帧素材");
  }
  const lastFrameUrl =
    (typeof modelParameters.lastFrameUrl === "string" &&
      modelParameters.lastFrameUrl) ||
    inputAssetUrls[1];
  const conversionSlot = stringParameter(
    modelParameters.conversionSlots,
    "all",
  );
  return {
    prompt,
    resolution: stringParameter(modelParameters.resolution, "720p"),
    duration: stringParameter(modelParameters.duration, "5"),
    firstFrameUrl,
    ...(lastFrameUrl ? { lastFrameUrl } : {}),
    generateAudio: booleanParameter(modelParameters.generateAudio, true),
    ratio: stringParameter(modelParameters.ratio, "adaptive"),
    realPersonMode: booleanParameter(modelParameters.realPersonMode, true),
    conversionSlots: [conversionSlot],
    returnLastFrame: booleanParameter(modelParameters.returnLastFrame, false),
    seed:
      typeof modelParameters.seed === "number" &&
      Number.isInteger(modelParameters.seed)
        ? modelParameters.seed
        : -1,
  };
}

function runningHubImageEditBody(
  label: string,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  modelParameters: Record<string, unknown>,
  prompt: string,
  includeQuality: boolean,
  requireReferenceImages: boolean,
) {
  if (node.kind !== "image") {
    throw new Error(`${label} 仅支持图片节点`);
  }
  const references = onlyImageReferences(inputs, label);
  if (requireReferenceImages && !references.length) {
    throw new Error(`${label} 需要至少连接一张参考图片（支持 1-10 张）`);
  }
  if (!prompt.trim()) {
    throw new Error(`${label} 需要填写提示词（prompt）`);
  }
  return {
    prompt,
    // 无参考图时不携带 imageUrls，由调用方切换到文生图端点
    ...(references.length
      ? { imageUrls: references.slice(0, 10).map((reference) => reference.url) }
      : {}),
    aspectRatio: stringParameter(modelParameters.aspectRatio, "16:9"),
    resolution: stringParameter(modelParameters.resolution, "2k"),
    ...(includeQuality
      ? { quality: stringParameter(modelParameters.quality, "medium") }
      : {}),
  };
}

// 无参考图时，由图生图连接地址推导文生图端点
function runningHubTextToImageEndpoint(imageToImageEndpoint: string) {
  return imageToImageEndpoint
    .replace(/\/image-to-image\/?$/, "/text-to-image")
    .replace("rhart-image-g-2-official", "rhart-image-g-2");
}

function runningHubAsyncDescriptor(
  payload: unknown,
  queryEndpoint: string,
): AsyncJobDescriptor | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const externalJobId = stringField(nested, ["taskId", "task_id"]);
  if (!externalJobId) return undefined;
  const providerStatus = (
    stringField(nested, ["status", "state"]) ?? "running"
  ).toLowerCase();
  if (["succeeded", "success", "completed", "done"].includes(providerStatus)) {
    return undefined;
  }
  const pollUrl = `${queryEndpoint}?taskId=${encodeURIComponent(externalJobId)}`;
  validateExternalEndpoint(pollUrl);
  return {
    externalJobId,
    pollUrl,
    providerStatus,
    progress: numberField(nested, ["progress", "percent"]) ?? 5,
  };
}

export function executeBuiltin(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
): ExecutorResult {
  const role = roleForNode({ parameters: node.parameters });
  if (role === "material") {
    const assetUrl =
      typeof node.parameters?.assetContentUrl === "string"
        ? node.parameters.assetContentUrl
        : undefined;
    const assetId =
      typeof node.parameters?.assetId === "string"
        ? node.parameters.assetId
        : undefined;
    const result = assetUrl || node.prompt.trim()
      ? `素材“${node.title}”已就绪`
      : `素材“${node.title}”仍是空占位`;
    return {
      executor: "kernel.material-source",
      result,
      output: {
        type: node.kind,
        ...(node.kind === "text" ? { text: node.prompt } : {}),
        ...(assetUrl ? { assetUrl } : {}),
        data: {
          ...(assetId ? { assetId } : {}),
          assetUri: node.parameters?.assetUri ?? null,
          mimeType: node.parameters?.mimeType ?? null,
          name: node.parameters?.fileName ?? node.title,
          placeholder: !assetUrl && !node.prompt.trim(),
        },
        executor: "kernel.material-source",
        preview: true,
      },
    };
  }
  if (role === "result") {
    if (!inputs.length) {
      throw new Error("结果占位卡片没有连接上游节点");
    }
    const selectedInput = inputs.find((input) => hasResultValue(input.output));
    if (!selectedInput) {
      throw new Error("上游节点已完成，但没有返回可写入占位卡片的结果");
    }
    const upstream = selectedInput.output;
    const output = upstream as StoredKernelNodeOutput;
    const result =
      (typeof output.result === "string" && output.result.trim()) ||
      (typeof output.text === "string" && output.text.trim()) ||
      `已接收 ${inputs.length} 个上游结果`;
    return {
      executor: "kernel.result-slot",
      result,
      output: {
        type: output.type ?? node.kind,
        ...(output.text ? { text: output.text } : {}),
        ...(output.assetUrl ? { assetUrl: output.assetUrl } : {}),
        data: {
          sourceNodeIds: inputs.map((input) => input.nodeId),
          selectedSourceNodeId: selectedInput.nodeId,
          value:
            inputs.length === 1
              ? upstream
              : inputs.map((input) => input.output),
        },
        executor: "kernel.result-slot",
        preview: true,
      },
    };
  }
  const executor = "kernel.builtin-preview";
  const inputSummary = inputs.length
    ? `已接收 ${inputs.length} 个上游节点结果`
    : "这是根节点";
  const result =
    node.kind === "text"
      ? `【内核预览】${node.title}\n${node.prompt}\n\n${inputSummary}`
      : `内核已完成 ${node.title} 的输入编译；配置兼容的${{
          text: "文本",
          image: "图像",
          video: "视频",
          audio: "音频",
          document: "文档",
        }[node.kind]}模型后即可生成正式结果。`;
  return {
    executor,
    result,
    output: {
      type: node.kind,
      text: result,
      data: {
        prompt: executionPrompt(node, inputs),
        parameters: node.parameters ?? {},
      },
      executor,
      preview: true,
    },
  };
}

// ============ local-diffusion：本地扩散引擎执行器（回环直连、免 Key） ============
// 本地引擎并发队列：同一引擎端口 FIFO 深度上限 3，超出直接 LOCAL_ENGINE_BUSY
const LOCAL_DIFFUSION_QUEUE_DEPTH = 3;
const localDiffusionInFlight = new Map<string, number>();

function acquireLocalDiffusionSlot(baseUrl: string) {
  const current = localDiffusionInFlight.get(baseUrl) ?? 0;
  if (current >= LOCAL_DIFFUSION_QUEUE_DEPTH) {
    throw new ModelExecutionError("本地引擎正在生成中，请稍候重试", {
      status: 503,
      code: "LOCAL_ENGINE_BUSY",
    });
  }
  localDiffusionInFlight.set(baseUrl, current + 1);
}

function releaseLocalDiffusionSlot(baseUrl: string) {
  const current = localDiffusionInFlight.get(baseUrl) ?? 0;
  if (current <= 1) localDiffusionInFlight.delete(baseUrl);
  else localDiffusionInFlight.set(baseUrl, current - 1);
}

function localDiffusionTimeoutMs(kind: NodeKind) {
  return kind === "video" ? 20 * 60_000 : 5 * 60_000;
}

function localDiffusionParameters(parameters: Record<string, unknown> | undefined) {
  const picked: Record<string, unknown> = {};
  for (const key of [
    "width",
    "height",
    "steps",
    "guidanceScale",
    "cfgScale",
    "seed",
    "negativePrompt",
    "duration",
    "fps",
  ]) {
    const value = parameters?.[key];
    if (value === undefined || value === null || value === "") continue;
    picked[key] = value;
  }
  return picked;
}

function isLocalDiffusionModel(model: ModelRow) {
  if (model.protocol === "local-diffusion") return true;
  try {
    const ui = JSON.parse(model.uiSchemaJson || "{}") as Record<string, unknown>;
    return ui.provider === "local" && ui.engine === "diffusion";
  } catch {
    return false;
  }
}

function localBusyFailure(status: number, bodyText: string) {
  return (
    status === 429 ||
    status === 503 ||
    /busy|already generating|queue is full/i.test(bodyText)
  );
}

// 提取 b64_json / url（OpenAI 风格与 A1111 风格响应均可命中）
function localDiffusionArtifactBytes(payload: unknown): {
  b64?: string;
  url?: string;
} {
  let b64: string | undefined;
  let url: string | undefined;
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || (b64 && url)) return;
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === "string" && first.length > 64 && !/^https?:\/\//.test(first)) {
        b64 = first;
        return;
      }
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["b64_json", "b64", "image", "video", "video_b64_json", "data_base64"]) {
        if (typeof record[key] === "string" && (record[key] as string).length > 64) {
          b64 = record[key] as string;
          return;
        }
      }
      for (const key of ["url", "video_url", "output_url"]) {
        if (typeof record[key] === "string" && /^https?:\/\//.test(record[key] as string)) {
          url = record[key] as string;
          return;
        }
      }
      for (const value2 of Object.values(record)) visit(value2, depth + 1);
    }
  };
  visit(payload, 0);
  return { b64, url };
}

// 回环 fetch 封装：本地引擎是既定通道，不走 fetchExternalEndpoint 的外网端点校验
async function fetchLocalDiffusion(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (error) {
    const aborted = signal?.aborted || controller.signal.aborted;
    throw new ModelExecutionError(
      aborted
        ? "本地引擎生成超时，可尝试降低分辨率/步数后重试"
        : "无法连接本地扩散引擎，请在设置页确认引擎已启动",
      {
        status: aborted ? 504 : 502,
        code: aborted ? "PROVIDER_TIMEOUT" : "LOCAL_ENGINE_UNREACHABLE",
      },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 端点协商缓存：sd-server 真实 API 以拿到二进制探测为准（先 OpenAI 风格，回退 A1111）
const localDiffusionStyleCache = new Map<string, "openai" | "a1111">();

async function postLocalDiffusionJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ payload: unknown; status: number }> {
  const response = await fetchLocalDiffusion(
    baseUrl + path,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  );
  const bodyText = await response.text();
  if (!response.ok) {
    if (localBusyFailure(response.status, bodyText)) {
      throw new ModelExecutionError("本地引擎正在生成中，请稍候重试", {
        status: 503,
        code: "LOCAL_ENGINE_BUSY",
      });
    }
    throw new ModelExecutionError(
      "本地扩散引擎返回失败（HTTP " + response.status + "）：" + bodyText.slice(0, 300),
      { status: response.status, code: "HTTP_" + response.status },
    );
  }
  try {
    return { payload: JSON.parse(bodyText) as unknown, status: response.status };
  } catch {
    throw new ModelExecutionError("本地扩散引擎返回了非 JSON 响应", {
      status: 502,
      code: "LOCAL_ENGINE_BAD_RESPONSE",
    });
  }
}

async function executeLocalDiffusionModel(
  model: ModelRow,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  signal?: AbortSignal,
  context?: ModelExecutionContext,
): Promise<ExecutorResult> {
  if (node.kind !== "image" && node.kind !== "video") {
    throw new ModelExecutionError("本地扩散引擎仅支持图片/视频节点", {
      status: 400,
      code: "MODEL_INPUT_FORMAT_UNSUPPORTED",
    });
  }
  if (modelInputAssetReferences(inputs).length) {
    throw new ModelExecutionError(
      "本地扩散引擎当前仅支持文生图/文生视频，暂不接受参考素材输入",
      { status: 400, code: "MODEL_INPUT_FORMAT_UNSUPPORTED" },
    );
  }
  const baseUrl = (model.baseUrl || "").replace(/\/+$/, "");
  const prompt = executionPrompt(node, inputs);
  const params = localDiffusionParameters(node.parameters);
  const timeoutMs = localDiffusionTimeoutMs(node.kind);
  acquireLocalDiffusionSlot(baseUrl);
  try {
    const cachedStyle = localDiffusionStyleCache.get(baseUrl);
    let payload: unknown;
    if (node.kind === "image") {
      const openAiBody = {
        model: model.modelName,
        prompt,
        n: 1,
        response_format: "b64_json",
        ...params,
      };
      const a1111Body = {
        prompt,
        negative_prompt: params.negativePrompt,
        steps: params.steps,
        width: params.width,
        height: params.height,
        cfg_scale: params.cfgScale ?? params.guidanceScale,
        seed: params.seed,
      };
      if (cachedStyle === "a1111") {
        ({ payload } = await postLocalDiffusionJson(
          baseUrl,
          "/sdapi/v1/txt2img",
          a1111Body,
          timeoutMs,
          signal,
        ));
      } else {
        const attempt = await postLocalDiffusionJson(
          baseUrl,
          "/v1/images/generations",
          openAiBody,
          timeoutMs,
          signal,
        ).catch((error) =>
          error instanceof ModelExecutionError && /^HTTP_404$/.test(error.code)
            ? null
            : Promise.reject(error),
        );
        if (attempt) {
          payload = attempt.payload;
          localDiffusionStyleCache.set(baseUrl, "openai");
        } else {
          ({ payload } = await postLocalDiffusionJson(
            baseUrl,
            "/sdapi/v1/txt2img",
            a1111Body,
            timeoutMs,
            signal,
          ));
          localDiffusionStyleCache.set(baseUrl, "a1111");
        }
      }
    } else {
      ({ payload } = await postLocalDiffusionJson(
        baseUrl,
        "/v1/videos",
        { model: model.modelName, prompt, ...params },
        timeoutMs,
        signal,
      ));
    }
    const artifact = localDiffusionArtifactBytes(payload);
    if (!artifact.b64 && !artifact.url) {
      throw new ModelExecutionError("本地扩散引擎未返回可用的图片/视频数据", {
        status: 502,
        code: "LOCAL_ENGINE_BAD_RESPONSE",
      });
    }
    let bytes: ArrayBuffer;
    let contentType: string | null = null;
    if (artifact.b64) {
      const raw = artifact.b64.replace(/^data:[^;]+;base64,/, "");
      const binary = atob(raw);
      const view = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i);
      bytes = view.buffer;
    } else {
      const response = await fetchLocalDiffusion(
        artifact.url as string,
        { method: "GET" },
        120_000,
        signal,
      );
      if (!response.ok) {
        throw new ModelExecutionError(
          "无法读取本地引擎产物：HTTP " + response.status,
          { status: 502, code: "LOCAL_ENGINE_BAD_RESPONSE" },
        );
      }
      contentType = response.headers.get("content-type");
      bytes = await readResponseBytesLimited(response, 512 * 1024 * 1024);
    }
    const mimeType = artifactFormat(node.kind, contentType).mimeType;
    const db = await getDb();
    const asset = await storeAsset(db, await getFileBucket(), {
      workspaceId: context?.workspaceId ?? model.workspaceId,
      name: artifactName(node.title, node.kind, mimeType),
      mimeType,
      bytes,
      tags: [node.kind, "AI 生成", "本地模型"],
      description: prompt.slice(0, 500),
      sourceType: "kernel-output",
      sourceRef: "model:" + model.id,
      metadata: { executor: "local-diffusion", localModelId: model.modelName },
    });
    const executor = "local-diffusion:" + model.id;
    return {
      executor,
      result: (node.kind === "video" ? "视频" : "图像") + "结果已生成",
      output: {
        type: node.kind,
        assetUrl: asset.contentUrl,
        data: { assetId: asset.id, assetUri: asset.uri },
        executor,
      },
    };
  } finally {
    releaseLocalDiffusionSlot(baseUrl);
  }
}

export async function executeModel(
  model: ModelRow,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  signal?: AbortSignal,
  context?: ModelExecutionContext,
): Promise<ExecutorResult> {
  const modelParameters = modelExecutionParameters(node.parameters);
  const inputConstraints = parseModelInputConstraints(
    model.inputConstraintsJson,
    node.kind,
    model.protocol,
  );
  node = {
    ...node,
    parameters: capabilityExecutionParameters(node.parameters),
  };
  // 本地扩散引擎：回环是本地引擎既定通道（豁免外网端点校验），免 API Key
  if (isLocalDiffusionModel(model)) {
    return executeLocalDiffusionModel(model, node, inputs, signal, context);
  }
  const endpoint = validateExternalEndpoint(model.baseUrl);
  const credential = (await modelCredential(model))?.trim();
  if (!credential) {
    throw new ModelExecutionError(
      `模型“${model.name}”尚未配置 API Key，请前往“设置 → API Key”编辑该模型并保存密钥`,
      {
        status: 401,
        code: "MODEL_CREDENTIAL_MISSING",
      },
    );
  }
  const providerInputs = await providerReadyInputs(inputs, context);
  const headers = credentialHeaders(model, credential);
  const prompt = executionPrompt(node, inputs);
  const base = endpoint.toString();
  let url = base;
  let body: Record<string, unknown>;

  if (model.protocol === "runninghub-rh-image-2") {
    body = runningHubImageEditBody(
      "RH-image-2",
      node,
      providerInputs,
      modelParameters,
      prompt,
      true,
      false,
    );
    // 未连接参考图时自动从图生图切换为文生图
    if (!("imageUrls" in body)) {
      url = runningHubTextToImageEndpoint(base);
    }
  } else if (model.protocol === "runninghub-nano-banana-2") {
    body = runningHubImageEditBody(
      "RH-banana-2",
      node,
      providerInputs,
      modelParameters,
      prompt,
      false,
      false,
    );
    // 未连接参考图时自动从图生图切换为文生图
    if (!("imageUrls" in body)) {
      url = runningHubTextToImageEndpoint(base);
    }
  } else if (isRunningHubVideoProtocol(model.protocol)) {
    body =
      model.protocol === "runninghub-minimax-h3"
        ? runningHubMinimaxH3Body(
            node,
            providerInputs,
            modelParameters,
            prompt,
            inputConstraints,
          )
        : model.protocol === "runninghub-seedance"
          ? runningHubSeedanceBody(
              node,
              providerInputs,
              modelParameters,
              prompt,
              inputConstraints,
            )
        : model.protocol === "runninghub-sparkvideo-mini-multimodal" ||
            model.protocol === "runninghub-sparkvideo-multimodal"
          ? runningHubSparkVideoMultimodalBody(
              node,
              providerInputs,
              modelParameters,
              prompt,
              inputConstraints,
            )
        : runningHubVideoBody(node, providerInputs, modelParameters, prompt);
  } else if (model.protocol === "runninghub-suno-v5") {
    body = runningHubSunoBody(
      node,
      modelParameters,
      sunoLyricsPrompt(node, inputs),
    );
  } else if (model.protocol === "generic-rest" || model.protocol === "async-video") {
    body = {
      ...modelParameters,
      model: model.modelName,
      node,
      inputs: providerInputs,
      prompt,
    };
  } else if (model.protocol === "gemini") {
    if (node.kind !== "text" && node.kind !== "image") {
      throw new Error("Gemini 连接当前仅支持文本或图片节点");
    }
    url = resolveModelApiEndpoint(base);
    if (node.kind === "image") {
      const aspectRatio =
        typeof modelParameters.aspectRatio === "string"
          ? modelParameters.aspectRatio
          : "16:9";
      const imageSize =
        typeof modelParameters.imageSize === "string"
          ? modelParameters.imageSize
          : "4K";
      body = {
        contents: [
          { role: "user", parts: geminiInputParts(prompt, providerInputs) },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio, imageSize },
        },
      };
    } else {
      body = {
        ...modelParameters,
        contents: [
          { role: "user", parts: geminiInputParts(prompt, providerInputs) },
        ],
      };
    }
  } else if (model.protocol === "anthropic-compatible") {
    if (node.kind !== "text") {
      throw new Error("原生 Claude 格式连接当前只支持文本节点");
    }
    url = resolveModelApiEndpoint(base);
    body = {
      ...modelParameters,
      max_tokens: 4096,
      model: model.modelName,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (model.protocol === "openai-responses") {
    if (node.kind !== "text") {
      throw new Error("OpenAI Responses 格式连接当前只支持文本节点");
    }
    url = resolveModelApiEndpoint(base);
    body = {
      ...modelParameters,
      model: model.modelName,
      input: openAIResponsesInput(prompt, providerInputs),
    };
  } else if (node.kind === "text") {
    url = resolveModelApiEndpoint(base);
    body = {
      ...modelParameters,
      model: model.modelName,
      messages: [
        { role: "user", content: openAIChatContent(prompt, providerInputs) },
      ],
    };
  } else if (node.kind === "image") {
    url = resolveModelApiEndpoint(base);
    if (modelEndpointKind(url) === "chat-completions") {
      body = {
        ...modelParameters,
        model:
          model.modelName ||
          (model.protocol === "dall-e-3" ? "dall-e-3" : ""),
        messages: [
          {
            role: "user",
            content: openAIChatContent(prompt, providerInputs),
          },
        ],
      };
    } else {
      if (modelInputAssetReferences(providerInputs).length) {
        throw new ModelExecutionError(
          "当前图片生成接口不支持参考素材；请改用支持多模态输入的完整接口地址",
          {
            status: 400,
            code: "MODEL_INPUT_FORMAT_UNSUPPORTED",
          },
        );
      }
      body = {
        ...modelParameters,
        ...(model.protocol === "dall-e-3" ? { n: 1 } : {}),
        model:
          model.modelName ||
          (model.protocol === "dall-e-3" ? "dall-e-3" : ""),
        prompt,
      };
    }
  } else if (node.kind === "video") {
    url = resolveModelApiEndpoint(base);
    body = {
      ...modelParameters,
      model: model.modelName,
      prompt,
    };
  } else {
    throw new Error(
      `${node.kind === "audio" ? "音频" : "文档"}节点请使用通用 REST 或对应 Provider Package`,
    );
  }

  const payload = await fetchJson(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    },
    60_000,
    model.protocol === "dall-e-3" ||
      (model.protocol === "gemini" && node.kind === "image")
      ? 25 * 1024 * 1024
      : 2 * 1024 * 1024,
  );
  if (isRunningHubProtocol(model.protocol)) {
    assertRunningHubBusinessSuccess(payload);
  }
  const execution = normalizeRemoteOutput(payload, node, `model:${model.id}`);
  const asyncJob = isRunningHubProtocol(model.protocol)
    ? runningHubAsyncDescriptor(payload, runningHubQueryEndpoint(model.protocol))
    : model.protocol === "async-video"
      ? asyncDescriptor(payload, base)
      : undefined;
  return asyncJob ? { ...execution, asyncJob } : execution;
}

export async function pollModelJob(
  model: ModelRow,
  node: KernelNodeRequest,
  pollUrl: string,
  signal?: AbortSignal,
) {
  validateExternalEndpoint(pollUrl);
  const credential = await modelCredential(model);
  const runningHub = isRunningHubProtocol(model.protocol);
  const pollEndpoint = new URL(pollUrl);
  const taskId = pollEndpoint.searchParams.get("taskId");
  if (runningHub) pollEndpoint.search = "";
  const payload = await fetchJson(
    pollEndpoint.toString(),
    {
      method: runningHub ? "POST" : "GET",
      headers: credentialHeaders(model, credential),
      ...(runningHub ? { body: JSON.stringify({ taskId }) } : {}),
      signal,
    },
    30_000,
  );
  if (runningHub) assertRunningHubBusinessSuccess(payload);
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const providerStatus = (
    stringField(nested, ["status", "state"]) ?? "running"
  ).toLowerCase();
  const progress = numberField(nested, ["progress", "percent"]) ?? 20;
  if (["failed", "error", "canceled", "cancelled"].includes(providerStatus)) {
    throw new ModelExecutionError(
      stringField(nested, ["error", "message", "errorMessage", "failedReason"]) ??
        `异步任务状态：${providerStatus}`,
      { status: 502, code: "ASYNC_JOB_FAILED" },
    );
  }
  const execution = normalizeRemoteOutput(
    payload,
    node,
    `model:${model.id}`,
  );
  const complete =
    ["succeeded", "success", "completed", "done"].includes(providerStatus) ||
    Boolean(execution.output.assetUrl);
  return {
    complete,
    providerStatus,
    progress: complete ? 100 : progress,
    execution,
  };
}

export async function cancelModelJob(
  model: ModelRow,
  cancelUrl: string,
  signal?: AbortSignal,
) {
  validateExternalEndpoint(cancelUrl);
  const credential = await modelCredential(model);
  await fetchJson(
    cancelUrl,
    {
      method: "DELETE",
      headers: credentialHeaders(model, credential),
      signal,
    },
    20_000,
  );
}

export async function executeRemotePackage(
  pkg: PackageRow,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  signal?: AbortSignal,
): Promise<ExecutorResult> {
  node = {
    ...node,
    parameters: capabilityExecutionParameters(node.parameters),
  };
  const allowedTrustStates = packageSignaturesRequired()
    ? ["trusted"]
    : ["trusted", "reviewed"];
  if (!allowedTrustStates.includes(pkg.trustState)) {
    throw new Error("该插件尚未通过 Package 信任审核");
  }
  if (pkg.runtimeType !== "remote-api" || !pkg.runtimeUrl) {
    throw new Error("该插件没有可执行的远程 Runtime");
  }
  const manifest = JSON.parse(pkg.manifestJson) as XiaoLuoPackageManifest;
  const endpoint = new URL(
    manifest.runtime.invokePath ?? "/invoke",
    `${pkg.runtimeUrl.replace(/\/+$/, "")}/`,
  );
  validateExternalEndpoint(endpoint.toString());
  const permissions = JSON.parse(pkg.permissionsJson) as string[];
  if (!permissions.includes(`network:${endpoint.origin}`)) {
    throw new Error("插件没有目标域名的网络权限");
  }
  const payload = await fetchJson(endpoint.toString(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      operation: "executeNode",
      input: { node, upstream: inputs },
      context: { packageId: pkg.id, packageVersion: pkg.version },
    }),
    signal,
  });
  return normalizeRemoteOutput(payload, node, `plugin:${pkg.id}`);
}

export async function executeIsolatedPackage(
  pkg: PackageRow,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
): Promise<ExecutorResult> {
  if (pkg.runtimeType !== "isolated-worker") {
    throw new Error("该插件不是 isolated-worker 运行时");
  }
  if (pkg.trustState !== "trusted") {
    throw new Error("隔离 Worker 只执行可信签名插件");
  }
  const manifest = JSON.parse(pkg.manifestJson) as XiaoLuoPackageManifest;
  const runtime = manifest.runtime.language as IsolatedRuntime | undefined;
  if (
    !runtime ||
    !["node", "python", "cli"].includes(runtime) ||
    !manifest.runtime.entry
  ) {
    throw new Error("插件未声明有效的隔离运行语言或入口");
  }
  const permissions = JSON.parse(pkg.permissionsJson) as string[];
  const networkOrigins = permissions
    .filter((permission) => permission.startsWith("network:https://"))
    .map((permission) => permission.slice(8));
  const policy = isolatedExecutionPolicy(networkOrigins);
  const args = Array.isArray(node.parameters?.args)
    ? node.parameters.args
        .filter((item): item is string => typeof item === "string")
        .slice(0, 100)
    : [];
  const secretRefIds = Array.isArray(node.parameters?.secretRefIds)
    ? node.parameters.secretRefIds
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            /^secret_[A-Za-z0-9-]+$/.test(item),
        )
        .slice(0, 20)
    : [];
  const submitted = await submitIsolatedExecution({
    jobId: `kernel_plugin_${crypto.randomUUID()}`,
    package: {
      id: pkg.id,
      key: pkg.packageKey,
      version: pkg.version,
      integritySha256: pkg.integritySha256,
      entry: manifest.runtime.entry,
    },
    runtime,
    args,
    stdin: JSON.stringify({
      operation: "executeNode",
      node,
      upstream: inputs,
    }).slice(0, 100_000),
    secretRefIds,
    policy,
  });
  let result = submitted;
  const deadline = Date.now() + policy.wallTimeMs;
  while (
    !["succeeded", "failed", "canceled"].includes(result.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    result = await inspectIsolatedExecution(result.executionId);
  }
  if (result.status !== "succeeded") {
    throw new Error(
      result.status === "failed"
        ? result.stderr || "隔离插件执行失败"
        : result.status === "canceled"
          ? "隔离插件执行已取消"
          : "隔离插件执行超时",
    );
  }
  const payload =
    result.output ??
    (result.stdout
      ? { text: result.stdout }
      : { exitCode: result.exitCode });
  return normalizeRemoteOutput(payload, node, `plugin:${pkg.id}:isolated`);
}
