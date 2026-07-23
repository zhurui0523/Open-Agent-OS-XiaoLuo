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
    if (config.protocol === "anthropic-compatible") {
      headers.set("x-api-key", config.credential);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${config.credential}`);
    }
  }

  if (config.protocol === "generic-rest") {
    return new Request(baseUrl, { method: "HEAD", headers });
  }
  return new Request(`${baseUrl}/models`, { method: "GET", headers });
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
      if (config.protocol !== "generic-rest") {
        const payload = (await response.json().catch(() => null)) as
          | { data?: Array<{ id?: string }> }
          | null;
        discoveredModels = payload?.data
          ?.map((item) => item.id)
          .filter((id): id is string => Boolean(id))
          .slice(0, 20);
      }
      return {
        ok: true,
        state: "healthy",
        latencyMs,
        message: "连接成功，Adapter 已就绪",
        discoveredModels,
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
