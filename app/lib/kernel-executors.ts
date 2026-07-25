import type {
  KernelNodeOutput,
  KernelUpstreamInput,
  NodeKind,
} from "../types";
import type {
  modelConnections,
  packages,
} from "../../db/schema";
import type { XiaoLuoPackageManifest } from "./package-contract";
import {
  fetchExternalEndpoint,
  readResponseJsonLimited,
  validateExternalEndpoint,
} from "./model-adapters";
import { resolveSecret } from "./secret-vault";
import { packageSignaturesRequired } from "./server-runtime-config";

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

function executionPrompt(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
) {
  return [
    `任务：${node.title}`,
    `要求：${node.prompt}`,
    `输出模态：${node.kind}`,
    `参数：${JSON.stringify(node.parameters ?? {})}`,
    `上游结果：\n${upstreamText(inputs)}`,
  ].join("\n\n");
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const sourceSignal = init.signal;
  const abortFromSource = () => controller.abort();
  sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  try {
    const response = await fetchExternalEndpoint(url, {
      ...init,
      signal: controller.signal,
    }, timeoutMs);
    const payload = await readResponseJsonLimited(response).catch(() => null);
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
    if (model.protocol === "gemini") {
      headers.set("x-goog-api-key", credential);
    } else if (model.protocol === "anthropic-compatible") {
      headers.set("x-api-key", credential);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${credential}`);
    }
  }
  return headers;
}

async function modelCredential(model: ModelRow) {
  return model.secretRefId
    ? resolveSecret(model.secretRefId, model.workspaceId)
    : model.credentialRef
      ? process.env[model.credentialRef]
      : undefined;
}

function assetUrlFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["assetUrl", "url", "video_url", "image_url"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      const found = assetUrlFrom(item);
      if (found) return found;
    }
  }
  if (record.output) return assetUrlFrom(record.output);
  return undefined;
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.result === "string") return record.result;
  if (typeof record.output_text === "string") return record.output_text;
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as
      | { message?: { content?: string }; text?: string }
      | undefined;
    if (typeof first?.message?.content === "string") {
      return first.message.content;
    }
    if (typeof first?.text === "string") return first.text;
  }
  const candidates = record.candidates;
  if (Array.isArray(candidates)) {
    const parts = (
      candidates[0] as { content?: { parts?: Array<{ text?: string }> } }
    )?.content?.parts;
    const joined = parts
      ?.map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const joined = content
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? String((item as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }
  if (record.output) return textFrom(record.output);
  return undefined;
}

function normalizeRemoteOutput(
  payload: unknown,
  node: KernelNodeRequest,
  executor: string,
): ExecutorResult {
  const assetUrl = assetUrlFrom(payload);
  const text = textFrom(payload);
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

export function executeBuiltin(
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
): ExecutorResult {
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
): Promise<ExecutorResult> {
  const endpoint = validateExternalEndpoint(model.baseUrl);
  const credential = await modelCredential(model);
  const headers = credentialHeaders(model, credential);
  const prompt = executionPrompt(node, inputs);
  const base = endpoint.toString().replace(/\/+$/, "");
  let url = base;
  let body: Record<string, unknown>;

  if (model.protocol === "generic-rest" || model.protocol === "async-video") {
    body = { model: model.modelName, node, inputs, prompt };
  } else if (model.protocol === "gemini") {
    if (node.kind !== "text") {
      throw new Error("Gemini 连接当前仅支持文本节点");
    }
    url = `${base}/models/${encodeURIComponent(model.modelName)}:generateContent`;
    body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };
  } else if (model.protocol === "anthropic-compatible") {
    if (node.kind !== "text") {
      throw new Error("Anthropic 兼容连接当前只支持文本节点");
    }
    url = `${base}/messages`;
    body = {
      model: model.modelName,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (node.kind === "text") {
    url = `${base}/chat/completions`;
    body = {
      model: model.modelName,
      messages: [{ role: "user", content: prompt }],
    };
  } else if (node.kind === "image") {
    url = `${base}/images/generations`;
    body = {
      model: model.modelName,
      prompt,
      ...node.parameters,
    };
  } else if (node.kind === "video") {
    url = `${base}/videos`;
    body = {
      model: model.modelName,
      prompt,
      ...node.parameters,
    };
  } else {
    throw new Error(
      `${node.kind === "audio" ? "音频" : "文档"}节点请使用通用 REST 或对应 Provider Package`,
    );
  }

  const payload = await fetchJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const execution = normalizeRemoteOutput(payload, node, `model:${model.id}`);
  const asyncJob =
    model.protocol === "async-video"
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
  const payload = await fetchJson(
    pollUrl,
    {
      method: "GET",
      headers: credentialHeaders(model, credential),
      signal,
    },
    30_000,
  );
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
      stringField(nested, ["error", "message"]) ??
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
