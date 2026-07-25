import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  generationJobs,
  kernelRuns,
  systemHeartbeats,
} from "../../../../../db/schema";
import { dispatchKernelRun } from "../../../../lib/kernel-worker";
import { pollGenerationJob } from "../../../../lib/model-async-jobs";
import { mysqlNow } from "../../../../lib/mysql";

function authorizeWorker(request: Request) {
  const configured = process.env.RUNTIME_WORKER_TOKEN?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  const provided =
    request.headers.get("x-runtime-worker-token")?.trim() || bearer;
  if (!configured || !provided || configured !== provided) {
    throw new Response("Unauthorized worker", { status: 401 });
  }
}

function workerInstanceId() {
  return (
    process.env.RUNTIME_SCHEDULER_NAME?.trim() ||
    process.env.HOSTNAME?.trim() ||
    "sites-scheduler"
  ).slice(0, 160);
}

async function recordHeartbeat(
  status: "healthy" | "degraded",
  detail: Record<string, unknown>,
) {
  const db = await getDb();
  const now = mysqlNow();
  await db
    .insert(systemHeartbeats)
    .values({
      component: "runtime-scheduler",
      instanceId: workerInstanceId(),
      status,
      detailJson: JSON.stringify(detail),
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        instanceId: workerInstanceId(),
        status,
        detailJson: JSON.stringify(detail),
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

export async function POST(request: Request) {
  try {
    authorizeWorker(request);
    const db = await getDb();
    const now = mysqlNow();
    const dueJobs = await db
      .select({
        id: generationJobs.id,
        workspaceId: generationJobs.workspaceId,
      })
      .from(generationJobs)
      .where(
        and(
          inArray(generationJobs.status, ["submitted", "running"]),
          lte(generationJobs.nextPollAt, now),
          or(
            isNull(generationJobs.leaseExpiresAt),
            lte(generationJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(generationJobs.nextPollAt))
      .limit(20);
    const jobResults: Array<{
      id: string;
      status: string;
      error?: string;
    }> = [];
    for (const job of dueJobs) {
      try {
        const result = await pollGenerationJob(job.id, job.workspaceId);
        jobResults.push({ id: job.id, status: result.status });
      } catch (error) {
        jobResults.push({
          id: job.id,
          status: "failed",
          error: error instanceof Error ? error.message : "异步任务查询失败",
        });
      }
    }

    const runnable = await db
      .select({
        id: kernelRuns.id,
        createdBy: kernelRuns.createdBy,
      })
      .from(kernelRuns)
      .where(
        and(
          eq(kernelRuns.desiredStatus, "running"),
          or(
            eq(kernelRuns.status, "queued"),
            and(
              eq(kernelRuns.status, "running"),
              or(
                isNull(kernelRuns.leaseExpiresAt),
                lte(kernelRuns.leaseExpiresAt, now),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(kernelRuns.updatedAt))
      .limit(8);
    const runResults: Array<{
      id: string;
      status: string;
      error?: string;
    }> = [];
    for (const run of runnable) {
      try {
        const result = await dispatchKernelRun(run.id, run.createdBy);
        runResults.push({ id: run.id, status: result.run.status });
      } catch (error) {
        runResults.push({
          id: run.id,
          status: "failed",
          error: error instanceof Error ? error.message : "内核运行失败",
        });
      }
    }
    await recordHeartbeat("healthy", {
      checkedAt: new Date().toISOString(),
      generationJobs: jobResults.length,
      kernelRuns: runResults.length,
      failed:
        jobResults.filter((item) => item.status === "failed").length +
        runResults.filter((item) => item.status === "failed").length,
    });
    return Response.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      jobs: jobResults,
      runs: runResults,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    await recordHeartbeat("degraded", {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 500) : "unknown",
    }).catch(() => undefined);
    return Response.json(
      { error: error instanceof Error ? error.message : "Worker tick failed" },
      { status: 500 },
    );
  }
}
