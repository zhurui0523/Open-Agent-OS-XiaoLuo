// 基线清单生成器：从仓库真实代码导出 8 份 CSV，避免手写编造清单。
// 用法：node scripts/gen-baseline-inventory.mjs
// 输出：docs/baseline/*.csv（UTF-8，RFC4180 引号转义）
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 门禁用 XIAOLUO_BASELINE_OUT 指到临时目录重算一遍，再和仓库里的清单比字节，防「文档与代码漂移」
const OUT = process.env.XIAOLUO_BASELINE_OUT
  ? resolve(process.env.XIAOLUO_BASELINE_OUT)
  : join(ROOT, "docs", "baseline");

function walk(dir, filter, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

function read(file) {
  return readFileSync(file, "utf8");
}

function rel(file) {
  return relative(ROOT, file).replace(/\\/g, "/");
}

function csv(file, header, rows) {
  const esc = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const body = [header, ...rows].map((row) => row.map(esc).join(",")).join("\r\n");
  writeFileSync(join(OUT, file), body + "\r\n", "utf8");
  return rows.length;
}

mkdirSync(OUT, { recursive: true });
const counts = {};

// 1) 页面与入口
{
  const pages = walk(join(ROOT, "app"), (f) => /\\(page|layout|template)\.tsx$/.test(f));
  const rows = [];
  for (const file of pages) {
    const kind = /page\.tsx$/.test(file) ? "page" : /layout\.tsx$/.test(file) ? "layout" : "template";
    const path =
      "/" +
      relative(join(ROOT, "app"), file)
        .replace(/\\/g, "/")
        .replace(/(^|\/)(page|layout|template)\.tsx$/, "")
        .replace(/^\/+/, "");
    rows.push([path === "/" ? "/" : path, kind, rel(file), "Next.js App Router"]);
  }
  const entrypoints = [
    ["start-local.cmd", "launcher", "start-local.cmd", "Windows 一键启动，转调 scripts/start-local.ps1"],
    ["scripts/start-local.ps1", "launcher", "scripts/start-local.ps1", "解析 node 路径并以 --env-file=.env.local-dev 启动"],
    ["scripts/start-local-detached.mjs", "launcher", "scripts/start-local-detached.mjs", "后台常驻：MySQL + next dev + runtime worker + isolated worker"],
    ["scripts/start-local-next.mjs", "launcher", "scripts/start-local-next.mjs", "前台调试：MySQL + next dev"],
    ["isolated-worker/server.mjs", "worker", "isolated-worker/server.mjs", "独立进程 worker HTTP 入口"],
    ["scripts/runtime-worker.mjs", "worker", "scripts/runtime-worker.mjs", "常驻调度 worker"],
  ];
  for (const row of entrypoints) {
    const target = join(ROOT, row[2]);
    if (!statSafe(target)) continue;
    rows.push(row);
  }
  counts["web-pages-and-entrypoints.csv"] = csv("web-pages-and-entrypoints.csv", ["path", "kind", "source", "notes"], rows);
}

// 2) 用户动作与状态
{
  const components = walk(join(ROOT, "app", "components"), (f) => f.endsWith(".tsx"));
  const rows = [];
  const seen = new Set();
  for (const file of components) {
    const text = read(file);
    const id = rel(file);
    const push = (action, kind, evidence) => {
      const key = id + "|" + action;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push([id, action, kind, evidence]);
    };
    for (const m of text.matchAll(/aria-label="([^"{][^"]{0,40})"/g)) push(m[1], "aria", "aria-label");
    for (const m of text.matchAll(/<(?:h[2-4]|span|button|label)[^>]*>\s*([\u4e00-\u9fa5][^<>{\n]{1,30})\s*<\//g)) {
      push(m[1].trim(), "label", "可见文案");
    }
  }
  counts["user-actions-and-states.csv"] = csv("user-actions-and-states.csv", ["component", "action", "kind", "evidence"], rows);
}

// 3) API 路由与事件
{
  const routes = walk(join(ROOT, "app", "api"), (f) => f.endsWith("route.ts"));
  const rows = [];
  for (const file of routes) {
    const text = read(file);
    const methods = [...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
    const auth = /requireSystemAdmin|requireAdmin/.test(text)
      ? "admin"
      : /requireUser|requireUserFromRequest/.test(text)
        ? "user"
        : "public";
    const path =
      "/" +
      relative(join(ROOT, "app"), file)
        .replace(/\\/g, "/")
        .replace(/\/route\.ts$/, "")
        .replace(/^api\//, "api/");
    rows.push([path, methods.join("|") || "-", auth, rel(file)]);
  }
  counts["api-routes-and-events.csv"] = csv("api-routes-and-events.csv", ["path", "methods", "auth", "source"], rows);
}

// 4) 数据表、字段与存储
{
  const schemaFile = join(ROOT, "db", "schema.ts");
  const text = read(schemaFile);
  const rows = [];
  const tableStart = /export const (\w+) = mysqlTable\(\s*"([^"]+)"/g;
  for (const m of text.matchAll(tableStart)) {
    const exportName = m[1];
    const tableName = m[2];
    const braceStart = text.indexOf("{", m.index);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = text.slice(braceStart, end === -1 ? braceStart + 20000 : end);
    // 列定义混用 mysqlXxx 与项目内 helper（id / varchar / datetime …），都按「标识符调用 + 首参字符串」识别
    const cols = [...block.matchAll(/^\s+(\w+):\s*([A-Za-z_$][\w$]*)\(\s*"([^"]*)"/gm)];
    if (!cols.length) {
      rows.push([tableName, "-", "-", "mysql", exportName]);
      continue;
    }
    for (const c of cols) rows.push([tableName, c[3] || c[1], c[2], "mysql", exportName]);
  }
  counts["data-tables-fields-storage.csv"] = csv("data-tables-fields-storage.csv", ["table", "column", "column_type", "storage", "schema_export"], rows);
}

// 5) 能力、技能、模型与包
{
  const rows = [];
  const seenIds = new Set();
  const pushId = (id, kind, source, notes) => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    rows.push([id, kind, source, notes]);
  };
  const dataText = read(join(ROOT, "app", "data.ts"));
  for (const m of dataText.matchAll(/"(core\.(?:capability|skill)\.[a-z0-9-]+)"/g)) {
    pushId(m[1], m[1].startsWith("core.capability") ? "capability" : "skill", "app/data.ts", "内置能力投影");
  }
  const contract = safeRead(join(ROOT, "app", "lib", "package-contract.ts"));
  for (const m of contract.matchAll(/kind:\s*"([a-z-]+)"/g)) {
    pushId("package-kind:" + m[1], "package", "app/lib/package-contract.ts", "包类型");
  }
  const models = safeRead(join(ROOT, "..", "..", "客户端", "source", "desktop", "local-ai", "manifest.mjs"));
  for (const m of models.matchAll(/\bid:\s*"([^"]+)"/g)) {
    pushId("model:" + m[1], "local-model", "客户端/source/desktop/local-ai/manifest.mjs", "本地模型清单");
  }
  counts["skills-agents-models-packages.csv"] = csv("skills-agents-models-packages.csv", ["id", "kind", "source", "notes"], rows);
}

// 6) worker、作业与集成
{
  const rows = [];
  const candidates = [
    ["isolated-worker", "worker", "isolated-worker/server.mjs", "独立进程执行"],
    ["runtime-worker", "scheduler", "scripts/runtime-worker.mjs", "常驻轮询"],
    ["runtime-worker-docker", "deployment", "isolated-worker/Dockerfile", "容器化 worker"],
    ["runtime-worker-k8s", "deployment", "isolated-worker/kubernetes.yaml", "K8s 部署"],
    ["local-mysql", "integration", "scripts/local-mysql.mjs", "开发态 MySQL 生命周期"],
    ["oss-storage", "integration", "app/lib/server-runtime-config.ts", "阿里云 OSS 存储驱动"],
    ["plugin-runtime", "integration", "app/lib/package-contract.ts", "插件运行时契约"],
  ];
  for (const row of candidates) if (statSafe(join(ROOT, row[2]))) rows.push(row);
  for (const file of walk(join(ROOT, "app", "api"), (f) => f.endsWith("route.ts"))) {
    const text = read(file);
    if (!/runtimeWorker|cron|scheduled|worker/i.test(text)) continue;
    rows.push([rel(file), "scheduled-api", rel(file), "路由内触发调度"]);
  }
  counts["workers-jobs-integrations.csv"] = csv("workers-jobs-integrations.csv", ["name", "kind", "entrypoint", "trigger"], rows);
}

// 7) 角色与权限
{
  const rows = [];
  const schemaText = read(join(ROOT, "db", "schema.ts"));
  for (const m of schemaText.matchAll(/mysqlEnum\("([a-z_]+)",\s*\[([^\]]+)\]\)/g)) {
    const field = m[1];
    if (!/role$/.test(field)) continue;
    const values = [...m[2].matchAll(/"([^"]+)"/g)].map((v) => v[1]);
    for (const value of values) rows.push([field, value, "成员/账号角色", "db/schema.ts"]);
  }
  const auth = safeRead(join(ROOT, "app", "lib", "auth.ts"));
  if (/platformRole !== "system_admin"/.test(auth)) rows.push(["platform", "system_admin", "平台管理操作（用户/系统配置）", "app/lib/auth.ts"]);
  if (/requireUser/.test(auth)) rows.push(["session", "-", "所有 /api/v2 需登录接口", "app/lib/auth.ts"]);
  counts["roles-and-permissions.csv"] = csv("roles-and-permissions.csv", ["scope", "role", "permission", "evidence"], rows);
}

// 8) 需求覆盖
{
  const rows = [];
  for (const file of walk(join(ROOT, "tests"), (f) => f.endsWith(".test.mjs"))) {
    const text = read(file);
    for (const m of text.matchAll(/^test\("([^"]+)"/gm)) {
      rows.push([m[1], rel(file), "已声明用例"]);
    }
  }
  counts["requirements-coverage.csv"] = csv("requirements-coverage.csv", ["requirement", "test_file", "status"], rows);
}

function statSafe(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

for (const [file, count] of Object.entries(counts)) console.log(`${file}: ${count} 行`);
