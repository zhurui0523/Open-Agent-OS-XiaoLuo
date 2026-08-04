import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { packages } from "@/db/schema";
import { requireUser } from "@/app/lib/auth";
import { getFileBucket } from "@/app/lib/asset-kernel";
import { inspectSourceArchive } from "@/app/lib/package-archive";
import {
  buildGithubStaticPackage,
  packageArtifactKey,
} from "@/app/lib/package-import";
import { verifyPluginRuntimeGrant } from "@/app/lib/plugin-runtime-launch";
import { requireRequestedWorkspace } from "@/app/lib/workspace-context";

export interface PluginRuntimeStaticParams {
  workspaceId: string;
  packageKey: string;
  version: string;
  archiveSha: string;
  root: string;
  path?: string[];
}

const contentTypes: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
};

function safePath(segments: string[]) {
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new Error("插件静态资源路径无效");
  }
  return segments.join("/");
}

function runtimeBasePath(request: Request) {
  const url = new URL(request.url);
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  return `${url.origin}${pathname}`;
}

function rewriteStaticText(
  request: Request,
  bytes: Uint8Array,
  extension: string,
) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const base = runtimeBasePath(request);

  if (extension === "html") {
    return new TextEncoder().encode(
      text
        // Keep assets relative to the signed runtime-session URL. Absolute
        // localhost URLs turn module loads into cross-origin requests when
        // the host app was opened through 127.0.0.1.
        .replace(/\b(src|href)=(["'])\/(?!\/)/gi, "$1=$2./")
        .replace(/<base[\s\S]*?>/gi, ""),
    );
  }

  if (extension === "css") {
    return new TextEncoder().encode(
      text.replace(/url\((["']?)\/(?!\/)/gi, `url($1${base}`),
    );
  }

  return bytes;
}

async function readPreparedStaticFile(
  params: PluginRuntimeStaticParams,
  requested: string,
) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const cacheRoot = path.resolve(
    process.cwd(),
    ".local-data",
    "prepared-static-packages",
    params.archiveSha.toLowerCase(),
  );
  const target = path.resolve(cacheRoot, ...requested.split("/"));
  if (target !== cacheRoot && !target.startsWith(`${cacheRoot}${path.sep}`)) {
    throw new Error("插件静态资源路径无效");
  }
  try {
    return new Uint8Array(await fs.readFile(target));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function servePluginRuntimeStatic(
  request: Request,
  params: PluginRuntimeStaticParams,
) {
  try {
    const runtimeToken = request.headers.get("x-xiaoluo-runtime-token");
    let workspaceId = params.workspaceId;

    if (runtimeToken) {
      verifyPluginRuntimeGrant(runtimeToken, {
        workspaceId: params.workspaceId,
        packageKey: params.packageKey,
        version: params.version,
        archiveSha: params.archiveSha,
        root: params.root,
      });
    } else {
      const user = await requireUser(request);
      workspaceId = await requireRequestedWorkspace(request, user.id, "view", {
        workspaceId: params.workspaceId,
      });
    }

    if (
      !/^[A-Za-z0-9._-]{1,160}$/.test(params.packageKey) ||
      !/^[A-Za-z0-9._-]{1,160}$/.test(params.version) ||
      !/^[a-f0-9]{64}$/i.test(params.archiveSha) ||
      !/^(_root|[A-Za-z0-9._-]{1,80})$/.test(params.root)
    ) {
      return Response.json({ error: "插件静态地址无效" }, { status: 400 });
    }

    const db = await getDb();
    const [pkg] = await db
      .select({ id: packages.id, enabled: packages.enabled })
      .from(packages)
      .where(
        and(
          eq(packages.workspaceId, workspaceId),
          eq(packages.packageKey, params.packageKey),
          eq(packages.version, params.version),
        ),
      )
      .limit(1);

    if (!pkg || !pkg.enabled) {
      return Response.json(
        { error: "插件不存在或尚未启用" },
        { status: 404 },
      );
    }

    const requested = safePath(
      params.path?.length ? params.path : ["index.html"],
    );
    let preparedBytes = await readPreparedStaticFile(params, requested);

    const artifactKey = packageArtifactKey({
      workspaceId,
      packageKey: params.packageKey,
      version: params.version,
      archiveSha256: params.archiveSha.toLowerCase(),
    });
    const object = await (await getFileBucket()).get(artifactKey);
    if (!object?.body) {
      return Response.json({ error: "插件制品不存在" }, { status: 404 });
    }

    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const inspection = await inspectSourceArchive(bytes);
    if (inspection.archiveSha256 !== params.archiveSha.toLowerCase()) {
      return Response.json(
        { error: "插件制品完整性校验失败" },
        { status: 409 },
      );
    }

    // Prepared Vite output is intentionally kept outside the source archive.
    // Recreate it from the durable OSS/local artifact after a restart or on a
    // different application instance instead of leaving the iframe blank.
    if (!preparedBytes && params.root === "_root") {
      const build = await buildGithubStaticPackage({
        inspection,
        archiveSha256: inspection.archiveSha256,
      });
      if (build.prepared) {
        preparedBytes = await readPreparedStaticFile(params, requested);
      }
    }

    const relative =
      params.root === "_root" ? requested : `${params.root}/${requested}`;
    const file = inspection.files.find(
      (item) => item.relativePath === relative,
    );
    if (!file && !preparedBytes) {
      return Response.json(
        { error: "插件静态资源不存在" },
        { status: 404 },
      );
    }

    const extension = relative.split(".").at(-1)?.toLowerCase() ?? "bin";
    const contentType =
      contentTypes[extension] ?? "application/octet-stream";
    const fileBytes = preparedBytes ?? (await inspection.readFile(file!.path));
    const body = ["html", "css"].includes(extension)
      ? rewriteStaticText(request, fileBytes, extension)
      : fileBytes;

    const headers = new Headers({
      "content-type": contentType,
      // Sandboxed iframes have an opaque origin. ES modules require an
      // explicit CORS response even though files use the same signed route.
      "access-control-allow-origin": "*",
      "content-security-policy":
        "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' data: blob: https:; connect-src 'self' data: blob: https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "cache-control":
        extension === "html"
          ? "private, no-store"
          : "private, max-age=31536000, immutable",
    });
    const responseBody = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;

    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "读取插件静态资源失败",
      },
      { status: 500 },
    );
  }
}
