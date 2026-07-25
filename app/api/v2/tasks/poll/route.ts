import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { generationJobs } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { pollGenerationJob } from "../../../../lib/model-async-jobs";
import { mysqlNow } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json().catch(() => ({}))) as {
      workspaceId?: string;
      jobId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      body,
    );
    const db = await getDb();
    const jobs = body.jobId
      ? await db
          .select()
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.id, body.jobId),
              eq(generationJobs.workspaceId, workspaceId),
            ),
          )
          .limit(1)
      : await db
          .select()
          .from(generationJobs)
          .where(
            and(
              eq(generationJobs.workspaceId, workspaceId),
              inArray(generationJobs.status, ["submitted", "running"]),
              lte(generationJobs.nextPollAt, mysqlNow()),
            ),
          )
          .orderBy(asc(generationJobs.nextPollAt))
          .limit(10);
    const results = [];
    for (const job of jobs) {
      try {
        const result = await pollGenerationJob(job.id, workspaceId);
        results.push({ id: job.id, status: result.status });
      } catch (error) {
        results.push({
          id: job.id,
          status: "failed",
          error: error instanceof Error ? error.message : "查询失败",
        });
      }
    }
    return Response.json({ jobs: results });
  } catch (error) {
    return jsonError(error, "查询异步模型任务失败");
  }
}
