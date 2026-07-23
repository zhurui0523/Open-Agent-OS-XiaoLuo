import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { packages, registryEvents } from "../../../../../db/schema";
import type { XiaoLuoPackageManifest } from "../../../../lib/package-contract";
import { validateExternalEndpoint } from "../../../../lib/model-adapters";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      packageId?: string;
      operation?: string;
      input?: unknown;
    };
    if (!payload.packageId || !payload.operation) {
      return Response.json(
        { error: "packageId 和 operation 必填" },
        { status: 400 },
      );
    }
    const db = await getDb();
    const [row] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, payload.packageId))
      .limit(1);
    if (!row || !row.enabled) {
      return Response.json({ error: "插件不存在或已停用" }, { status: 404 });
    }
    if (row.runtimeType !== "remote-api" || !row.runtimeUrl) {
      return Response.json(
        { error: "只有 remote-api 插件可由服务端 Runtime Router 调用" },
        { status: 400 },
      );
    }
    const manifest = JSON.parse(row.manifestJson) as XiaoLuoPackageManifest;
    const endpoint = new URL(
      manifest.runtime.invokePath ?? "/invoke",
      `${row.runtimeUrl.replace(/\/+$/, "")}/`,
    );
    validateExternalEndpoint(endpoint.toString());
    const permissions = JSON.parse(row.permissionsJson) as string[];
    if (!permissions.includes(`network:${endpoint.origin}`)) {
      return Response.json({ error: "插件没有目标域名网络权限" }, { status: 403 });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          operation: payload.operation,
          input: payload.input ?? null,
          context: { packageId: row.id, packageVersion: row.version },
        }),
        redirect: "error",
        signal: controller.signal,
      });
      const output = await response.json().catch(() => null);
      await db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        eventType: response.ok ? "runtime.succeeded" : "runtime.failed",
        entityId: row.id,
        detailJson: JSON.stringify({
          operation: payload.operation,
          status: response.status,
        }),
      });
      return Response.json(
        { ok: response.ok, status: response.status, output },
        { status: response.ok ? 200 : 502 },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Runtime 调用失败" },
      { status: 500 },
    );
  }
}
