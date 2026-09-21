/**
 * Xiaoluo Brain 技能市场口（SKILL.md 轻量流通层）。
 * 发布/下架/浏览/安装小逻工作区技能；市场直存 .data/brain-workspace/.market，
 * 不碰 packages 重体系（签名/trust 审核），装发同一套 frontmatter 契约。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  installSkillFromMarket,
  listSkillMarket,
  publishSkillToMarket,
  unpublishSkillFromMarket,
} from "../../../../lib/brain-sandbox";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    await enforceRateLimit({ subject: user.id, route: "brain:skill-market", max: 60, windowMs: 60_000 });
    const listings = await listSkillMarket(user.id);
    return Response.json({ listings });
  } catch (error) {
    return jsonError(error, "读取技能市场失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      action?: string;
      name?: string;
      publisherId?: string;
    };
    const action = body.action;
    if (action !== "publish" && action !== "unpublish" && action !== "install") {
      return Response.json({ error: "action 必须是 publish / unpublish / install" }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return Response.json({ error: "name 必填" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:skill-market", max: 60, windowMs: 60_000 });
    if (action === "publish") {
      const published = await publishSkillToMarket(user.id, user.displayName || user.username, name);
      return Response.json({ ok: true, published });
    }
    if (action === "unpublish") {
      await unpublishSkillFromMarket(user.id, name);
      return Response.json({ ok: true });
    }
    const publisherId = typeof body.publisherId === "string" ? body.publisherId.trim() : "";
    if (!publisherId) {
      return Response.json({ error: "install 需要 publisherId" }, { status: 400 });
    }
    await installSkillFromMarket(user.id, publisherId, name);
    return Response.json({ ok: true, installed: name });
  } catch (error) {
    return jsonError(error, "技能市场操作失败");
  }
}
