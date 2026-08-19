/**
 * Xiaoluo Brain run_command 网关：在用户隔离工作区内受控执行 shell 命令。
 * 执行纪律（最小 env / wall time 上限 / 输出截断）与风险分级审批门见 app/lib/brain-sandbox.ts。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { brainWorkspaceRoot, checkPathFence, classifyCommandRisk, runSandboxedCommand } from "../../../../lib/brain-sandbox";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as { command?: string; timeoutMs?: number; approved?: boolean };
    const command = body.command?.trim();
    if (!command) {
      return Response.json({ error: "command 必填" }, { status: 400 });
    }
    if (command.length > 2_000) {
      return Response.json({ error: "命令长度不能超过 2000 字符" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:command", max: 20, windowMs: 60_000 });
    const risk = classifyCommandRisk(command);
    if (risk.level === "blocked") {
      return Response.json(
        { error: "命令被安全策略拦截（" + risk.reasons.join("、") + "），请改用工作区内可恢复的做法。", code: "blocked" },
        { status: 403 },
      );
    }
    if (risk.level === "needs_approval" && body.approved !== true) {
      return Response.json(
        { error: "该命令需要老板批准后才能执行", code: "approval_required", reasons: risk.reasons },
        { status: 403 },
      );
    }
    // 硬沙箱路径围栏：写/删指向工作区外 → 未批准时拦截；已批准视为老板确认边界
    const fenceHits = checkPathFence(command, brainWorkspaceRoot(user.id));
    if (fenceHits.length > 0 && body.approved !== true) {
      return Response.json(
        { error: "该命令会写入/删除工作区之外的文件，需要老板批准", code: "approval_required", reasons: fenceHits.map((p) => "路径围栏：工作区外写入 " + p) },
        { status: 403 },
      );
    }
    const result = await runSandboxedCommand(user.id, command, {
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    return Response.json(result);
  } catch (error) {
    return jsonError(error, "命令执行失败");
  }
}