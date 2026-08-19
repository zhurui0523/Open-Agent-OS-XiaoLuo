/**
 * Xiaoluo Brain browse_page gateway: server-side page fetch with body text
 * extraction. Private network addresses are blocked (SSRF); oversized bodies
 * are truncated. Returns { title, text } per BrowserPort.PageDigest.
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";

const MAX_TEXT_CHARS = 12_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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
function isBlockedHost(hostname: string): boolean {
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
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { url?: string };
    const raw = payload.url?.trim();
    if (!raw) {
      return Response.json({ error: "url 必填" }, { status: 400 });
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Response.json({ error: "URL 不合法" }, { status: 400 });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return Response.json({ error: "仅支持 http/https 页面" }, { status: 400 });
    }
    if (isBlockedHost(url.hostname)) {
      return Response.json({ error: "禁止访问本机或内网地址" }, { status: 403 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:browse", max: 60, windowMs: 60_000 });
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; XiaoluoBrain/1.0)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return Response.json({ error: "页面请求失败（超时或无法连接）" }, { status: 502 });
    }
    if (!resp.ok) {
      return Response.json({ error: "页面请求失败 (" + resp.status + ")" }, { status: 502 });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "页面过大，无法抓取" }, { status: 413 });
    }
    const html = buf.toString("utf8");
    const text = htmlToText(html);
    if (!text) {
      return Response.json({ error: "页面没有可提取的正文（可能是纯 JS 渲染页）" }, { status: 422 });
    }
    return Response.json({ title: extractTitle(html), text });
  } catch (error) {
    return jsonError(error, "网页抓取失败");
  }
}