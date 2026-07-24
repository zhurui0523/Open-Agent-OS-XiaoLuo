import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  generationJobs,
  kernelRuns,
  kernelTasks,
} from "../../../../db/schema";
import { jsonError, requireUser } from "../../../lib/auth";
import { mysqlNow } from "../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const url = new URL(request.url);
    const status = url.searchParams.get("status")?.trim();
    const db = await getDb();
    const [runs, jobs] = await Promise.all([
      db
        .select()
        .from(kernelRuns)
        .where(eq(kernelRuns.workspaceId, workspaceId))
        .orderBy(desc(kernelRuns.updatedAt))
        .limit(100),
      db
        .select()
        .from(generationJobs)
        .where(
          status
            ? and(
                eq(generationJobs.workspaceId, workspaceId),
                eq(generationJobs.status, status),
              )
            : eq(generationJobs.workspaceId, workspaceId),
        )
        .orderBy(desc(generationJobs.updatedAt))
        .limit(200),
    ]);
    return Response.json({
      runs,
      jobs,
      summary: {
        running:
          runs.filter((run) => run.status === "running").length +
          jobs.filter((job) => job.status === "running").length,
        queued:
          runs.filter((run) => run.status === "queued").length +
          jobs.filter((job) => job.status === "queued").length,
        failed:
          runs.filter((run) => run.status === "failed").length +
          jobs.filter((job) => job.status === "failed").length,
      },
    });
  } catch (error) {
    return jsonError(error, "读取任务中心失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      type?: "run" | "generation";
      id?: string;
      action?: "cancel" | "retry";
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      payload,
    );
    if (!payload.type || !payload.id || !payload.action) {
      return Response.json({ error: "任务参数无效" }, { status: 400 });
    }
    const db = await getDb();
    const now = mysqlNow();
    if (payload.type === "run") {
      const [run] = await db
        .select()
        .from(kernelRuns)
        .where(
          and(
            eq(kernelRuns.id, payload.id),
            eq(kernelRuns.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!run) return Response.json({ error: "运行不存在" }, { status: 404 });
      await db
        .update(kernelRuns)
        .set({
          desiredStatus: payload.action === "cancel" ? "canceled" : "running",
          status: payload.action === "cancel" ? "canceled" : "queued",
          error: payload.action === "retry" ? null : run.error,
          updatedAt: now,
        })
        .where(eq(kernelRuns.id, run.id));
      if (payload.action === "retry") {
        await db
          .update(kernelTasks)
          .set({ status: "queued", error: null, updatedAt: now })
          .where(
            and(
              eq(kernelTasks.runId, run.id),
              eq(kernelTasks.status, "failed"),
            ),
          );
      }
    } else {
      const [job] = await db
        .select()
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.id, payload.id),
            eq(generationJobs.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!job) return Response.json({ error: "生成任务不存在" }, { status: 404 });
      await db
        .update(generationJobs)
        .set({
          status: payload.action === "cancel" ? "canceled" : "queued",
          progress: payload.action === "retry" ? 0 : job.progress,
          error: payload.action === "retry" ? null : job.error,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, job.id));
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新任务失败");
  }
}
