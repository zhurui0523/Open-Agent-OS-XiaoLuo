import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { packages, registryEvents } from "../../../../../db/schema";
import type { XiaoLuoPackageManifest } from "../../../../lib/package-contract";
import { validateJsonSchema } from "../../../../lib/json-schema";
import { validateExternalEndpoint } from "../../../../lib/model-adapters";
import { requireUser } from "../../../../lib/auth";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import { enforceRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      packageId?: string;
      operation?: string;
      input?: unknown;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      payload,
    );
    if (!payload.packageId || !payload.operation) {
      return Response.json(
        { error: "packageId 和 operation 必填" },
        { status: 400 },
      );
    }
    await enforceRateLimit({
      subject: user.id,
      route: `runtime:${payload.packageId}`,
      max: 60,
      windowMs: 60_000,
    });
    const db = await getDb();
    const [row] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, payload.packageId),
          eq(packages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row || !row.enabled) {
      return Response.json({ error: "插件不存在或已停用" }, { status: 404 });
    }
    if (!["trusted", "reviewed"].includes(row.trustState)) {
      return Response.json(
        { error: "插件尚未通过 Package 信任审核" },
        { status: 403 },
      );
    }
    if (row.runtimeType !== "remote-api" || !row.runtimeUrl) {
      return Response.json(
        { error: "只有 remote-api 插件可由服务端 Runtime Router 调用" },
        { status: 400 },
      );
    }
    const manifest = JSON.parse(row.manifestJson) as XiaoLuoPackageManifest;
    const capability = [
      ...(manifest.contributes?.skills ?? []),
      ...(manifest.contributes?.nodes ?? []),
    ].find((item) => item.id === payload.operation);
    if (!capability) {
      return Response.json(
        { error: "Package 未声明该能力", code: "CAPABILITY_NOT_DECLARED" },
        { status: 404 },
      );
    }
    const inputIssues = validateJsonSchema(
      capability.inputSchema,
      payload.input ?? {},
    );
    if (inputIssues.length) {
      return Response.json(
        {
          error: "能力输入未通过 Schema 校验",
          code: "INPUT_SCHEMA_INVALID",
          details: inputIssues,
        },
        { status: 422 },
      );
    }
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
      const outputIssues = response.ok
        ? validateJsonSchema(capability.outputSchema, output)
        : [];
      await db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        actorUserId: user.id,
        eventType: response.ok ? "runtime.succeeded" : "runtime.failed",
        entityId: row.id,
        detailJson: JSON.stringify({
          operation: payload.operation,
          status: response.status,
        }),
      });
      if (outputIssues.length) {
        return Response.json(
          {
            error: "能力输出未通过 Schema 校验",
            code: "OUTPUT_SCHEMA_INVALID",
            details: outputIssues,
          },
          { status: 502 },
        );
      }
      return Response.json(
        { ok: response.ok, status: response.status, output },
        { status: response.ok ? 200 : 502 },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "Runtime 调用失败" },
      { status: 500 },
    );
  }
}
