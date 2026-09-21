#!/usr/bin/env node
// VINEXT-WIN32-FIX: StaticFileCache 的缓存键在 Windows 下含反斜杠，与浏览器请求的正斜杠路径不匹配，静态资源全 404、页面无样式。
// 每次 pnpm install / pnpm build 后重跑: node scripts/patch-vinext-win32.mjs
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BS = String.fromCharCode(92); // 反斜杠，避免源码转义歧义
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(root, "node_modules/vinext/dist/server/static-file-cache.js"),
  path.join(root, "dist/standalone/node_modules/vinext/dist/server/static-file-cache.js"),
];
const BUG = "relativePath: path.relative(base, batch[j]),";
const FIX = "// VINEXT-WIN32-FIX 统一转正斜杠，避免 Windows 下缓存键不匹配导致静态资源 404\n"
  + "relativePath: path.relative(base, batch[j]).split(" + JSON.stringify(BS) + ").join(\"/\"),";

let patched = 0;
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("VINEXT-WIN32-FIX")) { console.log("already patched:", file); patched += 1; continue; }
  if (!text.includes(BUG)) { console.log("pattern not found (version changed?):", file); continue; }
  fs.writeFileSync(file, text.replace(BUG, () => FIX), "utf8");
  console.log("patched:", file);
  patched += 1;
}
if (!patched) { console.error("no patched copy"); process.exit(1); }
console.log("VINEXT-WIN32-FIX done");
