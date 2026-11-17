/**
 * Xiaoluo Brain 文件系统口（list_dir / read_file / write_file 网关）。
 * 所有操作限定在用户隔离工作区 .data/brain-workspace/<user>/workspace 内，
 * 路径防穿越 + 读写体积上限，见 app/lib/brain-sandbox.ts。
 */

import { and, eq } from "drizzle-orm";
import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { getDb } from "../../../../../db";
import { assets, assetVersions } from "../../../../../db/schema";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { requireWorkspaceContext } from "../../../../lib/cloud-context";
import {
  deleteSandboxPath,
  findSandboxFiles,
  fuzzyFindSandboxFiles,
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
      query?: string;
      content?: string;
      assetId?: string;
      name?: string;
      opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" };
      mode?: string;
    };
    const action = body.action;
    if (action !== "list" && action !== "read" && action !== "write" && action !== "grep" && action !== "find" && action !== "fuzzy" && action !== "delete" && action !== "ingest" && action !== "asset-data") {
      return Response.json({ error: "action 必须是 list / read / write / grep / find / fuzzy / delete / ingest / asset-data" }, { status: 400 });
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
    if (action === "fuzzy") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return Response.json({ error: "fuzzy 需要 query" }, { status: 400 });
      const paths = await fuzzyFindSandboxFiles(user.id, query, {
        path: relPath === "." ? undefined : relPath,
        maxResults: body.opts?.maxResults,
      });
      return Response.json({ paths });
    }
    if (action === "delete") {
      await deleteSandboxPath(user.id, relPath);
      return Response.json({ ok: true });
    }
    if (action === "asset-data") {
      const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
      if (!assetId) return Response.json({ error: "asset-data 需要 assetId" }, { status: 400 });
      const { home } = await requireWorkspaceContext(request);
      const db = await getDb();
      const [asset] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, home.workspaceId)))
        .limit(1);
      if (!asset) return Response.json({ error: "文件不存在" }, { status: 404 });
      const [version] = await db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId ?? ""))
        .limit(1);
      if (!version) return Response.json({ error: "文件版本不存在" }, { status: 404 });
      if (version.size > 2 * 1024 * 1024) {
        return Response.json({ error: "图片超过 2MB，未随消息传给模型" }, { status: 413 });
      }
      const bucket = await getFileBucket();
      const object = await bucket.get(version.blobKey);
      if (!object?.body) return Response.json({ error: "文件内容不存在" }, { status: 404 });
      const bytes = Buffer.from(await new Response(object.body).arrayBuffer());
      const mime = version.mimeType.split(";")[0] || "image/png";
      return Response.json({
        ok: true,
        mimeType: mime,
        dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
      });
    }
    if (action === "ingest") {
      const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
      if (!assetId) return Response.json({ error: "ingest 需要 assetId" }, { status: 400 });
      const { home } = await requireWorkspaceContext(request);
      const db = await getDb();
      const [asset] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, home.workspaceId)))
        .limit(1);
      if (!asset) return Response.json({ error: "文件不存在" }, { status: 404 });
      const [version] = await db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, asset.currentVersionId ?? ""))
        .limit(1);
      if (!version) return Response.json({ error: "文件版本不存在" }, { status: 404 });
      if (version.size > 4 * 1024 * 1024) {
        return Response.json({ error: "附件超过 4MB，暂不能落进工作区" }, { status: 413 });
      }
      const bucket = await getFileBucket();
      const object = await bucket.get(version.blobKey);
      if (!object?.body) return Response.json({ error: "文件内容不存在" }, { status: 404 });
      const bytes = Buffer.from(await new Response(object.body).arrayBuffer());
      const safeName = (body.name || asset.name || "file").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);
      const rel = `uploads/${Date.now().toString(36)}-${safeName}`;
      await writeSandboxFile(user.id, rel, bytes.toString("base64"), { encoding: "base64" }, mode);
      return Response.json({ ok: true, path: rel, size: bytes.byteLength });
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