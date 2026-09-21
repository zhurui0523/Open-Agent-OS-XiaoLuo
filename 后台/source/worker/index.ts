/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  RUNTIME_WORKER_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_API_BODY_LIMIT = 10 * 1024 * 1024;
const FILE_API_BODY_LIMIT = 110 * 1024 * 1024;

function securityFailure(message: string, status: number) {
  return Response.json(
    { error: message },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function validateMutationRequest(request: Request, url: URL) {
  if (
    SAFE_METHODS.has(request.method.toUpperCase()) ||
    !url.pathname.startsWith("/api/")
  ) {
    return null;
  }
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin && origin !== url.origin) {
    return securityFailure("请求来源无效", 403);
  }
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return securityFailure("不允许跨站修改数据", 403);
  }
  if (
    !origin &&
    !fetchSite &&
    request.headers.has("cookie") &&
    !request.headers.has("authorization")
  ) {
    return securityFailure("缺少可信请求来源", 403);
  }
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  const limit = url.pathname === "/api/v2/files"
    ? FILE_API_BODY_LIMIT
    : DEFAULT_API_BODY_LIMIT;
  if (Number.isFinite(declaredSize) && declaredSize > limit) {
    return securityFailure("请求内容过大", 413);
  }
  return null;
}

function withSecurityHeaders(request: Request, response: Response) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  // BROWSE-SELF: allow same-origin framing for HTML pages (builtin browser iframe browses local service incl 3002)
  const htmlPage = (response.headers.get("content-type") ?? "").includes("text/html");
  const embeddableAsset = url.pathname === "/api/v2/files/content" || htmlPage;
  // BROWSE-LOOPBACK: 客户端主页在 3111（单机档）或远程域名（在线档），与本机环回服务跨源；
  // 环回部署的 HTML 页放宽到本机环回任意端口互嵌，公网部署仍维持 'self'
  const hostName = (request.headers.get("host") ?? url.hostname).split(":")[0].toLowerCase();
  const loopbackHost = hostName === "127.0.0.1" || hostName === "[::1]" || hostName === "localhost";
  const frameAncestors = embeddableAsset
    ? loopbackHost
      ? "'self' http://127.0.0.1:* http://localhost:* https://xiaoluo-intent-os-v2-0722.shanhaiyixiang.chatgpt.site"
      : "'self'"
    : "'none'";
  const cspDirectives = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      `frame-ancestors ${frameAncestors}`,
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      // FRAME-FIX: allow brain-spawned loopback services in preview iframes
      "frame-src 'self' https: http://127.0.0.1:* http://localhost:*",
      "worker-src 'self' blob:",
  ];
  // LOOPBACK/LAN: 纯 HTTP 部署（环回或局域网私有网段）不能升级，否则浏览器会尝试 HTTPS 加载子资源导致白屏；
  // 仅当请求本身已是 HTTPS 时才附加升级指令（对 HTTPS 站点为无副作用加固）
  const privateHost = (() => {
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostName);
    if (!parts) return hostName.endsWith(".local");
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  })();
  if (!loopbackHost && !privateHost && url.protocol === "https:") {
    cspDirectives.push("upgrade-insecure-requests");
  }
  headers.set(
    "content-security-policy",
    cspDirectives.join("; "),
  );
  headers.set("x-content-type-options", "nosniff");
  // BROWSE-LOOPBACK: 环回互嵌用 CSP frame-ancestors 多源语法（XFO 不支持多源），其余照旧
  if (!(embeddableAsset && loopbackHost)) {
    headers.set("x-frame-options", embeddableAsset ? "SAMEORIGIN" : "DENY");
  }
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (url.protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function runRuntimeScheduler(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) {
  const token = env.RUNTIME_WORKER_TOKEN?.trim();
  if (!token) {
    console.error("[runtime-scheduler] RUNTIME_WORKER_TOKEN is not configured");
    throw new Error("Runtime scheduler token is not configured");
  }
  const response = await handler.fetch(
    new Request("https://xiaoluo.internal/api/v2/worker/tick", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-runtime-scheduled-at": String(controller.scheduledTime),
        "x-runtime-schedule": controller.cron,
      },
    }),
    env,
    ctx,
  );
  const body = await response.text();
  if (!response.ok) {
    console.error(
      `[runtime-scheduler] tick failed: HTTP ${response.status} ${body.slice(0, 500)}`,
    );
    throw new Error(`Runtime scheduler tick failed: HTTP ${response.status}`);
  }
  console.log(
    `[runtime-scheduler] tick completed at ${new Date(controller.scheduledTime).toISOString()}`,
  );
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const rejected = validateMutationRequest(request, url);
    if (rejected) return withSecurityHeaders(request, rejected);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(request, response);
    }

    const response = await handler.fetch(request, env, ctx);
    // FRAME-FIX: runtime pages keep their own CSP; global wrapper would force frame-ancestors none + XFO DENY and break iframe embeds.
    if (
      url.pathname.startsWith('/api/v2/packages/runtime/static/') ||
      url.pathname.startsWith('/api/v2/packages/runtime/session/')
    ) {
      return response;
    }
    return withSecurityHeaders(request, response);
  },
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runRuntimeScheduler(controller, env, ctx));
  },
};

export default worker;
