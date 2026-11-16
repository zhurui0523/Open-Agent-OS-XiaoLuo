/**
 * 第 7.5 项：线程库接口（列表 / 跨会话检索 / 归档裁剪）
 *
 * 事件流本身由 `event-log.ts` 追加；这里只暴露"可治理"的读与维护动作，
 * 一律限定当前登录用户自己的线程（文件名里的 userId 是归一化后的，比较前同样归一化）。
 */
import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { compactThreadEvents, listThreads, searchThreads } from "../../../../xiaoluo-brain/lib/brain/thread-store";

function safeUser(id: string): string {
  return String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const conversationId = url.searchParams.get("conversationId") ?? undefined;
    if (query.trim()) {
      await enforceRateLimit({ subject: user.id, route: "brain:threads-search", max: 30, windowMs: 60_000 });
      const res = await searchThreads(query, { conversationId, limit: Number(url.searchParams.get("limit") ?? 20) });
      return Response.json({
        ...res,
        hits: res.hits.filter((h) => h.userId === safeUser(user.id)),
      });
    }
    const all = await listThreads();
    const mine = all.filter((t) => t.userId === safeUser(user.id));
    return Response.json({ threads: mine.map(({ file: _file, ...rest }) => rest) });
  } catch (error) {
    return jsonError(error, "读取线程库失败");
  }
}

/** 归档裁剪：保留最近 keepLast 条事件，其余搬进 .archive（不可逆，故默认值给保守的 200） */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { conversationId?: unknown; keepLast?: unknown };
    const conversationId = String(payload.conversationId ?? "").trim();
    if (!conversationId) return Response.json({ error: "conversationId 必填" }, { status: 400 });
    const keepLast = Number(payload.keepLast ?? 200);
    if (!Number.isInteger(keepLast) || keepLast < 20 || keepLast > 5000) {
      return Response.json({ error: "keepLast 必须是 20–5000 的整数" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:threads-compact", max: 10, windowMs: 60_000 });
    const res = await compactThreadEvents(user.id, conversationId, keepLast);
    return Response.json(res);
  } catch (error) {
    return jsonError(error, "归档线程失败");
  }
}
