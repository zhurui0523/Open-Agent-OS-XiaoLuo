/**
 * 小逻 v3 —— 网页抓取核心（SSRF 闸门 + 正文提取）
 *
 * 原来这套闸门写在 app/api/v2/brain/browse/route.ts 里。SSRF 防护必须是抓取动作的一部分，
 * 不能是某一条 HTTP 路由的一部分：否则隔着协议的第二宿主调 browser 口就等于绕开了闸门。
 * 路由与 server-ports 的 fetchPage 共用这一份，校验、拉取、截断、提正文都只有这一处。
 */

const MAX_TEXT_CHARS = 12_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** 抓取失败：status 供宿主翻译成 HTTP 码，Node 侧只读 message 回流给小逻 */
export class BrowseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

export interface PageDigestResult {
  title: string;
  text: string;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeEntities(match[1].replace(/\s+/g, " ").trim()).slice(0, 200);
}

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** SSRF 闸门：拒绝本机/内网/链路本地地址 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "::1" || h === "0.0.0.0") {
    return true;
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [, a, b] = m.map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** 抓取一页并抽出正文；失败一律抛 BrowseError（消息与状态码沿用原路由口径） */
export async function fetchPageDigest(rawUrl: string): Promise<PageDigestResult> {
  const raw = rawUrl?.trim();
  if (!raw) throw new BrowseError("url 必填", 400);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowseError("URL 不合法", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowseError("仅支持 http/https 页面", 400);
  }
  if (isBlockedHost(url.hostname)) {
    throw new BrowseError("禁止访问本机或内网地址", 403);
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; XiaoluoBrain/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BrowseError("页面请求失败（超时或无法连接）", 502);
  }
  if (!resp.ok) {
    throw new BrowseError("页面请求失败 (" + resp.status + ")", 502);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new BrowseError("页面过大，无法抓取", 413);
  }
  const html = buf.toString("utf8");
  const text = htmlToText(html);
  if (!text) {
    throw new BrowseError("页面没有可提取的正文（可能是纯 JS 渲染页）", 422);
  }
  return { title: extractTitle(html), text };
}
