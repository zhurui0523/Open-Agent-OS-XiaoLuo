/**
 * Xiaoluo Brain 服务管理网关（二期）：start / stop / status。
 * 启动走 run_command 同款风险分级审批门；服务跑在用户隔离工作区（brain-sandbox.ts）。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  classifyCommandRisk,
  getBrainService,
  listBrainServices,
  startBrainService,
  stopBrainService,
} from "../../../../lib/brain-sandbox";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      action?: "start" | "stop" | "status";
      command?: string;
      id?: string;
      ttlMs?: number;
      approved?: boolean;
    };
    if (body.action === "start") {
      const command = body.command?.trim();
      if (!command) return Response.json({ error: "command 必填" }, { status: 400 });
      if (command.length > 2_000) return Response.json({ error: "命令长度不能超过 2000 字符" }, { status: 400 });
      await enforceRateLimit({ subject: user.id, route: "brain:services", max: 10, windowMs: 60_000 });
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
      const info = await startBrainService(user.id, command, { ttlMs: body.ttlMs });
      return Response.json(info);
    }
    if (body.action === "stop") {
      const id = body.id?.trim();
      if (!id) return Response.json({ error: "id 必填" }, { status: 400 });
      if (!getBrainService(user.id, id)) {
        return Response.json({ error: "服务不存在或已停止" }, { status: 404 });
      }
      const info = await stopBrainService(user.id, id);
      return Response.json(info ?? { id, status: "exited" });
    }
    if (body.action === "status") {
      const rows = await listBrainServices(user.id, body.id?.trim() || undefined);
      return Response.json({ services: rows });
    }
    return Response.json({ error: "action 必须是 start / stop / status" }, { status: 400 });
  } catch (error) {
    return jsonError(error, "服务操作失败");
  }
}
