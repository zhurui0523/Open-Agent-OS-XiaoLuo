/**
 * Xiaoluo Brain browse_page gateway: returns { title, text } per BrowserPort.PageDigest.
 *
 * SSRF 闸门、体积上限与正文提取都在 app/lib/brain-browse.ts，与线程宿主共用一份；
 * 这里只剩鉴权、限流和把 BrowseError 翻译成 HTTP 状态码。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { BrowseError, fetchPageDigest } from "../../../../lib/brain-browse";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { url?: string };
    await enforceRateLimit({ subject: user.id, route: "brain:browse", max: 60, windowMs: 60_000 });
    try {
      return Response.json(await fetchPageDigest(payload.url ?? ""));
    } catch (err) {
      if (err instanceof BrowseError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error) {
    return jsonError(error, "网页抓取失败");
  }
}
