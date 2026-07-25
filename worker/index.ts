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
  const embeddableAsset = url.pathname === "/api/v2/files/content";
  const frameAncestors = embeddableAsset ? "'self'" : "'none'";
  headers.set(
    "content-security-policy",
    [
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
      "frame-src 'self' https:",
      "worker-src 'self' blob:",
      "upgrade-insecure-requests",
    ].join("; "),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", embeddableAsset ? "SAMEORIGIN" : "DENY");
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
