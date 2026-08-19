/**
 * Xiaoluo Brain web_search gateway with USER-SELECTABLE providers.
 * Config persists in .data/brain-search.json ({ provider }) and is exposed
 * via GET / PATCH so the settings panel can mount a picker later.
 *
 * Providers:
 *  - duckduckgo (default, zero-config, no key)
 *  - tavily   -> key from env XIAOLUO_SEARCH_TAVILY_KEY
 *  - serper   -> key from env XIAOLUO_SEARCH_SERPER_KEY
 */

import fs from "node:fs/promises";
import path from "node:path";
import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";

type SearchProvider = "duckduckgo" | "tavily" | "serper";

const PROVIDERS: SearchProvider[] = ["duckduckgo", "tavily", "serper"];
const CONFIG_FILE = path.join(process.cwd(), ".data", "brain-search.json");
const MAX_RESULTS = 6;

interface SearchConfig {
  provider: SearchProvider;
}

async function readConfig(): Promise<SearchConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as { provider?: unknown };
    const provider = PROVIDERS.includes(parsed.provider as SearchProvider)
      ? (parsed.provider as SearchProvider)
      : "duckduckgo";
    return { provider };
  } catch {
    return { provider: "duckduckgo" };
  }
}

async function writeConfig(config: SearchConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDdgHref(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}
interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function renderHits(provider: SearchProvider, query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "检索（" + provider + "）未找到与「" + query + "」相关的结果。";
  }
  const lines = hits.map((hit, index) => {
    return (
      (index + 1) + ". " + hit.title + "\n" +
      "  链接: " + hit.url + "\n" +
      "  摘要: " + hit.snippet
    );
  });
  return "检索（" + provider + "）关键词「" + query + "」的结果：\n\n" + lines.join("\n\n");
}

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    throw new Error("DuckDuckGo 请求失败 (" + resp.status + ")");
  }
  const html = await resp.text();
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: decodeDdgHref(m[1]), title: stripTags(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
  }
  for (let i = 0; i < links.length && hits.length < MAX_RESULTS; i += 1) {
    hits.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
  }
  return hits;
}

async function searchTavily(query: string): Promise<SearchHit[]> {
  const key = process.env.XIAOLUO_SEARCH_TAVILY_KEY;
  if (!key) {
    throw new Error("未配置 Tavily Key（环境变量 XIAOLUO_SEARCH_TAVILY_KEY）");
  }
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: MAX_RESULTS }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    throw new Error("Tavily 请求失败 (" + resp.status + ")");
  }
  const data = (await resp.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 300),
  }));
}

async function searchSerper(query: string): Promise<SearchHit[]> {
  const key = process.env.XIAOLUO_SEARCH_SERPER_KEY;
  if (!key) {
    throw new Error("未配置 Serper Key（环境变量 XIAOLUO_SEARCH_SERPER_KEY）");
  }
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ q: query, num: MAX_RESULTS }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    throw new Error("Serper 请求失败 (" + resp.status + ")");
  }
  const data = (await resp.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (data.organic ?? []).slice(0, MAX_RESULTS).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}
/** 当前检索供应商（设置面板选择器后续挂这里） */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    void user;
    const config = await readConfig();
    return Response.json({ provider: config.provider, providers: PROVIDERS });
  } catch (error) {
    return jsonError(error, "读取检索配置失败");
  }
}

/** 切换检索供应商（用户选择） */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { provider?: unknown };
    if (!PROVIDERS.includes(payload.provider as SearchProvider)) {
      return Response.json(
        { error: "provider 必须是 " + PROVIDERS.join(" / ") + " 之一" },
        { status: 400 },
      );
    }
    await enforceRateLimit({ subject: user.id, route: "brain:search-config", max: 30, windowMs: 60_000 });
    const config: SearchConfig = { provider: payload.provider as SearchProvider };
    await writeConfig(config);
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
    const config = await readConfig();
    try {
      const hits =
        config.provider === "tavily"
          ? await searchTavily(query)
          : config.provider === "serper"
            ? await searchSerper(query)
            : await searchDuckDuckGo(query);
      return Response.json({ provider: config.provider, text: renderHits(config.provider, query, hits) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "检索失败";
      return Response.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    return jsonError(error, "联网检索失败");
  }
}