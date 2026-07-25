import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  auditLogs,
  isolatedWorkerJobs,
  outboxEvents,
  packages,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { domainEventRows } from "../../../../lib/domain-events";
import {
  cancelIsolatedExecution,
  inspectIsolatedExecution,
  isolatedExecutionPolicy,
  submitIsolatedExecution,
  type IsolatedExecutionResult,
  type IsolatedRuntime,
} from "../../../../lib/isolated-worker";
import { mysqlNow } from "../../../../lib/mysql";
import { parsePackagePayload } from "../../../../lib/package-contract";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

const terminalStatuses = new Set(["succeeded", "failed", "canceled"]);

function safeTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? mysqlNow(date) : null;
}
function cleanArguments(value: unknown) {
  if (!Array.isArray(value)) return [];
  if (value.length > 100) throw new Error("隔离任务参数不能超过 100 项");
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 2_000) {
      throw new Error("隔离任务参数必须是长度不超过 2000 的字符串");
    }
    return item;
  });
}

function cleanSecretRefs(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => /^secret_[A-Za-z0-9-]+$/.test(item)),
    ),
  ).slice(0, 20);
}

async function persistWorkerResult(
  jobId: string,
  result: IsolatedExecutionResult,
) {
  const db = await getDb();
  await db
    .update(isolatedWorkerJobs)
    .set({
      externalExecutionId: result.executionId,
      status: result.status,
      responseJson: JSON.stringify({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        output: result.output,
      }),
      startedAt: safeTime(result.startedAt),
      completedAt: terminalStatuses.has(result.status)
        ? safeTime(result.completedAt) ?? mysqlNow()
        : null,
      error:
        result.status === "failed"
          ? result.stderr.slice(0, 4_000) || "隔离任务执行失败"
          : null,
      updatedAt: mysqlNow(),
    })
    .where(eq(isolatedWorkerJobs.id, jobId));
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      workspaceId?: string;
      packageId?: string;
      runtime?: IsolatedRuntime;
      args?: unknown;
      stdin?: unknown;
      secretRefIds?: unknown;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      body,
    );
    const packageId = body.packageId?.trim();
    if (
      !packageId ||
      !["node", "python", "cli"].includes(body.runtime ?? "")
    ) {
      return Response.json(
        { error: "packageId 与 runtime 必填" },
        { status: 400 },
      );
    }
    const db = await getDb();
    const [pkg] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, packageId),
          eq(packages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!pkg || !pkg.enabled) {
      return Response.json({ error: "Package 不存在或未启用" }, { status: 404 });
    }
    if (
      pkg.runtimeType !== "isolated-worker" ||
      pkg.trustState !== "trusted"
    ) {
      return Response.json(
        { error: "只有可信签名的 isolated-worker Package 可以执行" },
        { status: 403 },
      );
    }
    const manifest = parsePackagePayload(JSON.parse(pkg.manifestJson));
    const runtime = body.runtime as IsolatedRuntime;
    if (manifest.runtime.language !== runtime || !manifest.runtime.entry) {
      return Response.json(
        { error: "请求的运行时与 Package Manifest 不一致" },
        { status: 409 },
      );
    }
    const args = cleanArguments(body.args);
    const stdin =
      typeof body.stdin === "string" ? body.stdin.slice(0, 100_000) : null;
    const secretRefIds = cleanSecretRefs(body.secretRefIds);
    const networkOrigins = (manifest.permissions ?? [])
      .filter((permission) => permission.startsWith("network:https://"))
      .map((permission) => permission.slice(8));
    const policy = isolatedExecutionPolicy(networkOrigins);
    const jobId = `isolated_job_${crypto.randomUUID()}`;
    const now = mysqlNow();
    const eventRows = domainEventRows({
      workspaceId,
      actorUserId: user.id,
      eventType: "isolated_job.queued",
      entityType: "isolated_worker_job",
      entityId: jobId,
      requestId: request.headers.get("x-request-id"),
      detail: { packageId, runtime },
    });
    const executionRequest = {
      jobId,
      package: {
        id: pkg.id,
        key: pkg.packageKey,
        version: pkg.version,
        integritySha256: pkg.integritySha256,
        entry: manifest.runtime.entry,
      },
      runtime,
      args,
      stdin,
      secretRefIds,
      policy,
    };
    await db.transaction(async (tx) => {
      await tx.insert(isolatedWorkerJobs).values({
        id: jobId,
        workspaceId,
        requestedBy: user.id,
        packageId,
        runtime,
        status: "queued",
        endpointOrigin: process.env.ISOLATED_WORKER_ENDPOINT
          ? new URL(process.env.ISOLATED_WORKER_ENDPOINT).origin
          : null,
        requestJson: JSON.stringify({
          package: executionRequest.package,
          runtime,
          args,
          secretRefIds,
          hasStdin: Boolean(stdin),
        }),
        policyJson: JSON.stringify(policy),
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(auditLogs).values(eventRows.audit);
      await tx.insert(outboxEvents).values(eventRows.outbox);
    });
    try {
      const result = await submitIsolatedExecution(executionRequest);
      await persistWorkerResult(jobId, {
        ...result,
        status:
          result.status === "queued" ? "dispatched" : result.status,
      });
      return Response.json(
        { jobId, status: result.status, executionId: result.executionId },
        { status: 202 },
      );
    } catch (error) {
      await db
        .update(isolatedWorkerJobs)
        .set({
          status: "failed",
          error:
            error instanceof Error
              ? error.message.slice(0, 4_000)
              : "隔离 Worker 分发失败",
          completedAt: mysqlNow(),
          updatedAt: mysqlNow(),
        })
        .where(eq(isolatedWorkerJobs.id, jobId));
      throw error;
    }
  } catch (error) {
    return jsonError(error, "创建隔离任务失败");
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const jobId = url.searchParams.get("jobId")?.trim();
    if (!jobId) {
      return Response.json({ error: "jobId 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [job] = await db
      .select()
      .from(isolatedWorkerJobs)
      .where(
        and(
          eq(isolatedWorkerJobs.id, jobId),
          eq(isolatedWorkerJobs.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!job) return Response.json({ error: "任务不存在" }, { status: 404 });
    if (
      job.externalExecutionId &&
      !terminalStatuses.has(job.status)
    ) {
      const result = await inspectIsolatedExecution(job.externalExecutionId);
      await persistWorkerResult(job.id, result);
      return Response.json({ job: { ...job, ...result } });
    }
    return Response.json({
      job: {
        ...job,
        request: JSON.parse(job.requestJson),
        policy: JSON.parse(job.policyJson),
        response: job.responseJson ? JSON.parse(job.responseJson) : null,
        requestJson: undefined,
        policyJson: undefined,
        responseJson: undefined,
      },
    });
  } catch (error) {
    return jsonError(error, "读取隔离任务失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
    );
    const jobId = url.searchParams.get("jobId")?.trim();
    if (!jobId) {
      return Response.json({ error: "jobId 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [job] = await db
      .select()
      .from(isolatedWorkerJobs)
      .where(
        and(
          eq(isolatedWorkerJobs.id, jobId),
          eq(isolatedWorkerJobs.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!job) return Response.json({ error: "任务不存在" }, { status: 404 });
    if (terminalStatuses.has(job.status)) {
      return Response.json({ jobId, status: job.status });
    }
    if (job.externalExecutionId) {
      const result = await cancelIsolatedExecution(job.externalExecutionId);
      await persistWorkerResult(jobId, {
        ...result,
        status: "canceled",
        completedAt: result.completedAt ?? new Date().toISOString(),
      });
    } else {
      await db
        .update(isolatedWorkerJobs)
        .set({
          status: "canceled",
          completedAt: mysqlNow(),
          updatedAt: mysqlNow(),
        })
        .where(eq(isolatedWorkerJobs.id, jobId));
    }
    return Response.json({ jobId, status: "canceled" });
  } catch (error) {
    return jsonError(error, "取消隔离任务失败");
  }
}
