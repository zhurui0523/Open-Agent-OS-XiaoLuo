/**
 * Xiaoluo Brain git 口（git 工具网关）：固定操作白名单 status/log/diff/commit/push，
 * 在用户隔离工作区上以 argv 白名单方式调用 git（无 shell 解释）；push 为审批门操作。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { runSandboxedGit, type SandboxGitOp } from "../../../../lib/brain-sandbox";

const OPS: SandboxGitOp[] = ["status", "log", "diff", "commit", "push", "branch", "checkout", "merge", "pull"];

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      op?: string;
      message?: string;
      limit?: number;
      approved?: boolean;
      ref?: string;
    };
    const op = body.op as SandboxGitOp | undefined;
    if (!op || !OPS.includes(op)) {
      return Response.json({ error: "op 必须是 " + OPS.join(" / ") }, { status: 400 });
    }
    if (op === "push" && body.approved !== true) {
      return Response.json(
        { error: "git push 需要老板批准后才能执行", code: "approval_required", reasons: ["推送本地提交到远端仓库"] },
        { status: 403 },
      );
    }
    await enforceRateLimit({ subject: user.id, route: "brain:git", max: 60, windowMs: 60_000 });
    const text = await runSandboxedGit(user.id, op, {
      message: typeof body.message === "string" ? body.message : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      ref: typeof body.ref === "string" ? body.ref : undefined,
    });
    return Response.json({ text });
  } catch (error) {
    return jsonError(error, "git 操作失败");
  }
}