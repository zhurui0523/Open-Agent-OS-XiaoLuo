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
import { externalAssetAccessUrl } from "./asset-kernel";
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
  throw new ModelExecutionError(
    errorMessage || `RunningHub 任务失败${errorCode ? `（${errorCode}）` : ""}`,
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
    protocol === "runninghub-sparkvideo-mini" ||
    protocol === "runninghub-sparkvideo-mini-multimodal" ||
    protocol === "runninghub-sparkvideo" ||
    protocol === "runninghub-sparkvideo-multimodal" ||
    protocol === "runninghub-minimax-h3"
  );
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

function runningHubAsyncDescriptor(
  payload: unknown,
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
  const pollUrl = `https://www.runninghub.cn/openapi/v2/query?taskId=${encodeURIComponent(externalJobId)}`;
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

  if (isRunningHubVideoProtocol(model.protocol)) {
    body =
      model.protocol === "runninghub-minimax-h3"
        ? runningHubMinimaxH3Body(
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
  if (isRunningHubVideoProtocol(model.protocol)) {
    assertRunningHubBusinessSuccess(payload);
  }
  const execution = normalizeRemoteOutput(payload, node, `model:${model.id}`);
  const asyncJob = isRunningHubVideoProtocol(model.protocol)
    ? runningHubAsyncDescriptor(payload)
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
  const runningHub = isRunningHubVideoProtocol(model.protocol);
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
