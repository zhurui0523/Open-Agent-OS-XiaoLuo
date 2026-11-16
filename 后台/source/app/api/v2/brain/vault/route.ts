/**
 * 凭据钥匙串接口（第 7.11 项）：只回名字/更新时间/备注，永不回明文。
 * 值加密落盘（AES-256-GCM），key 文件 0600；工作区里的 agent 读不到（库在 workspace 外侧）。
 */
import { jsonError, requireUser } from "../../../../lib/auth";
import { brainVaultDir } from "../../../../lib/brain-sandbox";
import { deleteSecret, listSecrets, setSecret } from "../../../../lib/credential-vault";
import { enforceRateLimit } from "../../../../lib/rate-limit";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:vault", max: 60, windowMs: 60_000 });
    const secrets = await listSecrets(brainVaultDir(user.id));
    return Response.json({ secrets });
  } catch (error) {
    return jsonError(error, "凭据列表读取失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:vault:write", max: 30, windowMs: 60_000 });
    const body = (await request.json()) as { action?: string; name?: string; value?: string; note?: string };
    const action = body.action;
    if (action !== "set" && action !== "delete") {
      return Response.json({ error: "action 必须是 set / delete" }, { status: 400 });
    }
    if (action === "set") {
      const meta = await setSecret(brainVaultDir(user.id), String(body.name ?? ""), String(body.value ?? ""), body.note);
      return Response.json({ ok: true, secret: meta });
    }
    const deleted = await deleteSecret(brainVaultDir(user.id), String(body.name ?? ""));
    return Response.json({ ok: true, deleted });
  } catch (error) {
    return jsonError(error, "凭据写入失败");
  }
}
