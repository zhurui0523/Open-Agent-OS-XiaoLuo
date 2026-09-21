import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { secretRefs } from "../../../../db/schema";
import { jsonError, requireUser } from "../../../lib/auth";
import {
  isSecretReferencedByModel,
  saveSecret,
} from "../../../lib/secret-vault";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
    );
    const db = await getDb();
    const ownerScope =
      user.platformRole === "system_admin"
        ? eq(secretRefs.workspaceId, workspaceId)
        : and(
            eq(secretRefs.workspaceId, workspaceId),
            eq(secretRefs.createdBy, user.id),
          );
    const secrets = await db
      .select({
        id: secretRefs.id,
        name: secretRefs.name,
        lastUsedAt: secretRefs.lastUsedAt,
        createdAt: secretRefs.createdAt,
        updatedAt: secretRefs.updatedAt,
      })
      .from(secretRefs)
      .where(ownerScope);
    return Response.json({ secrets });
  } catch (error) {
    return jsonError(error, "读取 Secret 失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      name?: string;
      value?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const secret = await saveSecret({
      workspaceId,
      userId: user.id,
      name: payload.name ?? "",
      value: payload.value ?? "",
    });
    return Response.json({ secret }, { status: 201 });
  } catch (error) {
    return jsonError(error, "保存 Secret 失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
    );
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Secret ID 必填" }, { status: 400 });
    const db = await getDb();
    const ownerScope =
      user.platformRole === "system_admin"
        ? and(eq(secretRefs.id, id), eq(secretRefs.workspaceId, workspaceId))
        : and(
            eq(secretRefs.id, id),
            eq(secretRefs.workspaceId, workspaceId),
            eq(secretRefs.createdBy, user.id),
          );
    const [secret] = await db
      .select({ id: secretRefs.id })
      .from(secretRefs)
      .where(ownerScope)
      .limit(1);
    if (!secret) {
      return Response.json(
        { error: "Secret 不存在，或不属于当前用户" },
        { status: 404 },
      );
    }
    if (await isSecretReferencedByModel(id, workspaceId)) {
      return Response.json(
        { error: "该密钥仍被模型连接使用，请先删除或更换模型连接中的密钥" },
        { status: 409 },
      );
    }
    await db.delete(secretRefs).where(ownerScope);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "删除 Secret 失败");
  }
}
