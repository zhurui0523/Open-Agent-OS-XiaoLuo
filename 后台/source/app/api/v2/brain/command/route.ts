/**
 * Xiaoluo Brain run_command 网关：在用户隔离工作区内受控执行 shell 命令。
 * 执行纪律（最小 env / wall time 上限 / 输出截断）见 app/lib/brain-sandbox.ts；
 * 三道审批门（风险 / 网络 / 路径围栏）见 app/lib/brain-command-gate.ts —— 本路由只负责
 * HTTP 关切（鉴权、限流、参数校验、状态码），闸门语义与服务端 app-server 共用一份。
 * 网络维度由工作区 hooks.toml 的 [sandbox] network 决定（默认 open = 与既有一致）。
 *
 * 三种形态共用这一道闸门，审批语义只有一份：
 *   { command }                         → 一次性执行（原有行为）
 *   { command, interactive: true }      → 开一个常驻 stdin 会话，返回 sessionId
 *   { sessionId, input?, waitMs?, close? } → 向会话写一行并取回新增输出
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { cancelSandboxedCommands, closeBrainStdinSessions } from "../../../../lib/brain-sandbox";
import {
  openGatedSession,
  runGatedCommand,
  writeGatedSession,
  type CommandGateDenial,
} from "../../../../lib/brain-command-gate";

function gateDenied(g: CommandGateDenial) {
  return Response.json({ error: g.error, code: g.code, reasons: g.reasons }, { status: g.status });
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      command?: string;
      timeoutMs?: number;
      approved?: boolean;
      cwd?: string;
      interactive?: boolean;
      ttlMs?: number;
      sessionId?: string;
      input?: string;
      waitMs?: number;
      close?: boolean;
    };
    const approved = body.approved === true;
    const cwd = body.cwd?.trim() || undefined;

    // 会话续写：input 也要过命令闸门，否则「把 rm -rf 敲进 shell 会话」就绕过了整道门
    if (body.sessionId) {
      const sessionId = body.sessionId.trim();
      const input = typeof body.input === "string" ? body.input : undefined;
      await enforceRateLimit({ subject: user.id, route: "brain:stdin", max: 90, windowMs: 60_000 });
      if (input !== undefined && input.length > 4_000) {
        return Response.json({ error: "单次输入不能超过 4000 字符" }, { status: 400 });
      }
      const wrote = await writeGatedSession({
        userId: user.id,
        sessionId,
        input,
        approved,
        waitMs: typeof body.waitMs === "number" ? body.waitMs : undefined,
        close: body.close === true,
      });
      if (!wrote.ok) return gateDenied(wrote.denial);
      return Response.json(wrote.data);
    }

    const command = body.command?.trim();
    if (!command) {
      return Response.json({ error: "command 必填" }, { status: 400 });
    }
    if (command.length > 2_000) {
      return Response.json({ error: "命令长度不能超过 2000 字符" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:command", max: 20, windowMs: 60_000 });

    if (body.interactive === true) {
      const opened = await openGatedSession({
        userId: user.id,
        command,
        approved,
        cwd,
        ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
      });
      if (!opened.ok) return gateDenied(opened.denial);
      return Response.json(opened.data);
    }

    const ran = await runGatedCommand({
      userId: user.id,
      command,
      approved,
      cwd,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    if (!ran.ok) return gateDenied(ran.denial);
    return Response.json(ran.data);
  } catch (error) {
    return jsonError(error, "命令执行失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    cancelSandboxedCommands();
    // 老板按停止 = 连交互会话一起收场：会话是长驻进程，留在原地会继续吃 CPU/占端口
    const sessions = closeBrainStdinSessions(user.id);
    return Response.json({ ok: true, sessionsClosed: sessions });
  } catch (error) {
    return jsonError(error, "取消命令失败");
  }
}
