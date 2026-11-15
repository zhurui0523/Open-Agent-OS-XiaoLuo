/**
 * 小逻程序库 API —— 单个程序：读取全量 / 重命名 / 删除。
 *   GET    /api/v2/brain/programs/{id}  → ProgramRecord（meta + 文件全文），404 = 不存在
 *   PUT    /api/v2/brain/programs/{id}  ← { name } 重命名
 *   DELETE /api/v2/brain/programs/{id}  删除整个程序文件夹
 */

import { jsonError, requireUser } from "../../../../../lib/auth";
import { enforceRateLimit } from "../../../../../lib/rate-limit";
import {
  getProgram,
  removeProgram,
  renameProgram,
} from "../../../../../lib/brain-programs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    await enforceRateLimit({
      subject: user.id,
      route: "brain:programs",
      max: 240,
      windowMs: 60_000,
    });
    const record = await getProgram(user.id, id);
    if (!record) {
      return Response.json({ error: "程序不存在" }, { status: 404 });
    }
    return Response.json(record);
  } catch (error) {
    return jsonError(error, "读取小逻程序失败");
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    await enforceRateLimit({
      subject: user.id,
      route: "brain:programs",
      max: 60,
      windowMs: 60_000,
    });
    const body = (await request.json()) as { name?: string };
    if (!body?.name?.trim()) {
      return Response.json({ error: "name 必填" }, { status: 400 });
    }
    const meta = await renameProgram(user.id, id, body.name);
    if (!meta) {
      return Response.json({ error: "程序不存在" }, { status: 404 });
    }
    return Response.json(meta);
  } catch (error) {
    return jsonError(error, "重命名小逻程序失败");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    await enforceRateLimit({
      subject: user.id,
      route: "brain:programs",
      max: 60,
      windowMs: 60_000,
    });
    await removeProgram(user.id, id);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "删除小逻程序失败");
  }
}
