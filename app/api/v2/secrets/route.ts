import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { secretRefs } from "../../../../db/schema";
import { jsonError, requireUser } from "../../../lib/auth";
import { saveSecret } from "../../../lib/secret-vault";
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
    const secrets = await db
      .select({
        id: secretRefs.id,
        name: secretRefs.name,
        lastUsedAt: secretRefs.lastUsedAt,
        createdAt: secretRefs.createdAt,
        updatedAt: secretRefs.updatedAt,
      })
      .from(secretRefs)
      .where(eq(secretRefs.workspaceId, workspaceId));
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
    await db
      .delete(secretRefs)
      .where(
        and(eq(secretRefs.id, id), eq(secretRefs.workspaceId, workspaceId)),
      );
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "删除 Secret 失败");
  }
}
