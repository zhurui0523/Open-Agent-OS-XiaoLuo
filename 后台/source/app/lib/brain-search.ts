/**
 * 小逻 v3 —— 联网检索核心（供应商适配 + 结果排版）
 *
 * 原来这四家供应商全写在 app/api/v2/brain/search/route.ts 里，只有浏览器宿主点 web_search 才用得上。
 * app-server 化之后，跑在服务端进程里的小逻（以及隔着协议的 CLI/桌面宿主）要的是同一份检索：
 * 鉴权、限流、参数校验留在路由，供应商与文案在这里，两边共用一份。
 *
 * 输出字符串的形状是协议的一部分：小逻在两种宿主里看到的检索结果必须逐字一致。
 */

import fs from "node:fs/promises";
import path from "node:path";

export type SearchProvider = "duckduckgo" | "bing" | "tavily" | "serper";

export const SEARCH_PROVIDERS: SearchProvider[] = ["duckduckgo", "bing", "tavily", "serper"];
const CONFIG_FILE = path.join(process.cwd(), ".data", "brain-search.json");
const MAX_RESULTS = 6;

export interface SearchConfig {
  provider: SearchProvider;
}

export async function readSearchConfig(): Promise<SearchConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as { provider?: unknown };
    const provider = SEARCH_PROVIDERS.includes(parsed.provider as SearchProvider)
      ? (parsed.provider as SearchProvider)
      : "bing";
    return { provider };
  } catch {
    return { provider: "bing" };
  }
}

export async function writeSearchConfig(config: SearchConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

export function isSearchProvider(value: unknown): value is SearchProvider {
  return SEARCH_PROVIDERS.includes(value as SearchProvider);
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
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

// WEB-SEARCH-FIX：Bing 供应商——html.duckduckgo.com 在国内网络不可达（超时），
// cn.bing.com 国内直达；设为默认供应商，DuckDuckGo 失败时也回退到这里
function decodeBingText(text: string): string {
  const decoded = text
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return " ";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return " ";
      }
    })
    .replace(/&ensp;|&emsp;|&thinsp;/g, " ");
  return stripTags(decoded);
}

async function searchBing(query: string): Promise<SearchHit[]> {
  const resp = await fetch("https://cn.bing.com/search?q=" + encodeURIComponent(query), {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "accept-language": "zh-CN,zh;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!resp.ok) {
    throw new Error("Bing 请求失败 (" + resp.status + ")");
  }
  const html = await resp.text();
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/g;
  const titleRe = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snipRe = /<p[^>]*>([\s\S]*?)<\/p>/i;
  const hits: SearchHit[] = [];
  for (const block of html.match(blockRe) ?? []) {
    if (hits.length >= MAX_RESULTS) break;
    const tm = block.match(titleRe);
    if (!tm) continue;
    const sm = block.match(snipRe);
    hits.push({
      title: decodeBingText(tm[2]),
      url: tm[1],
      snippet: sm ? decodeBingText(sm[1]).slice(0, 300) : "",
    });
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

export interface WebSearchOutcome {
  /** 实际出结果的供应商：duckduckgo 回退到 bing 时这里就是 bing */
  provider: SearchProvider;
  text: string;
}

/**
 * 执行一次检索（web_search 工具的唯一入口）。
 * 供应商不可达时按原口径回退 Bing；其余失败原样上抛，由宿主决定怎么回流给小逻。
 */
export async function runWebSearch(query: string): Promise<WebSearchOutcome> {
  const config = await readSearchConfig();
  // WEB-SEARCH-FIX：duckduckgo 在国内网络不可达，请求失败自动回退 Bing
  if (config.provider === "duckduckgo") {
    try {
      return { provider: "duckduckgo", text: renderHits("duckduckgo", query, await searchDuckDuckGo(query)) };
    } catch {
      return { provider: "bing", text: renderHits("bing", query, await searchBing(query)) };
    }
  }
  if (config.provider === "tavily") {
    return { provider: "tavily", text: renderHits("tavily", query, await searchTavily(query)) };
  }
  if (config.provider === "serper") {
    return { provider: "serper", text: renderHits("serper", query, await searchSerper(query)) };
  }
  return { provider: "bing", text: renderHits("bing", query, await searchBing(query)) };
}
