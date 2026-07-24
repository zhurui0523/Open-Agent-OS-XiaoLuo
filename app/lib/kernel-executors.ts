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
import { validateExternalEndpoint } from "./model-adapters";
import { resolveSecret } from "./secret-vault";

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
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "error" in payload
          ? JSON.stringify(payload.error)
          : `HTTP ${response.status}`;
      throw new Error(`执行器返回失败：${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", abortFromSource);
  }
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
  const result =
    text ??
    (assetUrl
      ? `${node.kind === "video" ? "视频" : "图像"}结果已生成`
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
      : `内核已完成 ${node.title} 的输入编译；配置兼容的${node.kind === "image" ? "图像" : "视频"}模型后即可生成正式结果。`;
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
  const credential = model.secretRefId
    ? await resolveSecret(model.secretRefId, model.workspaceId)
    : model.credentialRef
      ? process.env[model.credentialRef]
      : undefined;
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
  } else {
    url = `${base}/videos`;
    body = {
      model: model.modelName,
      prompt,
      ...node.parameters,
    };
  }

  const payload = await fetchJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  return normalizeRemoteOutput(payload, node, `model:${model.id}`);
}

export async function executeRemotePackage(
  pkg: PackageRow,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  signal?: AbortSignal,
): Promise<ExecutorResult> {
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
