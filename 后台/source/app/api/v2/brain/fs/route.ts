/**
 * Xiaoluo Brain 文件系统口（list_dir / read_file / write_file 网关）。
 * 所有操作限定在用户隔离工作区 .data/brain-workspace/<user>/workspace 内，
 * 路径防穿越 + 读写体积上限，见 app/lib/brain-sandbox.ts。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  findSandboxFiles,
  grepSandboxFiles,
  listSandboxDir,
  readSandboxFile,
  writeSandboxFile,
} from "../../../../lib/brain-sandbox";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      action?: string;
      path?: string;
      content?: string;
      opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" };
      mode?: string;
    };
    const action = body.action;
    if (action !== "list" && action !== "read" && action !== "write" && action !== "grep" && action !== "find") {
      return Response.json({ error: "action 必须是 list / read / write / grep / find" }, { status: 400 });
    }
    const relPath = typeof body.path === "string" && body.path.trim() ? body.path.trim() : ".";
    if (relPath.length > 1_000) {
      return Response.json({ error: "路径过长" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:fs", max: 120, windowMs: 60_000 });
    const mode = body.mode === "full" || body.mode === "auto" ? body.mode : undefined;
    if (action === "list") {
      const entries = await listSandboxDir(user.id, relPath, mode);
      return Response.json({ entries });
    }
    if (action === "read") {
      const win = await readSandboxFile(user.id, relPath, body.opts, mode);
      return Response.json(win);
    }
    if (action === "grep") {
      const hits = await grepSandboxFiles(user.id, relPath, body.opts, mode);
      return Response.json({ hits });
    }
    if (action === "find") {
      const paths = await findSandboxFiles(user.id, relPath, body.opts, mode);
      return Response.json({ paths });
    }
    if (typeof body.content !== "string") {
      return Response.json({ error: "write 需要 content 字符串" }, { status: 400 });
    }
    await writeSandboxFile(user.id, relPath, body.content, body.opts?.encoding === "base64" ? { encoding: "base64" } : undefined, mode);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "文件操作失败");
  }
}