import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  generationJobs,
  kernelRuns,
  kernelTasks,
} from "../../../../db/schema";
import { jsonError, requireUser } from "../../../lib/auth";
import {
  cancelGenerationJob,
} from "../../../lib/model-async-jobs";
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
    const runTasks = runs.length
      ? await db
          .select()
          .from(kernelTasks)
          .where(inArray(kernelTasks.runId, runs.map((run) => run.id)))
          .orderBy(desc(kernelTasks.updatedAt))
          .limit(1_000)
      : [];
    return Response.json({
      runs,
      jobs,
      runTasks,
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
      action?: "cancel" | "retry" | "retry_task";
      nodeId?: string;
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
      if (payload.action === "retry_task") {
        if (!payload.nodeId) {
          return Response.json({ error: "nodeId 必填" }, { status: 400 });
        }
        const graph = JSON.parse(run.graphJson) as {
          nodes: Array<{ id: string }>;
          edges: Array<{ source: string; target: string }>;
        };
        if (!graph.nodes.some((node) => node.id === payload.nodeId)) {
          return Response.json({ error: "节点不在当前运行图中" }, { status: 404 });
        }
        const branchNodeIds = new Set([payload.nodeId]);
        let expanded = true;
        while (expanded) {
          expanded = false;
          graph.edges.forEach((edge) => {
            if (
              branchNodeIds.has(edge.source) &&
              !branchNodeIds.has(edge.target)
            ) {
              branchNodeIds.add(edge.target);
              expanded = true;
            }
          });
        }
        const nodeIds = [...branchNodeIds];
        const activeJobs = await db
          .select({ id: generationJobs.id })
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.workspaceId, workspaceId),
              eq(generationJobs.runId, run.id),
              inArray(generationJobs.nodeId, nodeIds),
              inArray(generationJobs.status, [
                "queued",
                "submitted",
                "running",
              ]),
            ),
          );
        await Promise.all(
          activeJobs.map((job) => cancelGenerationJob(job.id, workspaceId)),
        );
        await db.transaction(async (tx) => {
          await tx
            .update(kernelTasks)
            .set({
              status: "queued",
              inputJson: null,
              outputJson: null,
              executor: null,
              error: null,
              startedAt: null,
              completedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(kernelTasks.runId, run.id),
                inArray(kernelTasks.nodeId, nodeIds),
              ),
            );
          await tx
            .update(kernelRuns)
            .set({
              desiredStatus: "running",
              status: "queued",
              error: null,
              completedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(kernelRuns.id, run.id));
        });
        return Response.json({ ok: true, resetNodeIds: nodeIds });
      }
      if (payload.action === "cancel") {
        const activeJobs = await db
          .select({ id: generationJobs.id })
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.workspaceId, workspaceId),
              eq(generationJobs.runId, run.id),
              inArray(generationJobs.status, [
                "queued",
                "submitted",
                "running",
              ]),
            ),
          );
        await Promise.all(
          activeJobs.map((job) => cancelGenerationJob(job.id, workspaceId)),
        );
      }
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
      if (payload.action === "cancel") {
        await cancelGenerationJob(job.id, workspaceId);
      } else {
        if (!job.runId || !job.nodeId) {
          return Response.json(
            { error: "该任务没有关联工作流，请从原节点重新执行" },
            { status: 409 },
          );
        }
        await Promise.all([
          db
            .update(generationJobs)
            .set({
              status: "canceled",
              providerStatus: "superseded",
              nextPollAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(generationJobs.id, job.id)),
          db
            .update(kernelTasks)
            .set({
              status: "queued",
              outputJson: null,
              error: null,
              startedAt: null,
              completedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(kernelTasks.runId, job.runId),
                eq(kernelTasks.nodeId, job.nodeId),
              ),
            ),
          db
            .update(kernelRuns)
            .set({
              status: "queued",
              desiredStatus: "running",
              error: null,
              completedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(kernelRuns.id, job.runId)),
        ]);
      }
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新任务失败");
  }
}
