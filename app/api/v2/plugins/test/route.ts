import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { packages, registryEvents } from "../../../../../db/schema";
import {
  type XiaoLuoPackageManifest,
} from "../../../../lib/package-contract";
import { validateExternalEndpoint } from "../../../../lib/model-adapters";
import { requireUser } from "../../../../lib/auth";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

function joinUrl(base: string, path: string) {
  const normalized = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return validateExternalEndpoint(normalized).toString();
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    if (!payload.id) {
      return Response.json({ error: "id 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [row] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, payload.id),
          eq(packages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) return Response.json({ error: "插件不存在" }, { status: 404 });
    const manifest = JSON.parse(row.manifestJson) as XiaoLuoPackageManifest;

    if (row.runtimeType === "declarative") {
      return Response.json({
        ok: true,
        message: "声明式 Package 已通过 Schema 校验，无需执行沙盒代码。",
      });
    }
    if (row.runtimeType === "sandbox-ui") {
      return Response.json({
        ok: true,
        message: "UI 将在无同源权限的 iframe 沙盒中运行。",
        previewUrl: row.runtimeUrl,
      });
    }

    const runtimeUrl = row.runtimeUrl;
    if (!runtimeUrl) throw new Error("远程运行时缺少入口地址");
    const origin = new URL(runtimeUrl).origin;
    const permissions = JSON.parse(row.permissionsJson) as string[];
    if (!permissions.includes(`network:${origin}`)) {
      throw new Error("插件没有声明目标域名的网络权限");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const startedAt = Date.now();
    try {
      const response = await fetch(
        joinUrl(runtimeUrl, manifest.runtime.healthPath ?? "/health"),
        {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        },
      );
      const result = {
        ok: response.ok,
        message: response.ok
          ? `远程运行时健康，${Date.now() - startedAt} ms`
          : `远程运行时返回 HTTP ${response.status}`,
      };
      await db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        actorUserId: user.id,
        eventType: result.ok ? "plugin.healthy" : "plugin.attention",
        entityId: row.id,
        detailJson: JSON.stringify(result),
      });
      return Response.json(result, { status: response.ok ? 200 : 502 });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "插件检测失败" },
      { status: 500 },
    );
  }
}
