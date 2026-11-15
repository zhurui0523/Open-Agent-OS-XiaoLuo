/**
 * Xiaoluo Brain web_search gateway with USER-SELECTABLE providers.
 * Config persists in .data/brain-search.json ({ provider }) and is exposed
 * via GET / PATCH so the settings panel can mount a picker later.
 *
 * Providers:
 *  - duckduckgo (zero-config, no key; falls back to bing when unreachable)
 *  - bing   (default)
 *  - tavily   -> key from env XIAOLUO_SEARCH_TAVILY_KEY
 *  - serper   -> key from env XIAOLUO_SEARCH_SERPER_KEY
 *
 * 检索本身（供应商适配与结果文案）在 app/lib/brain-search.ts，与线程宿主共用一份；
 * 这里只剩鉴权、限流、参数校验。
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  SEARCH_PROVIDERS,
  isSearchProvider,
  readSearchConfig,
  runWebSearch,
  writeSearchConfig,
  type SearchConfig,
} from "../../../../lib/brain-search";

/** 当前检索供应商（设置面板选择器后续挂这里） */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    void user;
    const config = await readSearchConfig();
    return Response.json({ provider: config.provider, providers: SEARCH_PROVIDERS });
  } catch (error) {
    return jsonError(error, "读取检索配置失败");
  }
}

/** 切换检索供应商（用户选择） */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { provider?: unknown };
    if (!isSearchProvider(payload.provider)) {
      return Response.json(
        { error: "provider 必须是 " + SEARCH_PROVIDERS.join(" / ") + " 之一" },
        { status: 400 },
      );
    }
    await enforceRateLimit({ subject: user.id, route: "brain:search-config", max: 30, windowMs: 60_000 });
    const config: SearchConfig = { provider: payload.provider };
    await writeSearchConfig(config);
    return Response.json({ provider: config.provider });
  } catch (error) {
    return jsonError(error, "更新检索配置失败");
  }
}

/** 执行检索（web_search 工具入口） */
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { query?: string };
    const query = payload.query?.trim();
    if (!query) {
      return Response.json({ error: "query 必填" }, { status: 400 });
    }
    if (query.length > 400) {
      return Response.json({ error: "检索词过长（最多 400 字）" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:search", max: 30, windowMs: 60_000 });
    try {
      const { provider, text } = await runWebSearch(query);
      return Response.json({ provider, text });
    } catch (err) {
      const message = err instanceof Error ? err.message : "检索失败";
      return Response.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    return jsonError(error, "联网检索失败");
  }
}
