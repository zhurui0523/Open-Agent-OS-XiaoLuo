/**
 * 小逻桌面端本地执行通道（三期）。
 * 与服务端 app/lib/brain-sandbox.ts 同一套执行纪律：风险分级审批门、最小 env、
 * wall time 上限、输出截断、长驻服务的日志环形缓冲 / 端口嗅探 / TTL / 清场。
 * 纯 Node 模块，不依赖 electron（userData 目录由 main.mjs 注入，便于单测）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs"; // P22-SW0
import { createConnection } from "node:net";
import { mkdir, readdir, readFile as readFileAsync, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import path from "node:path";

/** 在途命令子进程登记：stop 时整树杀除，停止即时生效 */
const activeCommandChildren = new Set();
export function cancelAllCommands() {
  for (const c of activeCommandChildren) {
    try {
      if (c && typeof c.pid === "number") killTree(c.pid);
    } catch { /* 已退出 */ }
  }
  activeCommandChildren.clear();
}

const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_WALL_TIME_MS = 120_000;
const MAX_WALL_TIME_MS = 300_000;
/** 输出超过该字符数时全文落盘 .output/ 供 read_file 分页查看（防截断丢诊断信息） */
const OUTPUT_SPILL_THRESHOLD = 2_500;
const MAX_SERVICES = 3;
const MAX_SERVICE_LOG_CHARS = 6_000;
const MAX_TAIL_CHARS = 2_000;
const SERVICE_DEFAULT_TTL_MS = 30 * 60_000;
const SERVICE_MAX_TTL_MS = 4 * 60 * 60_000;
const READY_PROBE_TIMEOUT_MS = 35_000;
const READY_PROBE_INTERVAL_MS = 350;
/** 从启动日志里嗅探服务地址（Next/Vite/http.server/Express 常见口径） */
const SERVICE_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i;

let workspaceRoot = "";

// ---------- 风险分级（单份策略：shared/command-policy.mjs，与服务端共享） ----------
import { classifyCommandRisk, normalizeCommandForRisk, selfTestPolicy } from "../shared/command-policy.mjs";
import { getSandboxLauncher } from "./sandbox-win.mjs"; // P22-SW1
import { provisionService, readServiceInfos, recheckHealth } from "../shared/service-provision.mjs"; // SVC0
// 加载期自测（学 execpolicy）：失败告警不阻断
const policyFailures = selfTestPolicy();
if (policyFailures.length > 0) console.error("[command-policy] 策略自测失败：" + policyFailures.join("；"));
export function classifyRisk(command) {
  return classifyCommandRisk(command);
}
/** 只读系统探查（端口/进程/网络查询）：沙箱低完整性子进程会被 Windows 完整性机制拒绝读取
 * 其他进程的启动信息（Get-CimInstance 等报“访问被拒绝”），此类命令放行普通权限执行。
 * 仅在含探查 cmdlet 且无任何写入/执行/下载意图时生效；含写动词一律继续受限。 */
const PROBE_MARKER = /get-ciminstance|get-nettcpconnection|get-process|netstat|tasklist|lsof\b/i;
const PROBE_TAINT = />|out-file|set-content|add-content|new-item|remove-item|\bdel\b|erase\b|copy-item|move-item|rename-item|start-process|stop-process|invoke-expression|\biex\b|foreach|for-each|\bstart\b|wmic\b|curl\b|wget\b|downloadstring|\bssh\b|reg\s+add|reg\s+delete/i;
export function isSystemProbeCommand(command) {
  const scan = String(command ?? "").trim();
  if (!scan || !PROBE_MARKER.test(scan) || PROBE_TAINT.test(scan)) return false;
  return classifyCommandRisk(scan).level === "safe";
}

// ---------- 受控命令执行 ----------
/** 中文 Windows 控制台子进程输出是 GBK（codepage 936）：按 UTF-8 解码会满屏问号。
 * stream 模式跨 chunk 续接多字节边界；非 Windows 走 UTF-8。 */
/** powershell -EncodedCommand 载荷：UTF-16LE base64；前置 OutputEncoding=UTF8 让子进程输出按 UTF-8 解码 */
function toPsEncoded(command) {
  const ps = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + command;
  return Buffer.from(ps, "utf16le").toString("base64");
}
/** PowerShell 5.1 不支持 bash 式 && / || 链：降级为分号串联，避免整串解析错的 CLIXML 噪声 */
function sanitizeCommandForPs51(command) {
  return command.split("&&").join(";").split("||").join(";");
}
/** 剥掉 PS 非交互 stderr 的 CLIXML 序列化包装；非 UTF-8 字节回退系统代码页（中文 Windows 为 GBK） */
function cleanShellText(text) {
  if (text.includes("#< CLIXML")) {
    return text
      .replace(/#< CLIXML[^\r\n]*/g, "")
      .replace(/<Objs[\s\S]*?<\/Objs>/g, "")
      .replace(/_x000D_/g, "\r")
      .replace(/_x000A_/g, "\n")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  }
  return text;
}
function makeOutputDecoder(isWindows = process.platform === "win32") {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return (chunk) => {
    let text = decoder.decode(chunk, { stream: true });
    text = cleanShellText(text);
    if (isWindows && text.includes("\uFFFD")) {
      try {
        text = cleanShellText(new TextDecoder("gbk").decode(chunk));
      } catch { /* 解码器不可用保持原样 */ }
    }
    return text;
  };
}
/** 命令 PATH：宿主 PATH + 当前 node 所在目录（Electron 从 IDE/快捷方式拉起时 PATH 可能不含 node，这是此前服务起不来的主因） */
function commandPath() {
  const base = process.env.PATH ?? "";
  const nodeDir = dirname(process.execPath);
  return base.split(";").includes(nodeDir) ? base : nodeDir + ";" + base;
}
function minimalEnv(cwd, isWindows) {
  return isWindows
    ? { PATH: commandPath(), PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", USERPROFILE: cwd, NODE_ENV: "production" }
    : { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, NODE_ENV: "production" };
}
async function ensureWorkspace() {
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
/** 相对目录名 → 工作区内绝对目录（防穿越：必须落在 workspaceRoot 内） */
function resolveSubDir(rel) {
  if (!rel) return workspaceRoot;
  const abs = resolve(workspaceRoot, String(rel));
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + sep)) {
    throw new Error("目录越界（必须位于本地工作区内）：" + rel);
  }
  return abs;
}
async function runCommand(command, opts) {
  await ensureWorkspace();
  const cwd = resolveSubDir(opts?.cwd);
  const timeoutMs = Math.min(MAX_WALL_TIME_MS, Math.max(2_000, opts?.timeoutMs ?? DEFAULT_WALL_TIME_MS));
  const isWindows = process.platform === "win32";
  // Windows 走 powershell -EncodedCommand（UTF-16LE base64）：彻底绕开 cmd 引号模型，node -e 内联脚本等带引号命令不再被破坏
  const shellFile = isWindows ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", toPsEncoded(sanitizeCommandForPs51(command))] : ["-c", command];
  const spawnOpts = { cwd, env: minimalEnv(cwd, isWindows), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  // P22-SW2 受限沙箱档：Windows 优先走低完整性令牌启动（低进程写不了工作区外）；setup 失败返回 null 自动降级
  let child = null;
  let sandboxed = false;
  let payloadFile = "";
  if (isWindows && opts?.sandbox !== false) {
    const launcher = getSandboxLauncher(workspaceRoot);
    if (launcher) {
      const tmpDir = join(workspaceRoot, ".tmp");
      try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 忽略 */ }
      payloadFile = join(workspaceRoot, ".sandbox", "run-" + Date.now().toString(36) + ".cmd.ps1");
      try {
        // UTF-8 BOM：低权限子进程 -File 执行时 PS 5.1 才能按 UTF-8 读中文命令
        writeFileSync(payloadFile, "\ufeff$ProgressPreference = 'SilentlyContinue';\n" + sanitizeCommandForPs51(command) + "\n", "utf8");
        const env = Object.assign(minimalEnv(cwd, true), { TEMP: tmpDir, TMP: tmpDir });
        child = spawn(shellFile, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-PayloadFile", payloadFile, "-Cwd", cwd], Object.assign({}, spawnOpts, { env }));
        sandboxed = true;
      } catch {
        child = null;
        payloadFile = "";
      }
    }
  }
  if (!child) child = spawn(shellFile, shellArgs, spawnOpts);
  activeCommandChildren.add(child);
  const untrackChild = () => activeCommandChildren.delete(child);
  let stdout = "";
  let stderr = "";
  let killed = false;
  const decodeOut = makeOutputDecoder(isWindows);
  const append = (key, chunk) => {
    const next = (key === "stdout" ? stdout : stderr) + decodeOut(chunk);
    if (key === "stdout") stdout = next.slice(0, MAX_OUTPUT_CHARS);
    else stderr = next.slice(0, MAX_OUTPUT_CHARS);
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  // Windows 上必须进程树杀除：只杀 cmd 壳时孙进程（如 ping）仍持管道，close 要等孙进程自然结束才触发
  const timer = setTimeout(() => { killed = true; killTree(child.pid); }, timeoutMs);
  return new Promise((resolve) => {
    // IO drain 兜底（学 Codex IO_DRAIN_TIMEOUT）：树杀后孙进程若仍持管道，close 不会触发；
    // 等待短暂排空窗口后强制收口，已 resolve 的 Promise 再 resolve 无效（幂等）
    const drainTimer = setTimeout(() => {
      try { child.stdout.destroy(); } catch { /* 已关 */ }
      try { child.stderr.destroy(); } catch { /* 已关 */ }
      resolve({ exitCode: killed ? 124 : 1, stdout, stderr: stderr + "\n[本地执行] 进程已终止（输出管道排空超时）" });
    }, timeoutMs + 2_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(drainTimer);
      untrackChild();
      if (payloadFile) { try { unlinkSync(payloadFile); } catch { /* 已清 */ } }
      // P22-SW3 受限启动自身失败（启动器退出 740）：静默降级普通启动，沙箱问题不打扰老板
      if (sandboxed && code === 740 && !killed) { resolve(runCommand(command, Object.assign({}, opts, { sandbox: false }))); return; }
      if (killed) stderr = stderr + "\n[本地执行] 命令超过 " + Math.round(timeoutMs / 1000) + " 秒被强制终止";
      const exitCode = killed ? 124 : code ?? 1;
      // 超长输出落盘：同步写盘（runCommand 已 ensureWorkspace），相对路径回流供 read_file 分页
      let spillPath;
      try {
        if (stdout.length + stderr.length > OUTPUT_SPILL_THRESHOLD) {
          spillPath = spillOutput(command, exitCode, stdout, stderr);
        }
      } catch { /* 落盘失败不影响结果回流 */ }
      resolve(Object.assign({ exitCode, stdout, stderr, spillPath }, sandboxed ? { sandboxed: true } : {})); // P22-SW5
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      untrackChild();
      if (payloadFile) { try { unlinkSync(payloadFile); } catch { /* 已清 */ } }
      // P22-SW4 沙箱启动异常：降级普通启动重试一次
      if (sandboxed) { resolve(runCommand(command, Object.assign({}, opts, { sandbox: false }))); return; }
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n[本地执行] " + error.message });
    });
  });
}

/** 超长输出落盘：工作区 .output/ 目录（read_file 可分页读全文）；runCommand 已保证工作区存在 */
function spillOutput(command, exitCode, stdout, stderr) {
  const dir = join(workspaceRoot, ".output");
  mkdirSync(dir, { recursive: true });
  const name = "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7) + ".txt";
  const body = "== " + command + " == (exit " + exitCode + ")\n--- stdout ---\n" + stdout + "\n--- stderr ---\n" + stderr;
  writeFileSync(join(dir, name), body, "utf8");
  return ".output/" + name;
}

// ---------- 本地工作区文件通道（fs/搜索）：与服务端 /api/v2/brain/fs 同款纪律 ----------
const FS_MAX_READ_BYTES = 4 * 1024 * 1024;
const FS_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const FS_MAX_LIST_ENTRIES = 300;
const FS_MAX_GREP_RESULTS = 100;
const FS_MAX_FIND_RESULTS = 200;
const FS_SKIP_DIRS = new Set(["node_modules", ".git", ".output"]);

async function fsList(rel) {
  const dir = resolveSubDir(rel || ".");
  const names = await readdir(dir, { withFileTypes: true });
  const prefix = rel && rel !== "." ? String(rel).replace(/\/+$/, "") + "/" : "";
  const rows = [];
  for (const entry of names.slice(0, FS_MAX_LIST_ENTRIES)) {
    if (entry.isDirectory()) { rows.push({ path: prefix + entry.name, isDir: true }); continue; }
    let size;
    try { size = (await stat(join(dir, entry.name))).size; } catch { size = undefined; }
    rows.push({ path: prefix + entry.name, isDir: false, size });
  }
  rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
  return rows;
}

/** 绝对路径模式（权限模式 auto/full）：直接操作本机任意目录，仍带体积上限 */
function isAbsLike(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("~");
}
async function fsAbs(action, target, nameOrPattern, opts) {
  const abs = resolve(target);
  if (action === "list") {
    const names = await readdir(abs, { withFileTypes: true });
    const rows = [];
    for (const entry of names.slice(0, FS_MAX_LIST_ENTRIES)) {
      if (entry.isDirectory()) { rows.push({ path: entry.name + "/", isDir: true }); continue; }
      let size;
      try { size = (await stat(join(abs, entry.name))).size; } catch { size = undefined; }
      rows.push({ path: entry.name, isDir: false, size });
    }
    rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
    return { entries: rows };
  }
  if (action === "read") {
    const st = await stat(abs);
    if (st.isDirectory()) throw new Error("目标是目录，不是文件：" + target);
    if (st.size > FS_MAX_READ_BYTES) throw new Error("文件超过 4MB 上限，拒绝读取：" + target);
    const lines = (await readFileAsync(abs, "utf8")).split("\n");
    const off = Math.max(1, Math.trunc((opts?.offset ?? 1)));
    const limit = Math.min(2000, Math.max(1, Math.trunc((opts?.limit ?? 500))));
    const win = lines.slice(off - 1, off - 1 + limit);
    return { content: win.join("\n"), truncated: lines.length > off - 1 + win.length, totalLines: lines.length, offset: off, limit };
  }
  if (action === "write") {
    return { error: "write 走下方分支" };
  }
  if (action === "grep") {
    const rx = toSafeRegex(String(nameOrPattern ?? ""));
    if (!rx) return { error: "grep 的正则无效：" + nameOrPattern };
    const max = Math.min(300, Math.max(1, Math.trunc(opts?.maxResults ?? FS_MAX_GREP_RESULTS)));
    const hits = [];
    const stack = [abs];
    while (stack.length && hits.length < max) {
      const d = stack.pop();
      let names;
      try { names = await readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) {
        if (FS_SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.isDirectory()) continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        let st;
        try { st = await stat(full); } catch { continue; }
        if (st.size > 1024 * 1024) continue;
        let text;
        try { text = await readFileAsync(full, "utf8"); } catch { continue; }
        if (text.includes("\u0000")) continue;
        const ls = text.split("\n");
        for (let i = 0; i < ls.length && hits.length < max; i++) {
          if (rx.test(ls[i])) hits.push({ path: full, line: i + 1, text: ls[i].trim().slice(0, 300) });
        }
      }
    }
    return { hits };
  }
  if (action === "find") {
    const rx = toSafeRegex(String(nameOrPattern ?? ""));
    if (!rx) return { error: "find 的模式无效：" + nameOrPattern };
    const max = Math.min(500, Math.max(1, Math.trunc(opts?.maxResults ?? FS_MAX_FIND_RESULTS)));
    const out = [];
    const stack = [abs];
    while (stack.length && out.length < max) {
      const d = stack.pop();
      let names;
      try { names = await readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) {
        if (entry.isDirectory() && (FS_SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))) continue;
        const full = join(d, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (rx.test(entry.name)) out.push(full);
      }
    }
    return { paths: out };
  }
  return { error: "未知 action：" + action };
}

/** 窗口化读文件：offset/limit 按行（1 起）；返回截断标记与总行数 */
async function fsRead(rel, opts) {
  const file = resolveSubDir(rel);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error("目标是目录，不是文件：" + rel);
  if (st.size > FS_MAX_READ_BYTES) throw new Error("文件超过 4MB 上限，拒绝读取：" + rel);
  const lines = (await readFileAsync(file, "utf8")).split("\n");
  const totalLines = lines.length;
  const offset = Math.max(1, Math.trunc(opts?.offset ?? 1));
  const limit = Math.min(2000, Math.max(1, Math.trunc(opts?.limit ?? 500)));
  const win = lines.slice(offset - 1, offset - 1 + limit);
  return { content: win.join("\n"), truncated: totalLines > offset - 1 + win.length, totalLines, offset, limit };
}

async function fsWrite(rel, content, opts) {
  if (typeof content !== "string") throw new Error("write 需要 content 字符串");
  const file = resolveSubDir(rel);
  await mkdir(dirname(file), { recursive: true });
  if (opts?.encoding === "base64") {
    // 二进制写盘（附件落盘）：base64 解码按字节写，上限按解码后体积算
    const buf = Buffer.from(content, "base64");
    if (buf.byteLength > 4 * 1024 * 1024) throw new Error("二进制写入超过 4MB 上限");
    await writeFile(file, buf);
    return;
  }
  if (Buffer.byteLength(content, "utf8") > FS_MAX_WRITE_BYTES) throw new Error("写入内容超过 2MB 上限");
  await writeFile(file, content, "utf8");
}

/** 收集工作区文件列表（跳过依赖目录与隐藏目录，限文件数与体积） */
async function collectFiles(rootRel) {
  const base = resolveSubDir(rootRel);
  const out = [];
  const stack = [base];
  while (stack.length && out.length < 5000) {
    const dir = stack.pop();
    let names;
    try { names = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (!FS_SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) out.push(join(dir, entry.name));
    }
  }
  return out.map((abs) => abs.startsWith(workspaceRoot + sep) ? abs.slice(workspaceRoot.length + 1).replace(/\\/g, "/") : abs);
}

function toSafeRegex(pattern) {
  try { return new RegExp(String(pattern), "i"); } catch { return null; }
}

/** 内容搜索：正则逐行匹配，返回 文件:行号:内容 */
async function fsGrep(pattern, opts) {
  const rx = toSafeRegex(pattern);
  if (!rx) throw new Error("grep 的正则无效：" + pattern);
  const max = Math.min(300, Math.max(1, Math.trunc(opts?.maxResults ?? FS_MAX_GREP_RESULTS)));
  const files = await collectFiles(opts?.path);
  const hits = [];
  for (const rel of files) {
    if (hits.length >= max) break;
    let text;
    try {
      const st = await stat(resolveSubDir(rel));
      if (st.size > 1024 * 1024) continue;
      text = await readFileAsync(resolveSubDir(rel), "utf8");
    } catch { continue; }
    if (text.includes("\u0000")) continue; // 二进制跳过
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < max; i += 1) {
      if (rx.test(lines[i])) hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
  }
  return hits;
}

/** 文件名搜索：递归找匹配的文件（正则或子串） */
async function fsFind(name, opts) {
  const rx = toSafeRegex(name);
  if (!rx) throw new Error("find 的模式无效：" + name);
  const max = Math.min(500, Math.max(1, Math.trunc(opts?.maxResults ?? FS_MAX_FIND_RESULTS)));
  const files = await collectFiles(opts?.path);
  const out = [];
  for (const rel of files) {
    if (out.length >= max) break;
    const base = rel.split("/").pop();
    if (rx.test(base)) out.push(rel);
  }
  return out;
}

// ---------- 服务管理器（与服务端二期同款：detached 子进程 + 日志环 + 端口嗅探 + TTL） ----------
/** 进程树级杀除：Windows 上杀 cmd 壳不会带走子进程，必须 taskkill /T；POSIX 走进程组 */
function killTree(pid) {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    } catch { /* 已退出 */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid); } catch { /* 已退出 */ } }
}
const registry = new Map();
let exitHooked = false;
function hookExitCleanup() {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => {
    for (const rec of registry.values()) {
      killTree(rec.pid);
    }
  };
  process.on("exit", killAll);
  process.on("SIGINT", () => { killAll(); process.exit(130); });
  process.on("SIGTERM", () => { killAll(); process.exit(143); });
}
/** 命令里的候选端口（静默 listen 的 server 不打 URL，靠探活兜底） */
function candidatePorts(command) {
  return [...new Set([...String(command).matchAll(/\b(\d{4,5})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1024 && n <= 65535))].slice(0, 4);
}
async function verifyCandidatePort(rec) {
  if (rec.port !== undefined || rec.status === "exited" || rec.verifying) return;
  const cand = (rec.candidatePorts ?? [])[0];
  if (!cand) return;
  rec.verifying = true;
  try {
    if (await isPortListening(cand)) {
      rec.port = cand;
      rec.url = "http://127.0.0.1:" + cand;
      rec.status = "running";
    }
  } finally { rec.verifying = false; }
}
function appendLog(rec, chunk) {
  if (!rec.decodeOut) rec.decodeOut = makeOutputDecoder();
  rec.log = (rec.log + rec.decodeOut(chunk)).slice(-MAX_SERVICE_LOG_CHARS);
  if (rec.port === undefined) {
    const m = rec.log.match(SERVICE_URL_PATTERN);
    if (m) {
      rec.port = Number(m[1]);
      rec.url = "http://127.0.0.1:" + m[1];
      rec.status = "running";
    }
  }
  void verifyCandidatePort(rec);
}
function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1_200 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function prune() {
  const now = Date.now();
  for (const [id, rec] of registry) {
    if (rec.status === "exited" || rec.expiresAt <= now) {
      killTree(rec.pid);
      registry.delete(id);
    }
  }
}
function toInfo(rec, listening) {
  return {
    id: rec.id,
    command: rec.command,
    pid: rec.pid,
    port: rec.port,
    url: rec.url,
    status: rec.status,
    listening,
    exitCode: rec.exitCode,
    ageMs: Date.now() - rec.createdAt,
    logTail: rec.log.slice(-MAX_TAIL_CHARS),
  };
}
async function startService(command, opts) {
  await ensureWorkspace();
  const cwd = resolveSubDir(opts?.cwd);
  prune();
  const mine = [...registry.values()];
  if (mine.length >= MAX_SERVICES) {
    throw new Error("同时运行的服务已达上限（" + MAX_SERVICES + " 个），请先停掉一个再启动新的。");
  }
  for (const r of mine) {
    if (r.command === command && r.status !== "exited") {
      throw new Error("同一命令的服务已在运行（id=" + r.id + (r.url ? "，地址 " + r.url : "") + "），请先停掉它或改用其他端口。");
    }
  }
  const ttlMs = Math.min(Math.max(opts?.ttlMs ?? SERVICE_DEFAULT_TTL_MS, 60_000), SERVICE_MAX_TTL_MS);
  const isWindows = process.platform === "win32";
  // 同 runCommand：powershell -EncodedCommand 免引号破坏
  const shellFile = isWindows ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", toPsEncoded(sanitizeCommandForPs51(command))] : ["-c", command];
  // stdin 必须 ignore：powershell 继承管道会向 stderr 喷 CLIXML 进度流污染日志
  const child = spawn(shellFile, shellArgs, {
    cwd,
    env: minimalEnv(cwd, isWindows),
    windowsHide: true,
    /** stdin ignore：powershell 继承管道会向 stderr 喷 CLIXML 进度流污染日志 */
    stdio: ["ignore", "pipe", "pipe"],
    /** Windows 上 detached 会断 stdout 管道且无保活收益，仅 POSIX 用（setsid 便于进程组杀除） */
    detached: !isWindows,
  });
  const rec = {
    id: "svc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    command,
    candidatePorts: candidatePorts(command),
    pid: child.pid ?? -1,
    status: "starting",
    log: "",
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  registry.set(rec.id, rec);
  if (opts?.annotate) Object.assign(rec, opts.annotate); // SVC2
  hookExitCleanup();
  child.stdout?.on("data", (chunk) => appendLog(rec, chunk));
  child.stderr?.on("data", (chunk) => appendLog(rec, chunk));
  child.on("close", (code) => { rec.status = "exited"; rec.exitCode = code ?? 1; });
  child.on("error", (error) => {
    rec.status = "exited";
    rec.exitCode = 1;
    appendLog(rec, Buffer.from("[服务] 启动失败：" + error.message + "\n", "utf8"));
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_PROBE_TIMEOUT_MS) {
    if (rec.status === "exited") break;
    if (rec.port !== undefined && (await isPortListening(rec.port))) break;
    await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
  }
  return toInfo(rec);
}
async function stopService(serviceId) {
  const rec = registry.get(serviceId);
  if (!rec) return null;
  if (rec.status !== "exited") {
    try { process.kill(rec.pid); } catch { /* 已退出 */ }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && processAlive(rec.pid)) {
      await new Promise((r) => setTimeout(r, 80));
    }
    if (processAlive(rec.pid)) {
      killTree(rec.pid);
    }
    rec.status = "exited";
    if (rec.exitCode === undefined) rec.exitCode = 0;
  }
  const info = toInfo(rec);
  registry.delete(serviceId);
  return info;
}
async function listServices(serviceId) {
  prune();
  const rows = [...registry.values()].filter((r) => serviceId === undefined || r.id === serviceId);
  const out = [];
  for (const rec of rows) {
    if (rec.status !== "exited" && !processAlive(rec.pid)) {
      rec.status = "exited";
      if (rec.exitCode === undefined) rec.exitCode = -1;
    }
    await verifyCandidatePort(rec);
    const listening = rec.port !== undefined && rec.status !== "exited" ? await isPortListening(rec.port) : undefined;
    out.push(toInfo(rec, listening));
  }
  out.sort((a, b) => b.ageMs - a.ageMs);
  return out;
}

// ---------- 对外 API（main.mjs 调用） ----------
let userDataDir = ""; // SVC1
export function initLocalRuntime(userDataPath) {
  userDataDir = userDataPath;
  workspaceRoot = join(userDataPath, "brain-workspace", "workspace");
}
/** 本地工作区文件通道（list/read/write/grep/find）：read_file / grep_files / find_files 走这里 */
export async function handleFsPayload(payload) {
  try {
    await ensureWorkspace();
    const action = String(payload?.action ?? "");
    const rel = typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : ".";
    if (rel.length > 1000) return { error: "路径过长" };
    // 权限模式：default=仅工作区；auto=越界只读自动放行；full=本机任意读写
    const fsMode = String(payload?.mode ?? "default");
    const scanRoot = action === "grep" || action === "find" ? String(payload?.opts?.path ?? ".") : rel;
    if (isAbsLike(scanRoot)) {
      const readLike = action !== "write";
      if (fsMode === "full" || (fsMode === "auto" && readLike)) {
        if (action === "write") {
          const content = payload?.content;
          if (typeof content !== "string") return { error: "write 需要 content 字符串" };
          const abs = resolve(rel);
          await mkdir(dirname(abs), { recursive: true });
          if (payload?.opts?.encoding === "base64") {
            const buf = Buffer.from(content, "base64");
            if (buf.byteLength > 4 * 1024 * 1024) return { error: "二进制写入超过 4MB 上限" };
            await writeFile(abs, buf);
            return { ok: true };
          }
          if (Buffer.byteLength(content, "utf8") > FS_MAX_WRITE_BYTES) return { error: "写入内容超过 2MB 上限" };
          await writeFile(abs, content, "utf8");
          return { ok: true };
        }
        return await fsAbs(action, scanRoot, rel, payload?.opts);
      }
      return { error: "路径在工作区之外：把权限模式切到“全部访问”（只读操作“自动审批”即可）后再试" };
    }
    if (action === "list") return { entries: await fsList(rel) };
    if (action === "read") return await fsRead(rel, payload?.opts);
    if (action === "write") { await fsWrite(rel, payload?.content, payload?.opts); return { ok: true }; }
    if (action === "grep") return { hits: await fsGrep(rel, payload?.opts) };
    if (action === "find") return { paths: await fsFind(rel, payload?.opts) };
    return { error: "未知 action：" + action };
  } catch (error) {
    return { error: "文件操作失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}

/** 提取命令中的写/删意图目标（与 app/lib/brain-sandbox.ts 同名函数保持同步维护） */
function extractWriteTargets(scan) {
  const targets = [];
  for (const m of scan.matchAll(/>>?\s*([^|;&<>\s"']+)/g)) targets.push(m[1]);
  const verbs = /\b(?:Out-File|Set-Content|Add-Content|New-Item|Move-Item|Copy-Item|Remove-Item|mkdir|md|touch|cp|mv|del|erase)\b\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]+\s+)?([^\s;|&"']+)/gi;
  for (const m of scan.matchAll(verbs)) targets.push(m[1]);
  return targets;
}
function isOutsideAbsPath(t) {
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^~[\\/]/.test(t)) return true;
  if (/^\/(?!tmp(\/|$))/.test(t)) return true;
  if (/^\\\\[^\s]/.test(t)) return true;
  return false;
}
/** 硬沙箱路径围栏：写/删意图命中工作区外绝对路径 → 返回越界清单 */
function checkPathFence(command) {
  const scan = normalizeCommandForRisk(command);
  const rootWin = path.win32.normalize(workspaceRoot || ".");
  const rootPosix = (workspaceRoot || ".").replace(/\\/g, "/");
  const outside = [];
  for (const raw of extractWriteTargets(scan)) {
    const t = raw.replace(/^["']+|["']+$/g, "");
    if (!isOutsideAbsPath(t)) continue;
    const normWin = path.win32.normalize(t);
    const normPosix = t.replace(/\\/g, "/");
    const inWs = normWin === rootWin || normWin.startsWith(rootWin + "\\") || normPosix === rootPosix || normPosix.startsWith(rootPosix + "/");
    if (!inWs) outside.push(t);
  }
  return outside;
}
export async function handleCommandPayload(payload) {
  const command = String(payload?.command ?? "").trim();
  if (!command) return { error: "command 不能为空" };
  // 硬沙箱路径围栏：写/删指向工作区外 → 未批准拦截（批准=老板确认边界）
  const fenceHits = checkPathFence(command);
  if (fenceHits.length > 0 && payload?.approved !== true) {
    return { error: "该命令会写入/删除工作区之外的文件，需要老板批准", code: "approval_required", reasons: fenceHits.map((p) => "路径围栏：工作区外写入 " + p) };
  }
  const risk = classifyRisk(command);
  if (risk.level === "blocked") {
    return { error: "命令被安全策略拦截（" + risk.reasons.join("、") + "），请改用可恢复的做法。", code: "blocked", reasons: risk.reasons };
  }
  if (risk.level === "needs_approval" && payload?.approved !== true) {
    return { error: "该命令需要老板批准后才能执行", code: "approval_required", reasons: risk.reasons };
  }
  try {
    // 只读系统探查（端口/进程定位）绕过低完整性沙箱：受限子进程读不了进程启动信息
    const probeOnly = isSystemProbeCommand(command);
    return await runCommand(command, { timeoutMs: payload?.timeoutMs, cwd: payload?.cwd, sandbox: probeOnly ? false : undefined });
  } catch (error) {
    cancelAllCommands();
    return { error: "命令执行失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}
export async function handleServicePayload(payload) {
  const action = String(payload?.action ?? "");
  if (action === "start") {
    const command = String(payload?.command ?? "").trim();
    if (!command) return { error: "command 不能为空" };
    if (command.length > 2000) return { error: "command 过长（上限 2000 字符）" };
    const svcFenceHits = checkPathFence(command);
    if (svcFenceHits.length > 0 && payload?.approved !== true) {
      return { error: "该服务命令会写入工作区之外的文件，需要老板批准", code: "approval_required", reasons: svcFenceHits.map((p) => "路径围栏：工作区外写入 " + p) };
    }
    const risk = classifyRisk(command);
    if (risk.level === "blocked") {
      return { error: "启动命令被安全策略拦截（" + risk.reasons.join("、") + "）。", code: "blocked", reasons: risk.reasons };
    }
    if (risk.level === "needs_approval" && payload?.approved !== true) {
      return { error: "启动该服务需要老板批准后才能执行", code: "approval_required", reasons: risk.reasons };
    }
    try {
      return await startService(command, { ttlMs: payload?.ttlMs, cwd: payload?.cwd });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (action === "stop") {
    const id = String(payload?.id ?? "");
    const info = await stopService(id);
    if (!info) return { error: "服务不存在或已停止（id=" + id + "）" };
    return info;
  }
  if (action === "status") {
    const services = await listServices(payload?.id ? String(payload.id) : undefined);
    return { services };
  }
  if (action === "setup") { // SVC3 local service provision (setup_service)
  if (payload?.approved !== true) return { error: "搭建本地服务需要老板批准后才能执行", code: "approval_required", reasons: ["setup_service:" + String(payload?.kind || "")] };
  await ensureWorkspace();
  try {
    return await provisionService(payload, {
      workspaceRoot,
      runtimeRoots: [join(dirname(import.meta.dirname), ".local-runtime"), join(userDataDir, ".local-runtime"), join(workspaceRoot, ".local-runtime")],
      resolveSubDir: (rel) => { try { return resolveSubDir(rel); } catch { return workspaceRoot; } },
      getServiceInfo: (id) => { const r = registry.get(id); return r ? toInfo(r) : null; },
      registerService: async (command, opts) => {
        if (opts?.gated !== false) {
          const fence = checkPathFence(command);
          if (fence.length > 0) return { error: "该命令会写入工作区之外，被搭建通道拒绝", code: "blocked", reasons: fence.map((p) => "路径围栏：" + p) };
          const risk = classifyRisk(command);
          if (risk.level === "blocked") return { error: "命令被安全策略拦截（" + risk.reasons.join("、") + "）", code: "blocked", reasons: risk.reasons };
          if (risk.level === "needs_approval") return { error: "该命令风险较高，搭建通道不代执行，请老板批准后走 run_command", code: "approval_required", reasons: risk.reasons };
        }
        try {
          return await startService(command, { cwd: opts?.cwd, ttlMs: opts?.ttlMs, annotate: opts?.annotate });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
  } catch (error) {
    return { error: "搭建失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}
if (action === "setups") { // SVC3 provisioned services + protocol health recheck
  const infos = readServiceInfos(workspaceRoot);
  const setups = [];
  for (const info of infos) setups.push(Object.assign({}, info, await recheckHealth(info, {})));
  return { setups };
}
return { error: "未知 action：" + action };
}
/** 本机落盘（模块3）：把最近代码产物写入工作区程序目录，返回目录名（相对工作区） */
export async function handleDeployPayload(payload) {
  try {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!files.length) return { error: "没有可落盘的文件：先 write_code 产出代码产物。" };
    if (files.length > 100) return { error: "文件数超过上限（100）。" };
    const name = String(payload?.name ?? "").trim();
    const slug = (name.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "program";
    const dir = slug + "-" + Date.now().toString(36);
    const base = join(await ensureWorkspace(), dir);
    await mkdir(base, { recursive: true });
    let total = 0;
    for (const f of files) {
      const rel = String(f?.path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const content = typeof f?.content === "string" ? f.content : "";
      if (!rel || rel.includes("..")) return { error: "非法文件路径：" + String(f?.path ?? "") };
      if (content.length > 2_000_000) return { error: "单文件过大（>2MB）：" + rel };
      total += content.length;
      if (total > 8_000_000) return { error: "文件总量过大（>8MB）。" };
      const abs = resolve(base, rel);
      if (!abs.startsWith(base + sep)) return { error: "文件路径越界：" + rel };
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    return { dir, fileCount: files.length };
  } catch (error) {
    return { error: "本机落盘失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}

/** 本地探活（模块2）：环回限定 fetch——仅允许 http://127.0.0.1 / localhost / [::1] */
export async function handleFetchPayload(payload) {
  const rawUrl = String(payload?.url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { error: "无效 URL：" + rawUrl };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    return { error: "本地探活通道仅限 http 环回地址（127.0.0.1 / localhost）。" };
  }
  try {
    const response = await fetch(parsed.toString(), { redirect: "follow", signal: AbortSignal.timeout(8_000) });
    const text = ((await response.text()) || "").slice(0, 200_000);
    return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type") || "", text };
  } catch (error) {
    return { error: "本地探活失败：" + (error instanceof Error ? error.message : String(error)) };
  }
}

export function shutdownLocalServices() {
  for (const rec of registry.values()) {
    killTree(rec.pid);
  }
  registry.clear();
}
