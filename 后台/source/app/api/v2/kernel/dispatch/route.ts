import { jsonError, requireUser } from "../../../../lib/auth";
import { dispatchKernelRun } from "../../../../lib/kernel-worker";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { runId?: string };
    if (!payload.runId) {
      return Response.json({ error: "runId 必填" }, { status: 400 });
    }
    return Response.json(await dispatchKernelRun(payload.runId, user.id));
  } catch (error) {
    return jsonError(error, "运行队列调度失败");
  }
}
