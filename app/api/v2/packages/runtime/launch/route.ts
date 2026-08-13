import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { packages } from "@/db/schema";
import { requireUser } from "@/app/lib/auth";
import { packageAvailableToUser } from "@/app/lib/package-availability";
import {
  createPluginRuntimeGrant,
  normalizeInternalPluginRuntimeUrl,
  PLUGIN_RUNTIME_GRANT_TTL_SECONDS,
  PLUGIN_STATIC_RUNTIME_PREFIX,
  scorePluginRuntimeCandidate,
} from "@/app/lib/plugin-runtime-launch";
import {
  requireRequestedWorkspace,
  workspaceIdFromRequest,
} from "@/app/lib/workspace-context";

function encodePath(segments: string[]) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      url?: unknown;
      workspaceId?: unknown;
      packageId?: unknown;
      packageKey?: unknown;
      packageName?: unknown;
    };
    if (typeof body.url !== "string" || !body.url.trim()) {
      return Response.json(
        { error: "Missing plugin runtime URL" },
        { status: 400 },
      );
    }

    let targetUrl: URL | null;
    try {
      targetUrl = normalizeInternalPluginRuntimeUrl(body.url, request.url);
    } catch {
      return Response.json(
        { error: "Invalid plugin runtime URL" },
        { status: 400 },
      );
    }
    if (!targetUrl) {
      return Response.json(
        { error: "This plugin does not require a host launch grant" },
        { status: 400 },
      );
    }

    const segments = targetUrl.pathname
      .slice(PLUGIN_STATIC_RUNTIME_PREFIX.length)
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (segments.length < 5) {
      return Response.json(
        { error: "Invalid plugin runtime URL" },
        { status: 400 },
      );
    }

    const [savedWorkspaceId, savedPackageKey, savedVersion, , , ...savedPath] =
      segments;

    // A canvas may outlive the personal workspace or package record that was
    // active when its plugin node was created. Authorize the workspace that
    // the user is viewing, then resolve the currently available installation
    // instead of trusting the stale workspace embedded in the saved URL.
    const requestedWorkspaceId =
      workspaceIdFromRequest(request, body) || savedWorkspaceId;
    await requireRequestedWorkspace(request, user.id, "view", {
      workspaceId: requestedWorkspaceId,
    });

    const requestedPackageId =
      typeof body.packageId === "string" ? body.packageId.trim() : "";
    const requestedPackageKey =
      typeof body.packageKey === "string" ? body.packageKey.trim() : "";
    const requestedPackageName =
      typeof body.packageName === "string" ? body.packageName.trim() : "";

    const db = await getDb();
    const availablePackages = await db
      .select({
        id: packages.id,
        packageKey: packages.packageKey,
        name: packages.name,
        version: packages.version,
        runtimeUrl: packages.runtimeUrl,
      })
      .from(packages)
      .where(
        and(
          eq(packages.packageType, "plugin"),
          eq(packages.runtimeType, "sandbox-ui"),
          eq(packages.lifecycleState, "active"),
          eq(packages.enabled, true),
          packageAvailableToUser(requestedWorkspaceId, user.id),
        ),
      )
      .orderBy(desc(packages.updatedAt));

    const ranked = availablePackages
      .map((candidate) => ({
        candidate,
        score: scorePluginRuntimeCandidate(candidate, {
          packageId: requestedPackageId,
          packageKey: requestedPackageKey,
          packageName: requestedPackageName,
          savedPackageKey,
          savedVersion,
        }),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    const resolvedPackage = ranked[0]?.candidate;
    if (!resolvedPackage?.runtimeUrl) {
      return Response.json(
        {
          error: "插件尚未就绪、未启用，或当前工作区尚未添加该插件",
          code: "PLUGIN_RUNTIME_NOT_READY",
          retryable: true,
        },
        { status: 404 },
      );
    }

    const resolvedTarget = normalizeInternalPluginRuntimeUrl(
      resolvedPackage.runtimeUrl,
      request.url,
    );
    if (!resolvedTarget) {
      return Response.json(
        {
          error: "当前插件没有可用的本机静态运行入口",
          code: "PLUGIN_RUNTIME_ENTRY_UNAVAILABLE",
          retryable: true,
        },
        { status: 409 },
      );
    }
    const resolvedSegments = resolvedTarget.pathname
      .slice(PLUGIN_STATIC_RUNTIME_PREFIX.length)
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (resolvedSegments.length < 5) {
      return Response.json(
        {
          error: "当前插件运行地址无效",
          code: "PLUGIN_RUNTIME_ENTRY_INVALID",
          retryable: false,
        },
        { status: 409 },
      );
    }

    const [workspaceId, packageKey, version, archiveSha, root, ...resolvedPath] =
      resolvedSegments;
    const path = resolvedPath.length ? resolvedPath : savedPath;

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
      ])}${suffix}${resolvedTarget.search || targetUrl.search}`;

    return Response.json({
      url: launchUrl,
      expiresIn: PLUGIN_RUNTIME_GRANT_TTL_SECONDS,
      packageId: resolvedPackage.id,
    });
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
