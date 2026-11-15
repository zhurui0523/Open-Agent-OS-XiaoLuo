/**
 * 通用本地服务搭建器（setup_service 的执行体，服务端/桌面端共享）。
 * 流程：探测二进制 → （缺失给安装引导）→ 初始化（数据目录/建库建账号）→ 启动 → 协议级健康。
 * 纯 Node 内置模块；启动复用各通道既有服务管理器（ctx.registerService 注入）。
 * 所有数据落在工作区 .services/<name>/ 下，凭据写 info.json（不出工作区）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getPreset, sanitizeServiceName } from "./service-presets.mjs";

const IS_WIN = process.platform === "win32";
const HOST = "127.0.0.1";

// ---------- 基础工具 ----------
function genPassword(len = 16) {
  return randomBytes(32).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, len);
}

/** PATH 探测二进制（Windows 补 .exe 口径），返回完整路径或 null */
export function detectOnPath(names) {
  const pathDirs = String(process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean);
  for (const name of names) {
    const candidates = [name];
    if (IS_WIN && !/\.exe$/i.test(name)) candidates.push(name + ".exe");
    for (const dir of pathDirs) {
      for (const c of candidates) {
        const full = join(dir, c);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

/** 探测绿色版 MySQL（.local-runtime/mysql-*-winx64），候选目录列表由调用方给 */
export function findPortableMysql(runtimeRoots) {
  for (const root of runtimeRoots || []) {
    try {
      if (!existsSync(root)) continue;
      const hit = readdirSync(root, { withFileTypes: true }).find(
        (e) => e.isDirectory() && /^mysql-\d+\.\d+\.\d+-winx64$/i.test(e.name),
      );
      if (hit) {
        const home = join(root, hit.name);
        if (existsSync(join(home, "bin", "mysqld.exe"))) return home;
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

export function tcpProbe(port, timeoutMs = 800) {
  return new Promise((resolveP) => {
    const socket = createConnection({ host: HOST, port });
    const finish = (ok) => { socket.removeAllListeners(); socket.destroy(); resolveP(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function httpProbe(url, timeoutMs = 2500) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch { return false; }
}

/** 从 base 起找一个空闲端口（最多 +40） */
export async function freePortFrom(base) {
  for (let port = base; port < base + 40; port++) {
    const busy = await new Promise((resolveP) => {
      const srv = createServer();
      srv.once("error", () => resolveP(true));
      srv.once("listening", () => srv.close(() => resolveP(false)));
      try { srv.listen(port, HOST); } catch { resolveP(true); }
    });
    if (!busy) return port;
  }
  return 0;
}

/** PowerShell 里带引号的可执行路径必须加调用运算符 &，否则后续参数被当语法错误 */
const psCall = (cmd) => (IS_WIN ? "& " + cmd : cmd);
function quoteForShell(p) {
  return IS_WIN ? `"${p}"` : `'${p.replace(/'/g, "'\\''")}'`;
}

/** 子目录解析：有围栏解析器走围栏（越界抛错），否则退回工作区根 */
function resolveTarget(ctx, rel) {
  if (ctx.resolveSubDir) return ctx.resolveSubDir(rel || ".");
  return ctx.workspaceRoot;
}

function svcDirOf(ctx, name) {
  return join(resolveTarget(ctx, ".services"), name);
}

function writeInfo(ctx, name, info) {
  const dir = svcDirOf(ctx, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "info.json"), JSON.stringify(info, null, 1), "utf8");
}

function installRequired(preset, extra) {
  return Object.assign({
    error: `本机未找到 ${preset.label} 的可执行程序。请先安装（命令需老板批准后执行），装好再叫我搭一次。`,
    code: "install_required",
    installCommands: preset.installCommands || [],
  }, extra || {});
}

// ---------- 各服务搭建 ----------
async function provisionMysql(payload, ctx, name, preset) {
  const home = findPortableMysql(ctx.runtimeRoots) || (detectOnPath(["mysqld"]) ? dirname(dirname(detectOnPath(["mysqld"]))) : null);
  if (!home) return installRequired(preset, { hint: "也可把绿色版 MySQL 解压到工程 .local-runtime/ 目录（命名 mysql-<版本>-winx64）" });
  const bin = (n) => join(home, "bin", IS_WIN ? n + ".exe" : n);
  const dir = svcDirOf(ctx, name);
  const datadir = join(dir, "data");
  const ini = join(dir, "my.ini");
  const port = await freePortFrom(Number(payload.port) || preset.defaultPort);
  if (!port) return { error: "找不到可用端口（" + preset.defaultPort + " 起连续 40 个都被占用）" };
  mkdirSync(datadir, { recursive: true });
  const slash = (p) => p.replaceAll("\\", "/");
  // 全新数据目录 → 免密初始化（本地回环专用）
  if (!existsSync(join(datadir, "mysql"))) {
    const init = spawnSync(bin("mysqld"), ["--no-defaults", "--initialize-insecure", `--datadir=${datadir}`, "--console"], { windowsHide: true, timeout: 120_000 });
    if (init.status !== 0) return { error: "MySQL 数据目录初始化失败：" + String(init.stderr || init.stdout || "").slice(-600) };
  }
  writeFileSync(ini, [
    "[mysqld]", `basedir=${slash(home)}`, `datadir=${slash(datadir)}`, `port=${port}`,
    "bind-address=127.0.0.1", "mysqlx=0", "character-set-server=utf8mb4", "collation-server=utf8mb4_unicode_ci", "",
  ].join("\n"), "utf8");
  const command = IS_WIN
    ? `& ${quoteForShell(bin("mysqld"))} --defaults-file=my.ini --console --no-monitor`
    : `${quoteForShell(bin("mysqld"))} --defaults-file=my.ini --console`;
  const started = await ctx.registerService(command, { cwd: dir, gated: false, annotate: { kind: "mysql", name, port } });
  if (started.error) return started;
  // 等端口就绪（首次起要回放 redo，给足 30s）
  let ready = false;
  for (let i = 0; i < 86; i++) { if (await tcpProbe(port)) { ready = true; break; } await new Promise((r) => setTimeout(r, 350)); }
  if (!ready) return { error: "MySQL 端口 " + port + " 30s 内未就绪，请用 service_status 看日志尾部排查", serviceId: started.id };
  // 建库建账号（root 免密 → 应用账号带随机口令）
  const database = String(payload.database || "appdb").replace(/[^\w]+/g, "_").slice(0, 64) || "appdb";
  const user = "app";
  const password = genPassword();
  const sql = `CREATE DATABASE IF NOT EXISTS \`${database}\`; CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}'; GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${user}'@'%'; FLUSH PRIVILEGES;`;
  const mk = spawnSync(bin("mysql"), ["--protocol=TCP", `-h${HOST}`, `-P${port}`, "-uroot", `-e${sql}`], { cwd: dir, windowsHide: true, timeout: 30_000 });
  const dbOk = mk.status === 0;
  const info = {
    kind: "mysql", name, serviceId: started.id, port, database, user, password,
    connectionString: `mysql://${user}:${password}@${HOST}:${port}/${database}`,
    connectHint: `${quoteForShell(bin("mysql"))} -h ${HOST} -P ${port} -u ${user} -p`,
    health: dbOk ? "ok" : "port_ok_db_init_failed", createdAt: Date.now(),
  };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: true }, info, { logTail: (started.logTail || "").slice(-400) });
}

async function provisionPostgres(payload, ctx, name, preset) {
  const pgCtl = detectOnPath(["pg_ctl"]);
  if (!pgCtl) return installRequired(preset);
  const binDir = dirname(pgCtl);
  const bin = (n) => join(binDir, IS_WIN ? n + ".exe" : n);
  const dir = svcDirOf(ctx, name);
  const datadir = join(dir, "data");
  const port = await freePortFrom(Number(payload.port) || preset.defaultPort);
  if (!port) return { error: "找不到可用端口" };
  if (!existsSync(join(datadir, "PG_VERSION"))) {
    const init = spawnSync(bin("initdb"), ["-D", datadir, "-U", "xiaoluo", "-A", "trust", "-E", "UTF8"], { windowsHide: true, timeout: 120_000 });
    if (init.status !== 0) return { error: "initdb 失败：" + String(init.stderr || init.stdout || "").slice(-600) };
  }
  const command = psCall(`${quoteForShell(bin("postgres"))} -D ${quoteForShell(datadir)} -p ${port} -c listen_addresses=127.0.0.1`);
  const started = await ctx.registerService(command, { cwd: ctx.workspaceRoot, gated: false, annotate: { kind: "postgres", name, port } });
  if (started.error) return started;
  let ready = false;
  for (let i = 0; i < 60; i++) { if (await tcpProbe(port)) { ready = true; break; } await new Promise((r) => setTimeout(r, 350)); }
  if (!ready) return { error: "PostgreSQL 端口 " + port + " 未就绪，请查 service_status 日志", serviceId: started.id };
  const database = String(payload.database || "appdb").replace(/[^\w]+/g, "_").slice(0, 64) || "appdb";
  const mk = spawnSync(bin("psql"), ["-h", HOST, "-p", String(port), "-U", "xiaoluo", "-d", "postgres", "-c", `CREATE DATABASE ${database}`], { windowsHide: true, timeout: 20_000 });
  const info = {
    kind: "postgres", name, serviceId: started.id, port, database, user: "xiaoluo", password: "(trust 本地免密)",
    connectionString: `postgresql://xiaoluo@${HOST}:${port}/${database}`,
    health: ready ? "ok" : "waiting", createdAt: Date.now(), dbCreateStatus: mk.status === 0 ? "created" : "exists_or_failed",
  };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: true }, info);
}

async function provisionRedis(payload, ctx, name, preset) {
  const exe = detectOnPath(["redis-server"]);
  if (!exe) return installRequired(preset, { hint: "Windows 官方不出 Redis 包，可用 Memurai 或 WSL； scoop/winget 装的是社区移植版" });
  const dir = svcDirOf(ctx, name);
  mkdirSync(join(dir, "data"), { recursive: true });
  const port = await freePortFrom(Number(payload.port) || preset.defaultPort);
  if (!port) return { error: "找不到可用端口" };
  const command = psCall(`${quoteForShell(exe)} --port ${port} --bind 127.0.0.1 --dir ${quoteForShell(join(dir, "data"))} --save ""`);
  const started = await ctx.registerService(command, { cwd: ctx.workspaceRoot, gated: false, annotate: { kind: "redis", name, port } });
  if (started.error) return started;
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await tcpProbe(port)) { ready = true; break; } await new Promise((r) => setTimeout(r, 300)); }
  const info = { kind: "redis", name, serviceId: started.id, port, connectionString: `redis://${HOST}:${port}`, health: ready ? "ok" : "waiting", createdAt: Date.now() };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: ready, error: ready ? undefined : "Redis 端口未就绪，查 service_status 日志" }, info);
}

async function provisionMongodb(payload, ctx, name, preset) {
  const exe = detectOnPath(["mongod"]);
  if (!exe) return installRequired(preset);
  const dir = svcDirOf(ctx, name);
  const dbpath = join(dir, "data");
  mkdirSync(dbpath, { recursive: true });
  const port = await freePortFrom(Number(payload.port) || preset.defaultPort);
  if (!port) return { error: "找不到可用端口" };
  const command = psCall(`${quoteForShell(exe)} --dbpath ${quoteForShell(dbpath)} --port ${port} --bind_ip 127.0.0.1`);
  const started = await ctx.registerService(command, { cwd: ctx.workspaceRoot, gated: false, annotate: { kind: "mongodb", name, port } });
  if (started.error) return started;
  let ready = false;
  for (let i = 0; i < 40; i++) { if (await tcpProbe(port)) { ready = true; break; } await new Promise((r) => setTimeout(r, 350)); }
  const info = { kind: "mongodb", name, serviceId: started.id, port, connectionString: `mongodb://${HOST}:${port}`, health: ready ? "ok" : "waiting", createdAt: Date.now() };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: ready, error: ready ? undefined : "MongoDB 端口未就绪，查 service_status 日志" }, info);
}

/** 静态文件服务：内置 Node 脚本（免装任何依赖） */
async function provisionStatic(payload, ctx, name, preset) {
  const target = resolveTarget(ctx, payload.path);
  if (!existsSync(target)) return { error: "目录不存在：" + String(payload.path) };
  const dir = svcDirOf(ctx, name);
  mkdirSync(dir, { recursive: true });
  const serverFile = join(dir, "server.mjs");
  writeFileSync(serverFile, STATIC_SERVER_SRC, "utf8");
  const port = await freePortFrom(Number(payload.port) || preset.defaultPort);
  if (!port) return { error: "找不到可用端口" };
  const command = psCall(`${quoteForShell(process.execPath)} ${quoteForShell(serverFile)} ${quoteForShell(target)} ${port}`);
  const started = await ctx.registerService(command, { cwd: ctx.workspaceRoot, gated: false, annotate: { kind: "static", name, port } });
  if (started.error) return started;
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await httpProbe(`http://${HOST}:${port}/`)) { ready = true; break; } await new Promise((r) => setTimeout(r, 300)); }
  const info = { kind: "static", name, serviceId: started.id, port, url: `http://${HOST}:${port}/`, root: target, health: ready ? "ok" : "waiting", createdAt: Date.now() };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: ready, error: ready ? undefined : "静态服务未就绪，查 service_status 日志" }, info);
}

/** Web 开发服务器：识别项目启动脚本；识别不出退回静态服务 */
async function provisionWeb(payload, ctx, name, preset) {
  const target = resolveTarget(ctx, payload.path);
  const pkgFile = join(target, "package.json");
  if (existsSync(pkgFile)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); } catch { /* 忽略 */ }
    const scripts = (pkg && pkg.scripts) || {};
    const scriptName = ["dev", "start", "serve"].find((k) => scripts[k]);
    if (scriptName) {
      const runner = detectOnPath(["pnpm"]) ? "pnpm" : detectOnPath(["npm"]) ? "npm" : null;
      if (runner) {
        const command = `${runner} run ${scriptName}`;
        const started = await ctx.registerService(command, { cwd: target, gated: false, annotate: { kind: "web", name } });
        if (started.error) return started;
        // dev server 打 URL 到日志需要几秒：短轮询回流地址（拿不到也不阻塞，service_status 会补）
        let webUrl = started.url || "";
        if (!webUrl && ctx.getServiceInfo) {
          for (let i = 0; i < 24; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const cur = ctx.getServiceInfo(started.id);
            if (cur && cur.url) { webUrl = cur.url; break; }
            if (cur && cur.status === "exited") break;
          }
        }
        const info = { kind: "web", name, serviceId: started.id, url: webUrl || "(启动中，日志嗅探到地址后回流)", runner, scriptName, health: webUrl ? "ok" : "starting", createdAt: Date.now() };
        writeInfo(ctx, name, info);
        return Object.assign({ ok: true }, info, { logTail: (started.logTail || "").slice(-400) });
      }
      return { error: `项目有 scripts.${scriptName} 但本机没有 npm/pnpm。可先装 Node（${preset.installCommands[0]}），或改用 kind=static 静态挂目录。`, code: "install_required", installCommands: preset.installCommands };
    }
  }
  // 无 package.json / 无 dev 脚本 → 静态兜底
  return provisionStatic(payload, ctx, name, getPreset("static"));
}

async function provisionGeneric(payload, ctx, name) {
  const command = String(payload.command || "").trim();
  if (!command) return { error: "kind=generic 必须给 command" };
  if (command.length > 2000) return { error: "command 过长（上限 2000 字符）" };
  const started = await ctx.registerService(command, { cwd: payload.path, gated: true, approved: payload.approved === true, ttlMs: payload.ttlMs, annotate: { kind: "generic", name } });
  if (started.error) return started;
  const info = { kind: "generic", name, serviceId: started.id, url: started.url || "", health: "started", createdAt: Date.now() };
  writeInfo(ctx, name, info);
  return Object.assign({ ok: true }, info);
}

/** 内置静态服务器源码（写进 .services/<name>/server.mjs 运行，纯 Node） */
const STATIC_SERVER_SRC = `import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
const root = resolve(process.argv[2] || ".");
const port = Number(process.argv[3] || 8123);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".ico": "image/x-icon" };
createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(root, urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/"));
`;

// ---------- 分发 ----------
export async function provisionService(payload, ctx) {
  const kind = String(payload?.kind || "").toLowerCase();
  const preset = getPreset(kind);
  if (!preset) return { error: "未知服务类型：" + kind + "。支持：" + ["web", "static", "mysql", "postgres", "redis", "mongodb", "generic"].join(" / ") };
  const name = sanitizeServiceName(payload.name, kind + "-" + Date.now().toString(36).slice(-4));
  try {
    if (kind === "mysql") return await provisionMysql(payload, ctx, name, preset);
    if (kind === "postgres") return await provisionPostgres(payload, ctx, name, preset);
    if (kind === "redis") return await provisionRedis(payload, ctx, name, preset);
    if (kind === "mongodb") return await provisionMongodb(payload, ctx, name, preset);
    if (kind === "static") return await provisionStatic(payload, ctx, name, preset);
    if (kind === "web") return await provisionWeb(payload, ctx, name, preset);
    return await provisionGeneric(payload, ctx, name);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读回所有已搭建服务的 info（status 面用） */
export function readServiceInfos(workspaceRoot) {
  const base = join(workspaceRoot, ".services");
  try {
    return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
      try { return JSON.parse(readFileSync(join(base, e.name, "info.json"), "utf8")); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** 协议级健康复查（比端口探活更进一步） */
export async function recheckHealth(info, ctx) {
  if (!info) return { health: "unknown" };
  if (info.kind === "mysql") {
    const up = await tcpProbe(info.port);
    return { health: up ? "ok" : "down", port: info.port };
  }
  if (info.kind === "static" || info.kind === "web") {
    if (info.url && /^https?:/.test(info.url)) return { health: (await httpProbe(info.url)) ? "ok" : "down", url: info.url };
    if (info.port) return { health: (await tcpProbe(info.port)) ? "ok" : "down", port: info.port };
    return { health: "unknown" };
  }
  if (info.port) return { health: (await tcpProbe(info.port)) ? "ok" : "down", port: info.port };
  return { health: "unknown" };
}
