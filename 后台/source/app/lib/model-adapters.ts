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
    // 上限 120s 放宽到 600s：内核非流式长文本生成（text 300s）不能在适配层先被截断；
    // probe/health 等短超时调用方自传小值，不受影响（2026-09-22）
    Math.max(1_000, Math.min(timeoutMs, 600_000)),
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
    config.protocol === "runninghub-sparkvideo-mini-multimodal" ||
    config.protocol === "runninghub-sparkvideo-multimodal" ||
    config.protocol === "runninghub-minimax-h3" ||
    config.protocol === "runninghub-seedance" ||
    config.protocol === "runninghub-muse-video-economy" ||
    config.protocol === "runninghub-wan-3-prime" ||
    config.protocol === "runninghub-suno-v5" ||
    config.protocol === "runninghub-rh-image-2" ||
    config.protocol === "runninghub-nano-banana-2"
  ) {
    headers.set("content-type", "application/json");
    const queryEndpoint =
      config.protocol === "runninghub-rh-image-2" ||
      config.protocol === "runninghub-nano-banana-2" ||
      config.protocol === "runninghub-suno-v5" ||
      config.protocol === "runninghub-muse-video-economy" ||
      config.protocol === "runninghub-wan-3-prime"
        ? "https://www.runninghub.ai/openapi/v2/query"
        : "https://www.runninghub.cn/openapi/v2/query";
    return new Request(queryEndpoint, {
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
  if (config.protocol === "gemini") {
    headers.set("content-type", "application/json");
    const url = new URL(resolveModelApiEndpoint(baseUrl));
    // 中转网关（new-api 一类）按 Google 的写法收 ?key=，且 :generateContent 只认 POST。
    // 探测必须和 kernel-executors 的 gemini 分支同形，否则「测试」通不通都说明不了真实跑节点会怎样。
    if (config.credential && !url.searchParams.has("key")) {
      url.searchParams.set("key", config.credential);
    }
    return new Request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(
        config.modalities.includes("image")
          ? {
              contents: [
                { role: "user", parts: [{ text: "Draw a simple white circle" }] },
              ],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
                imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
              },
            }
          : { contents: [{ role: "user", parts: [{ text: "Hi" }] }] },
      ),
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

// 探测要发一次真实生成，中转网关的渠道可能十几秒才回头；
// 预算太短会把配置正确的连接报成「超时」（2026-11-12 实测 20 秒仍无响应）
const PROBE_TIMEOUT_MS = 45_000;

export async function probeModelAdapter(
  config: ModelAdapterConfig,
): Promise<AdapterProbeResult> {
  const controller = new AbortController();
  // 中转网关排队时首字节可以慢到 7 秒以上，8 秒的探测预算会把正常配置误报成超时（2026-11-12 16:41）
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const request = modelAdapterProbeRequest(config);
    if (
      config.protocol === "gemini" &&
      modelEndpointKind(request.url) !== "gemini-generate-content"
    ) {
      // 和 kernel-executors 的 gemini 分支同一道闸：路径不对就别去撞网关的网页
      return {
        ok: false,
        state: "attention",
        latencyMs: Date.now() - startedAt,
        message: `gemini 协议的接口地址必须写成 …/v1beta/models/<模型名>:generateContent，当前是 ${new URL(request.url).pathname}`,
      };
    }
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
      PROBE_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "未声明";
      if (request.method !== "HEAD" && /text\/html/i.test(contentType)) {
        // 网关把没匹配上的路径交给网页 catch-all：HTTP 200 但回的是页面，
        // 以前这里直接报「连接成功」，配置错了也看不出来（2026-11-12）
        return {
          ok: false,
          state: "attention",
          latencyMs,
          message: `端点回的是网页（content-type：${contentType}），不是接口 JSON——接口地址写成了页面地址，或缺了 API 路径`,
        };
      }
      if (
            config.protocol === "runninghub-sparkvideo-mini-multimodal" ||
            config.protocol === "runninghub-sparkvideo-multimodal" ||
        config.protocol === "runninghub-minimax-h3" ||
        config.protocol === "runninghub-seedance" ||
        config.protocol === "runninghub-muse-video-economy" ||
        config.protocol === "runninghub-wan-3-prime" ||
        config.protocol === "runninghub-suno-v5" ||
        config.protocol === "runninghub-rh-image-2" ||
        config.protocol === "runninghub-nano-banana-2"
      ) {
        const probePayload = await readResponseJsonLimited(response).catch(
          () => null,
        );
        const probeRecord =
          probePayload && typeof probePayload === "object"
            ? (probePayload as Record<string, unknown>)
            : {};
        const probeCode =
          typeof probeRecord.code === "number" ? probeRecord.code : null;
        const probeDetail =
          typeof probeRecord.msg === "string"
            ? probeRecord.msg
            : typeof probeRecord.message === "string"
              ? probeRecord.message
              : "";
        const denied =
          probeCode === 401 ||
          probeCode === 403 ||
          /access denied|access_denied|permission/i.test(probeDetail);
        if (denied) {
          return {
            ok: false,
            state: "attention",
            latencyMs,
            message: probeDetail
              ? `密钥无权调用该标准模型 API：${probeDetail.slice(0, 240)}（标准模型 API 仅限企业级-共享 API Key）`
              : "密钥无权调用该标准模型 API（标准模型 API 仅限企业级-共享 API Key）",
          };
        }
      }
      let discoveredModels: string[] | undefined;
      let catalog: AdapterModelDescriptor[] | undefined;
      if (
        config.protocol !== "generic-rest" &&
        config.protocol !== "async-video" &&
        config.protocol !== "dall-e-3" &&
        config.protocol !== "runninghub-sparkvideo-mini-multimodal" &&
        config.protocol !== "runninghub-sparkvideo-multimodal" &&
        config.protocol !== "runninghub-minimax-h3" &&
        config.protocol !== "runninghub-seedance" &&
        config.protocol !== "runninghub-muse-video-economy" &&
        config.protocol !== "runninghub-wan-3-prime" &&
        config.protocol !== "runninghub-suno-v5" &&
        config.protocol !== "runninghub-rh-image-2" &&
        config.protocol !== "runninghub-nano-banana-2" &&
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
          ? `端点返回 HTTP ${response.status}：${
              failureDetail || "网关拒绝了鉴权，但没有给出原因"
            }${
              response.status === 401
                ? "（401 一般是令牌本身不对：核对复制得是否完整、有没有多余空格）"
                : "（403 一般是令牌有效但无权调用这个模型：核对令牌的分组、可用模型范围与额度）"
            }`
          : `端点返回 HTTP ${response.status}${
              failureDetail ? `：${failureDetail.slice(0, 240)}` : ""
            }`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "连接失败";
    const timedOut =
      (error instanceof Error && error.name === "AbortError") ||
      reason.includes("超时");
    return {
      ok: false,
      state: "attention",
      latencyMs: Date.now() - startedAt,
      message: timedOut
        ? `网关在 ${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒内没有回应。这不代表配置错了——鉴权和路由都已经过了，只是这条渠道慢或在排队；直接到画布跑一次节点更准（节点走流式，预算 300 秒）`
        : reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}
