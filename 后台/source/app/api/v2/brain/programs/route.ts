/**
 * 小逻程序库 API —— 程序列表 / 保存（自动落盘策略 A 的服务端入口）。
 *   GET  /api/v2/brain/programs  → ProgramMeta[]（只读 meta，列表秒开）
 *   POST /api/v2/brain/programs  ← SaveProgramInput（write_code 成功后客户端自动上报）
 * 文件存储于 .data/brain-programs/{owner}/，结构与安全约束见 lib/brain-programs.ts。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  listPrograms,
  saveProgram,
  type SaveProgramInput,
} from "../../../../lib/brain-programs";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({
      subject: user.id,
      route: "brain:programs",
      max: 240,
      windowMs: 60_000,
    });
    return Response.json(await listPrograms(user.id));
  } catch (error) {
    return jsonError(error, "列出小逻程序库失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({
      subject: user.id,
      route: "brain:programs",
      max: 60,
      windowMs: 60_000,
    });
    const body = (await request.json()) as SaveProgramInput;
    if (!body || !Array.isArray(body.files) || !body.files.length) {
      return Response.json({ error: "files 必填且不能为空" }, { status: 400 });
    }
    if (!body.conversationId || !body.conversationId.trim()) {
      return Response.json({ error: "conversationId 必填" }, { status: 400 });
    }
    const meta = await saveProgram(user.id, body);
    return Response.json(meta);
  } catch (error) {
    return jsonError(error, "保存小逻程序失败");
  }
}
