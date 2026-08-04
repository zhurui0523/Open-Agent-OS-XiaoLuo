import { requireUser } from "@/app/lib/auth";
import { createPluginRuntimeGrant } from "@/app/lib/plugin-runtime-launch";
import { requireRequestedWorkspace } from "@/app/lib/workspace-context";

const STATIC_RUNTIME_PREFIX = "/api/v2/packages/runtime/static/";

function isLoopback(hostname: string) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1"
  );
}

function encodePath(segments: string[]) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.trim()) {
      return Response.json(
        { error: "Missing plugin runtime URL" },
        { status: 400 },
      );
    }

    const requestUrl = new URL(request.url);
    const targetUrl = new URL(body.url, requestUrl.origin);
    const sameOrigin = targetUrl.origin === requestUrl.origin;
    const sameLocalServer =
      process.env.NODE_ENV !== "production" &&
      isLoopback(targetUrl.hostname) &&
      isLoopback(requestUrl.hostname) &&
      targetUrl.port === requestUrl.port;
    if (!sameOrigin && !sameLocalServer) {
      return Response.json(
        { error: "Plugin runtime URL does not belong to this service" },
        { status: 400 },
      );
    }
    if (!targetUrl.pathname.startsWith(STATIC_RUNTIME_PREFIX)) {
      return Response.json(
        { error: "This plugin does not require a host launch grant" },
        { status: 400 },
      );
    }

    const segments = targetUrl.pathname
      .slice(STATIC_RUNTIME_PREFIX.length)
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (segments.length < 5) {
      return Response.json(
        { error: "Invalid plugin runtime URL" },
        { status: 400 },
      );
    }

    const [workspaceId, packageKey, version, archiveSha, root, ...path] =
      segments;
    await requireRequestedWorkspace(request, user.id, "view", { workspaceId });

    const token = createPluginRuntimeGrant({
      workspaceId,
      packageKey,
      version,
      archiveSha,
      root,
    });
    // Resolve the entry document explicitly. A root-only URL is normalized
    // through a trailing-slash redirect, which can leave the tokenized
    // optional catch-all route without a concrete file to serve.
    const suffix = path.length ? `/${encodePath(path)}` : "/index.html";
    const launchUrl =
      `/api/v2/packages/runtime/session/${encodeURIComponent(token)}/static/` +
      `${encodePath([
        workspaceId,
        packageKey,
        version,
        archiveSha,
        root,
      ])}${suffix}${targetUrl.search}`;

    return Response.json({ url: launchUrl, expiresIn: 300 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to launch plugin runtime",
      },
      { status: 500 },
    );
  }
}
