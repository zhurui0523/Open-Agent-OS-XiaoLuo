import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  assetRelations,
  assets,
  generationJobs,
  kernelRuns,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireWorkspaceContext } from "../../../../lib/cloud-context";

export async function GET(request: Request) {
  try {
    await requireUser(request);
    const { home } = await requireWorkspaceContext(request);
    const assetId = new URL(request.url).searchParams.get("assetId")?.trim();
    if (!assetId) return Response.json({ error: "assetId 必填" }, { status: 400 });
    const db = await getDb();
    const [asset] = await db
      .select()
      .from(assets)
      .where(
        and(eq(assets.id, assetId), eq(assets.workspaceId, home.workspaceId)),
      )
      .limit(1);
    if (!asset) return Response.json({ error: "资产不存在" }, { status: 404 });
    const relations = await db
      .select()
      .from(assetRelations)
      .where(
        or(
          eq(assetRelations.fromAssetId, assetId),
          eq(assetRelations.toAssetId, assetId),
        ),
      );
    const [job] = asset.sourceRef
      ? await db
          .select()
          .from(generationJobs)
          .where(eq(generationJobs.id, asset.sourceRef))
          .limit(1)
      : [];
    const [run] = job?.runId
      ? await db
          .select()
          .from(kernelRuns)
          .where(
            and(
              eq(kernelRuns.id, job.runId),
              eq(kernelRuns.workspaceId, home.workspaceId),
            ),
          )
          .limit(1)
      : [];
    return Response.json({ asset, relations, generationJob: job ?? null, run: run ?? null });
  } catch (error) {
    return jsonError(error, "读取资产来源失败");
  }
}
