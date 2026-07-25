import type { ModelProtocol, NodeKind } from "../types";

export interface ModelAdapterConfig {
  protocol: ModelProtocol;
  baseUrl: string;
  modelName: string;
  modalities: NodeKind[];
  credential?: string;
}

export interface AdapterProbeResult {
  ok: boolean;
  state: "healthy" | "attention";
  latencyMs: number;
  message: string;
  discoveredModels?: string[];
  catalog?: AdapterModelDescriptor[];
}

export interface AdapterModelDescriptor {
  id: string;
  displayName: string;
  modalities: NodeKind[];
  metadata: Record<string, unknown>;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function validateExternalEndpoint(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("端点地址格式无效");
  }
  const host = url.hostname.toLowerCase();
  const isLocalDev =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(host);
  if (url.protocol !== "https:" && !isLocalDev) {
    throw new Error("生产环境只允许 HTTPS 端点");
  }
  if (
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    throw new Error("不允许访问回环、链路本地或私有网络地址");
  }
  return url;
}

function requestFor(config: ModelAdapterConfig) {
  const baseUrl = trimSlash(validateExternalEndpoint(config.baseUrl).toString());
  const headers = new Headers({ accept: "application/json" });
  if (config.credential) {
    if (config.protocol === "gemini") {
      headers.set("x-goog-api-key", config.credential);
    } else if (config.protocol === "anthropic-compatible") {
      headers.set("x-api-key", config.credential);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${config.credential}`);
    }
  }

  if (
    config.protocol === "generic-rest" ||
    config.protocol === "async-video"
  ) {
    return new Request(baseUrl, { method: "HEAD", headers });
  }
  return new Request(`${baseUrl}/models`, { method: "GET", headers });
}

function inferredModalities(
  id: string,
  methods: string[] = [],
  configured: NodeKind[] = [],
) {
  const value = `${id} ${methods.join(" ")}`.toLowerCase();
  const result = new Set<NodeKind>();
  if (/image|imagen|flux|dall-e|stable-diffusion/.test(value)) {
    result.add("image");
  }
  if (/video|veo|sora|kling|wan|seedance/.test(value)) {
    result.add("video");
  }
  if (/audio|speech|voice|tts|music/.test(value)) {
    result.add("audio");
  }
  if (/document|office|pdf|ppt|docx|xlsx/.test(value)) {
    result.add("document");
  }
  if (
    /chat|text|language|completion|generatecontent|claude|gpt|gemini|deepseek|qwen/.test(
      value,
    )
  ) {
    result.add("text");
  }
  configured.forEach((item) => result.add(item));
  return [...result];
}

function catalogFromPayload(
  payload: unknown,
  config: ModelAdapterConfig,
): AdapterModelDescriptor[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return candidates
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const model = item as Record<string, unknown>;
      const rawId =
        typeof model.id === "string"
          ? model.id
          : typeof model.name === "string"
            ? model.name.replace(/^models\//, "")
            : "";
      if (!rawId) return [];
      const methods = Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return [
        {
          id: rawId.slice(0, 240),
          displayName:
            (typeof model.displayName === "string"
              ? model.displayName
              : typeof model.name === "string"
                ? model.name
                : rawId
            ).slice(0, 240),
          modalities: inferredModalities(rawId, methods, config.modalities),
          metadata: {
            ...(methods.length
              ? { supportedGenerationMethods: methods }
              : {}),
            ...(typeof model.owned_by === "string"
              ? { ownedBy: model.owned_by }
              : {}),
          },
        },
      ];
    })
    .slice(0, 500);
}

export async function probeModelAdapter(
  config: ModelAdapterConfig,
): Promise<AdapterProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const response = await fetch(requestFor(config), {
      signal: controller.signal,
      redirect: "error",
    });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      let discoveredModels: string[] | undefined;
      let catalog: AdapterModelDescriptor[] | undefined;
      if (
        config.protocol !== "generic-rest" &&
        config.protocol !== "async-video"
      ) {
        const payload = await response.json().catch(() => null);
        catalog = catalogFromPayload(payload, config);
        discoveredModels = catalog.map((item) => item.id);
      }
      return {
        ok: true,
        state: "healthy",
        latencyMs,
        message: "连接成功，Adapter 已就绪",
        discoveredModels,
        catalog,
      };
    }
    return {
      ok: false,
      state: "attention",
      latencyMs,
      message:
        response.status === 401 || response.status === 403
          ? "端点可达，但凭据引用尚未配置或无权访问"
          : `端点返回 HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      state: "attention",
      latencyMs: Date.now() - startedAt,
      message:
        error instanceof Error && error.name === "AbortError"
          ? "连接超时"
          : error instanceof Error
            ? error.message
            : "连接失败",
    };
  } finally {
    clearTimeout(timeout);
  }
}
