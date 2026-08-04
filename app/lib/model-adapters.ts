import type { ModelProtocol, NodeKind } from "../types";
import {
  modelEndpointKind,
  resolveModelApiEndpoint,
} from "./model-endpoints.ts";

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

function ipv4Parts(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

function isNonPublicIpv4(host: string) {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isNonPublicIpv6(host: string) {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  const mappedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isNonPublicIpv4(mappedIpv4);
  const first = normalized.split(":")[0] || "0";
  const firstBlock = Number.parseInt(first, 16);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fe90:") ||
    normalized.startsWith("fea0:") ||
    normalized.startsWith("feb0:") ||
    normalized.startsWith("2001:db8:") ||
    (Number.isFinite(firstBlock) && firstBlock >= 0xfc00 && firstBlock <= 0xfdff) ||
    (Number.isFinite(firstBlock) && firstBlock >= 0xff00)
  );
}

function allowedProductionPorts() {
  const configured =
    process.env.EXTERNAL_API_ALLOWED_PORTS?.split(",")
      .map((value) => Number(value.trim()))
      .filter(
        (value) => Number.isInteger(value) && value >= 1 && value <= 65535,
      ) ?? [];
  return new Set(configured.length ? configured : [443]);
}

export function validateExternalEndpoint(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("端点地址格式无效");
  }
  const host = url.hostname.toLowerCase();
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  const isLocalDev =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(host);
  if (url.protocol !== "https:" && !isLocalDev) {
    throw new Error("生产环境只允许 HTTPS 端点");
  }
  if (
    url.username ||
    url.password ||
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".internal") ||
    normalizedHost.endsWith(".home.arpa") ||
    normalizedHost === "metadata.google.internal" ||
    normalizedHost === "metadata.azure.internal" ||
    isNonPublicIpv4(normalizedHost) ||
    isNonPublicIpv6(normalizedHost)
  ) {
    throw new Error("不允许访问回环、链路本地或私有网络地址");
  }
  if (
    process.env.NODE_ENV === "production" &&
    !allowedProductionPorts().has(Number(url.port || 443))
  ) {
    throw new Error("端点端口不在服务器出站访问白名单内");
  }
  return url;
}

export async function fetchExternalEndpoint(
  raw: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
) {
  const url = validateExternalEndpoint(raw.toString());
  const timeoutSignal = AbortSignal.timeout(
    Math.max(1_000, Math.min(timeoutMs, 120_000)),
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // Cloudflare Workers supports "follow" and "manual", but rejects
      // "error" before sending the request. Manual mode keeps the original
      // no-redirect security policy enforceable across Node and workerd.
      redirect: "manual",
      signal,
    });
  } catch (error) {
    const aborted = signal.aborted;
    const message = aborted
      ? `远程模型服务请求已取消或超时（${url.host}）`
      : `无法连接远程模型服务（${url.host}），请检查接口地址、服务器网络或服务状态`;
    throw new Error(message, { cause: error });
  }
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`远程端点不允许重定向（HTTP ${response.status || "3xx"}）`);
  }
  return response;
}

export async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
) {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error(`远程响应超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB 限制`);
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new Error(
          `远程响应超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB 限制`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

export async function readResponseJsonLimited(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
) {
  const bytes = await readResponseBytesLimited(response, maxBytes);
  if (!bytes.byteLength) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function modelAdapterProbeRequest(config: ModelAdapterConfig) {
  const baseUrl = validateExternalEndpoint(config.baseUrl).toString();
  const headers = new Headers({ accept: "application/json" });
  if (config.credential) {
    if (config.protocol === "anthropic-compatible") {
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
  if (
    config.protocol === "runninghub-sparkvideo-mini" ||
    config.protocol === "runninghub-sparkvideo-mini-multimodal" ||
    config.protocol === "runninghub-sparkvideo" ||
    config.protocol === "runninghub-sparkvideo-multimodal" ||
    config.protocol === "runninghub-minimax-h3"
  ) {
    headers.set("content-type", "application/json");
    return new Request("https://www.runninghub.cn/openapi/v2/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: "0" }),
    });
  }
  if (config.protocol === "anthropic-compatible") {
    headers.set("content-type", "application/json");
    return new Request(resolveModelApiEndpoint(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.modelName,
        max_tokens: 1,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
  }
  if (config.protocol === "openai-responses") {
    headers.set("content-type", "application/json");
    return new Request(resolveModelApiEndpoint(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.modelName,
        input: "Hi",
        max_output_tokens: 1,
      }),
    });
  }
  if (config.protocol === "dall-e-3") {
    headers.set("content-type", "application/json");
    const endpoint = resolveModelApiEndpoint(baseUrl);
    const body =
      modelEndpointKind(endpoint) === "chat-completions"
        ? {
            model: config.modelName || "dall-e-3",
            messages: [
              {
                role: "user",
                content: "A simple white circle on a black background",
              },
            ],
          }
        : {
            model: config.modelName || "dall-e-3",
            prompt: "A simple white circle on a black background",
            n: 1,
            size: "1024x1024",
          };
    return new Request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
  if (config.protocol === "gemini" && config.modalities.includes("image")) {
    headers.set("content-type", "application/json");
    return new Request(resolveModelApiEndpoint(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Draw a simple white circle" }] },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
        },
      }),
    });
  }
  const endpoint = resolveModelApiEndpoint(baseUrl);
  if (modelEndpointKind(endpoint) === "chat-completions") {
    headers.set("content-type", "application/json");
    return new Request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.modelName,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }),
    });
  }
  return new Request(endpoint, {
    method: "GET",
    headers,
  });
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
    const request = modelAdapterProbeRequest(config);
    const response = await fetchExternalEndpoint(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        signal: controller.signal,
      },
      8_000,
    );
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      let discoveredModels: string[] | undefined;
      let catalog: AdapterModelDescriptor[] | undefined;
      if (
        config.protocol !== "generic-rest" &&
        config.protocol !== "async-video" &&
        config.protocol !== "dall-e-3" &&
        config.protocol !== "runninghub-sparkvideo-mini" &&
        config.protocol !== "runninghub-sparkvideo-mini-multimodal" &&
        config.protocol !== "runninghub-sparkvideo" &&
        config.protocol !== "runninghub-sparkvideo-multimodal" &&
        config.protocol !== "runninghub-minimax-h3" &&
        !(config.protocol === "gemini" && config.modalities.includes("image"))
      ) {
        const payload = await readResponseJsonLimited(response).catch(() => null);
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
    const failurePayload = await readResponseJsonLimited(response, 64 * 1024).catch(
      () => null,
    );
    const failureRecord =
      failurePayload && typeof failurePayload === "object"
        ? (failurePayload as Record<string, unknown>)
        : {};
    const nestedError =
      failureRecord.error && typeof failureRecord.error === "object"
        ? (failureRecord.error as Record<string, unknown>)
        : {};
    const failureDetail = [
      nestedError.message,
      nestedError.detail,
      failureRecord.detail,
      failureRecord.message,
      typeof failureRecord.error === "string" ? failureRecord.error : undefined,
    ].find((value): value is string => typeof value === "string" && Boolean(value));
    return {
      ok: false,
      state: "attention",
      latencyMs,
      message:
        response.status === 401 || response.status === 403
          ? "端点可达，但凭据引用尚未配置或无权访问"
          : `端点返回 HTTP ${response.status}${
              failureDetail ? `：${failureDetail.slice(0, 240)}` : ""
            }`,
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
