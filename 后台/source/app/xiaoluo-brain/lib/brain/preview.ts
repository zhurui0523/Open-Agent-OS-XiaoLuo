/**
 * 小逻 v3 —— 代码预览（写完看效果）
 *
 * 安全边界：预览一律在 sandbox iframe 里渲染——
 *  - sandbox 只给 allow-scripts，不给 allow-same-origin：预览里的 JS 拿不到
 *    主应用的 cookie/localStorage/DOM，等价于一个隔离的"只看效果"空间；
 *  - CSS/JS 通过内联拼装进 srcDoc，不发任何网络请求（离线也能预览）。
 */

import type { CodeArtifact, CodeFile } from "./types";

// ---------- 预览产物 ----------

export interface PreviewDocument {
  /** iframe srcDoc 全文 */
  srcDoc: string;
  /** iframe sandbox 属性值（勿放宽，见文件头安全边界） */
  sandbox: string;
  /** 预览标题（入口文件名） */
  title: string;
  /** 本机服务实况地址：存在时直接 iframe 载入该 URL（小逻起的本地服务），不再走 srcDoc */
  url?: string;
}

/** 沙箱属性：允许脚本（交互效果），禁止同源/弹窗/跳转/表单 */
export const PREVIEW_SANDBOX = "allow-scripts";

// ---------- 可预览性判定 ----------

/** 可直接渲染的语言（入口或任一文件命中即可预览） */
const PREVIEWABLE_LANGUAGES = new Set(["html", "htm", "svg"]);

export function isPreviewable(artifact: CodeArtifact): boolean {
  return artifact.files.some((f) => PREVIEWABLE_LANGUAGES.has(f.language.toLowerCase()));
}

// ---------- 组装渲染文档 ----------

/**
 * 把代码交付物组装成可渲染的 srcDoc：
 *  - 以 HTML 文件为骨架（优先指定文件，其次 entryFile，再次第一个 html）
 *  - 交付集里的 css/js 文件内联进去（替换 <link href> / <script src> 引用，
 *    剩余未引用的 css/js 追加到 head/tail）
 *  - 没有 HTML 骨架（纯 css/js）→ 自动生成最小骨架承载它们
 */
export function buildPreviewDocument(artifact: CodeArtifact, targetPath?: string): PreviewDocument {
  const htmlFile = pickHtmlFile(artifact, targetPath);
  const cssFiles = artifact.files.filter((f) => f.language.toLowerCase() === "css");
  const jsFiles = artifact.files.filter((f) => isJsLike(f.language));

  let html = htmlFile?.content ?? minimalHtmlShell();
  const title = htmlFile?.path ?? "preview.html";

  // 替换显式引用：<link href="style.css"> / <script src="app.js">；记录已内联的文件
  const inlined = new Set<string>();
  for (const css of cssFiles) {
    const r = replaceAssetRef(html, css.path, inlineStyleTag(css));
    if (r.replaced) inlined.add(css.path);
    html = r.html;
  }
  for (const js of jsFiles) {
    const r = replaceAssetRef(html, js.path, inlineScriptTag(js));
    if (r.replaced) inlined.add(js.path);
    html = r.html;
  }

  // 未被引用到的 css/js 追加注入（保证多文件项目效果完整）
  const injectedCss = cssFiles.filter((f) => !inlined.has(f.path)).map(inlineStyleTag).join("\n");
  const injectedJs = jsFiles.filter((f) => !inlined.has(f.path)).map(inlineScriptTag).join("\n");
  if (injectedCss) html = injectBefore(html, "</head>", injectedCss);
  if (injectedJs) html = injectBefore(html, "</body>", injectedJs);

  return { srcDoc: html, sandbox: PREVIEW_SANDBOX, title };
}

// ---------- 内部辅助 ----------

function pickHtmlFile(artifact: CodeArtifact, targetPath?: string): CodeFile | undefined {
  const htmls = artifact.files.filter((f) => PREVIEWABLE_LANGUAGES.has(f.language.toLowerCase()));
  if (targetPath) {
    const hit = htmls.find((f) => f.path === targetPath);
    if (hit) return hit;
  }
  if (artifact.entryFile) {
    const hit = htmls.find((f) => f.path === artifact.entryFile);
    if (hit) return hit;
  }
  // 约定俗成：index.html 优先
  return htmls.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ?? htmls[0];
}

function isJsLike(language: string): boolean {
  const lang = language.toLowerCase();
  return lang === "javascript" || lang === "js" || lang === "typescript" || lang === "ts";
}

function inlineStyleTag(css: CodeFile): string {
  return `<style data-src="${css.path}">\n${css.content}\n</style>`;
}

function inlineScriptTag(js: CodeFile): string {
  // 注意：TS 无法在浏览器直接跑——只做展示提示，避免脚本报错刷屏
  if (js.language.toLowerCase().startsWith("typescript")) {
    return `<script data-src="${js.path}">console.info("[小逻预览] ${js.path} 是 TypeScript，需先编译；此处仅展示。");</script>`;
  }
  return `<script data-src="${js.path}">\n${js.content}\n</script>`;
}

/** 把 <link href="x"> / <script src="x"> 形式的引用替换为内联标签；返回是否替换成功 */
function replaceAssetRef(html: string, path: string, inlineTag: string): { html: string; replaced: boolean } {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const linkPattern = new RegExp(
    `<link[^>]*href=["'][^"']*${escapeRegExp(fileName)}["'][^>]*>`,
    "i",
  );
  const scriptPattern = new RegExp(
    `<script[^>]*src=["'][^"']*${escapeRegExp(fileName)}["'][^>]*>\\s*</script>`,
    "i",
  );
  if (linkPattern.test(html)) return { html: html.replace(linkPattern, inlineTag), replaced: true };
  if (scriptPattern.test(html)) return { html: html.replace(scriptPattern, inlineTag), replaced: true };
  return { html, replaced: false };
}

function injectBefore(html: string, marker: string, payload: string): string {
  const idx = html.toLowerCase().lastIndexOf(marker.toLowerCase());
  if (idx < 0) return html + "\n" + payload;
  return html.slice(0, idx) + payload + "\n" + html.slice(idx);
}

function minimalHtmlShell(): string {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><title>小逻预览</title></head>',
    '<body style="margin:0;font-family:system-ui,sans-serif">',
    '<div style="padding:24px;color:#666">（无 HTML 骨架，已注入样式与脚本）</div>',
    "</body></html>",
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- 静态冒烟（阶段3：零 LLM 成本的预览自检） ----------

/**
 * 预览静态冒烟：纯规则检查产物能不能正常渲染，返回问题清单（空 = 通过）：
 *  - entryFile 指向的文件必须在交付集里；
 *  - HTML 入口中引用的本地资源（script src / link href / img src）必须能在交付集找到
 *    （http(s)/data: 引用不管；按文件名尾段匹配，与 buildPreviewDocument 内联口径一致）。
 */
export function smokeCheckPreview(artifact: CodeArtifact): string[] {
  const problems: string[] = [];
  if (!artifact.files.length) {
    problems.push("产物没有文件");
    return problems;
  }
  if (artifact.entryFile && !artifact.files.some((f) => f.path === artifact.entryFile)) {
    problems.push(`入口文件 ${artifact.entryFile} 不在产物文件列表中`);
  }
  const htmlFile = pickHtmlFile(artifact);
  if (!htmlFile) return problems; // 无 HTML 骨架走最小壳渲染，无需引用检查
  const refPattern = /(?:<script[^>]+src|<link[^>]+href|<img[^>]+src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = refPattern.exec(htmlFile.content)) !== null) {
    const ref = m[1].trim();
    if (!ref || /^(https?:|data:|blob:|#)/i.test(ref)) continue;
    const name = ref.split(/[\\/]/).pop() ?? ref;
    if (!artifact.files.some((f) => f.path === ref || (f.path.split(/[\\/]/).pop() ?? f.path) === name)) {
      problems.push(`入口 ${htmlFile.path} 引用的本地资源 ${ref} 不在交付集中`);
    }
  }
  return problems;
}

