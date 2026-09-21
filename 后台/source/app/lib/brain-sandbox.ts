/**
 * 小逻大脑受控执行沙箱（fs / command / git 服务端实现共用）。
 *
 * isolated-worker 走 package 管线（需 package key + 完整性校验，ephemeral
 * 文件系统、禁网络），承载不了持久化工作区；这里复用它的执行纪律：
 * 独立 cwd、最小 env、wall time 上限、输出截断、路径防穿越。
 * 每个用户拥有隔离的持久工作区：.data/brain-workspace/<userId>/workspace。
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { seedUserSkills, seedOfficialMarket } from "./seed-skills";
import { provisionService, readServiceInfos, recheckHealth } from "../../shared/service-provision.mjs"; // SVCB0

const WORKSPACE_ROOT = path.join(process.cwd(), ".data", "brain-workspace");
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 300;
const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_WALL_TIME_MS = 120_000;
const MAX_WALL_TIME_MS = 300_000;
/** 输出超过该字符数时全文落盘 .output/，供 read_file 分页查看 */
const OUTPUT_SPILL_THRESHOLD = 2_500;
const MAX_GREP_RESULTS = 100;
const MAX_FIND_RESULTS = 200;
const SKIP_SEARCH_DIRS = new Set(["node_modules", ".git", ".output"]);

const execFileAsync = promisify(execFile);

function sanitizeOwner(userId: string): string {
  return userId.replace(/[^A-Za-z0-9._-]/g, "_") || "anonymous";
}

/** 用户的隔离持久工作区根目录（可能尚未创建） */
export function brainWorkspaceRoot(userId: string): string {
  return path.join(WORKSPACE_ROOT, sanitizeOwner(userId), "workspace");
}

export async function ensureWorkspace(userId: string): Promise<string> {
  const root = brainWorkspaceRoot(userId);
  await fs.mkdir(root, { recursive: true });
  await seedUserSkills(root).catch(() => {});
  return root;
}

/** 相对路径解析 + 防穿越校验，越界直接抛错 */
function resolveInWorkspace(userId: string, relPath: string): string {
  const root = brainWorkspaceRoot(userId);
  const cleaned = (relPath || ".").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolved = path.resolve(root, cleaned || ".");
  const rel = path.relative(root, resolved);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error("路径越界：只能访问大脑工作区内的文件");
  }
  return resolved;
}

export interface SandboxFileEntry {
  path: string;
  isDir: boolean;
  size?: number;
}

/** 权限模式 full/auto 下允许直接操作工作区外绝对路径（体积上限不变） */
function resolveWithMode(userId: string, relPath: string, mode: string | undefined, requireWrite: boolean): string {
  const isAbs = /^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith("/");
  if (!isAbs) return resolveInWorkspace(userId, relPath);
  if (mode === "full") return path.normalize(relPath);
  if (mode === "auto" && !requireWrite) return path.normalize(relPath);
  throw new Error("路径在工作区之外：把权限模式切到“全部访问”（只读操作“自动审批”即可）后再试");
}

export async function listSandboxDir(
  userId: string,
  relPath: string,
  mode?: string,
): Promise<SandboxFileEntry[]> {
  const dir = resolveWithMode(userId, relPath, mode, false);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const prefix = relPath && relPath !== "." ? relPath.replace(/\/+$/, "") + "/" : "";
  const rows: SandboxFileEntry[] = [];
  for (const entry of entries.slice(0, MAX_LIST_ENTRIES)) {
    if (entry.isDirectory()) {
      rows.push({ path: prefix + entry.name, isDir: true });
      continue;
    }
    let size: number | undefined;
    try {
      size = (await fs.stat(path.join(dir, entry.name))).size;
    } catch {
      size = undefined;
    }
    rows.push({ path: prefix + entry.name, isDir: false, size });
  }
  rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
  return rows;
}

export interface FsReadWindowOpts {
  /** 窗口起始行（1 起，默认 1） */
  offset?: number;
  /** 读取行数（默认 500，上限 2000） */
  limit?: number;
}

/** 窗口化读文件：返回窗口内容 + 截断标记 + 总行数（防大文件撑爆上下文） */
export async function readSandboxFile(
  userId: string,
  relPath: string,
  opts?: FsReadWindowOpts,
  mode?: string,
): Promise<{ content: string; truncated: boolean; totalLines: number }> {
  const file = resolveWithMode(userId, relPath, mode, false);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error("目标是目录，不是文件");
  if (stat.size > MAX_READ_BYTES) {
    throw new Error("文件超过 4MB 上限，拒绝读取");
  }
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  const totalLines = lines.length;
  const offset = Math.max(1, Math.trunc(opts?.offset ?? 1));
  const limit = Math.min(2000, Math.max(1, Math.trunc(opts?.limit ?? 500)));
  const win = lines.slice(offset - 1, offset - 1 + limit);
  return { content: win.join("\n"), truncated: totalLines > offset - 1 + win.length, totalLines };
}

export async function writeSandboxFile(
  userId: string,
  relPath: string,
  content: string,
  opts?: { encoding?: "base64" },
  mode?: string,
): Promise<void> {
  const file = resolveWithMode(userId, relPath, mode, true);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (opts?.encoding === "base64") {
    // 二进制写盘（附件落盘）：base64 解码按字节写，上限按解码后体积算
    const buf = Buffer.from(content, "base64");
    if (buf.byteLength > 4 * 1024 * 1024) {
      throw new Error("二进制写入超过 4MB 上限");
    }
    await fs.writeFile(file, buf);
    return;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("写入内容超过 512KB 上限");
  }
  await fs.writeFile(file, content, "utf8");
}

// ---------- 工作区搜索（grep_files / find_files 的服务端实现） ----------

/** 收集工作区文件（跳过依赖/隐藏目录，限数量与单文件体积） */
async function collectWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < 5000) {
    const dir = stack.pop() as string;
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_SEARCH_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function toSafeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export interface SandboxGrepHit {
  path: string;
  line: number;
  text: string;
}

/** 内容搜索：正则逐行匹配，返回 文件:行号:内容 */
export async function grepSandboxFiles(
  userId: string,
  pattern: string,
  opts?: { path?: string; maxResults?: number },
  mode?: string,
): Promise<SandboxGrepHit[]> {
  const rx = toSafeRegex(pattern);
  if (!rx) throw new Error("grep 的正则无效：" + pattern);
  const root = resolveWithMode(userId, opts?.path || ".", mode, false);
  const workspace = brainWorkspaceRoot(userId);
  const max = Math.min(300, Math.max(1, Math.trunc(opts?.maxResults ?? MAX_GREP_RESULTS)));
  const files = await collectWorkspaceFiles(root);
  const hits: SandboxGrepHit[] = [];
  for (const abs of files) {
    if (hits.length >= max) break;
    let text: string;
    try {
      const st = await fs.stat(abs);
      if (st.size > 1024 * 1024) continue;
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < max; i += 1) {
      if (rx.test(lines[i])) {
        const rel = path.relative(workspace, abs).replace(/\\/g, "/");
        hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
      }
    }
  }
  return hits;
}

/** 文件名搜索：递归找匹配的文件（正则） */
export async function findSandboxFiles(
  userId: string,
  name: string,
  opts?: { path?: string; maxResults?: number },
  mode?: string,
): Promise<string[]> {
  const rx = toSafeRegex(name);
  if (!rx) throw new Error("find 的模式无效：" + name);
  const root = resolveWithMode(userId, opts?.path || ".", mode, false);
  const workspace = brainWorkspaceRoot(userId);
  const max = Math.min(500, Math.max(1, Math.trunc(opts?.maxResults ?? MAX_FIND_RESULTS)));
  const files = await collectWorkspaceFiles(root);
  const out: string[] = [];
  for (const abs of files) {
    if (out.length >= max) break;
    if (rx.test(path.basename(abs))) out.push(path.relative(workspace, abs).replace(/\\/g, "/"));
  }
  return out;
}

// ---------- run_command 风险分级（单份策略：shared/command-policy.mjs，与桌面端共享） ----------

export type CommandRiskLevel = "safe" | "needs_approval" | "blocked";

// 学 Codex execpolicy：规则、wrapper 深度展开、自带用例自测全部收敛到 shared/command-policy.mjs，
// 服务端与桌面端共用一份，消灭双份手工同步漂移。
import {
  classifyCommandRisk as classifyCommandRiskShared,
  normalizeCommandForRisk,
  selfTestPolicy,
} from "../../shared/command-policy.mjs";

// 加载期自测：用例失败只告警不阻断（规则本身仍生效）
const policySelfTestFailures = selfTestPolicy() as string[];
if (policySelfTestFailures.length > 0) {
  console.error("[command-policy] 策略自测失败：" + policySelfTestFailures.join("；"));
}

/** 裸命令分级（run_command 用）：薄封装，委托共享策略（含 wrapper 深度展开 + 语法分析） */
export function classifyCommandRisk(command: string): { level: CommandRiskLevel; reasons: string[] } {
  const r = classifyCommandRiskShared(command) as { level: string; reasons: string[] };
  return { level: r.level as CommandRiskLevel, reasons: r.reasons };
}

// ---------- 硬沙箱路径围栏：命令里的写/删意图路径不得指向工作区外（未批准时拦截） ----------

/** 提取命令中的写/删意图目标：重定向落点 + 写删动词的首个路径参数 */
function extractWriteTargets(scan: string): string[] {
  const targets: string[] = [];
  for (const m of scan.matchAll(/>>?\s*([^|;&<>\s"']+)/g)) targets.push(m[1]);
  const verbs = /\b(?:Out-File|Set-Content|Add-Content|New-Item|Move-Item|Copy-Item|Remove-Item|mkdir|md|touch|cp|mv|del|erase)\b\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]+\s+)?([^\s;|&"']+)/gi;
  for (const m of scan.matchAll(verbs)) targets.push(m[1]);
  return targets;
}

/** 是否工作区外绝对路径（POSIX 的 /tmp 视为合法暂存，放行） */
function isOutsideAbsPath(t: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^~[\\/]/.test(t)) return true;
  if (/^\/(?!tmp(\/|$))/.test(t)) return true;
  if (/^\\\\[^\s]/.test(t)) return true;
  return false;
}

/**
 * 硬沙箱路径围栏（与 desktop/local-runtime.mjs 的同名函数保持同步维护）：
 * 写/删意图命中工作区外绝对路径 → 返回越界路径清单；调用侧未获老板批准时拦截。
 * 读意图不查（工具链天然要读系统目录）；相对路径靠 cwd 监狱兜底。
 */
export function checkPathFence(command: string, workspaceRoot: string): string[] {
  const scan = normalizeCommandForRisk(command);
  const rootWin = path.win32.normalize(workspaceRoot || ".");
  const rootPosix = (workspaceRoot || ".").replace(/\\/g, "/");
  const outside: string[] = [];
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

// ---------- run_command：受控 shell 执行（复用 isolated-worker 的执行纪律） ----------

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 输出超长时全文落盘的相对路径（read_file 可分页读全文） */
  spillPath?: string;
}

function minimalEnv(cwd: string, isWindows: boolean): NodeJS.ProcessEnv {
  return isWindows
    ? {
        // PowerShell 命令查找依赖 PATHEXT（识别 node.exe）；node 目录补进 PATH 防宿主环境缺失
        PATH: (process.env.PATH ?? "").split(";").includes(path.dirname(process.execPath)) ? process.env.PATH ?? "" : path.dirname(process.execPath) + ";" + (process.env.PATH ?? ""),
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        USERPROFILE: cwd,
        NODE_ENV: "production",
      }
    : {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: cwd,
        TMPDIR: cwd,
        NODE_ENV: "production",
      };
}
/** powershell -EncodedCommand 载荷：UTF-16LE base64；前置 OutputEncoding=UTF8 让子进程输出按 UTF-8 解码 */
function toPsEncoded(command: string): string {
  const ps = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + command;
  return Buffer.from(ps, "utf16le").toString("base64");
}

/** PowerShell 5.1 不支持 bash 式 && / || 链：降级为分号串联，避免整串解析错的 CLIXML 噪声 */
function sanitizeCommandForPs51(command: string): string {
  return command.split("&&").join(";").split("||").join(";");
}

/** 子进程输出解码：剥掉 PS 非交互 stderr 的 CLIXML 序列化包装；非 UTF-8 字节回退系统代码页（中文 Windows 为 GBK） */
function decodeShellChunk(chunk: Buffer): string {
  let text = chunk.toString("utf8");
  if (text.includes("#< CLIXML")) {
    text = text
      .replace(/#< CLIXML[^\r\n]*/g, "")
      .replace(/<Objs[\s\S]*?<\/Objs>/g, "")
      .replace(/_x000D_/g, "\r")
      .replace(/_x000A_/g, "\n")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
  }
  if (text.includes("\uFFFD")) {
    try {
      const dec = new TextDecoder("gbk");
      text = dec.decode(chunk);
    } catch { /* 解码器不可用保持原样 */ }
  }
  return text;
}

/**
 * 在用户工作区内以最小 env 执行 shell 命令。
 * 纪律对齐 isolated-worker：独立 cwd、wall time 上限、输出截断、无密钥注入。
 */
export function runSandboxedCommand(
  userId: string,
  command: string,
  opts?: { timeoutMs?: number },
): Promise<SandboxCommandResult> {
  return ensureWorkspace(userId).then((cwd) => {
    const timeoutMs = Math.min(
      MAX_WALL_TIME_MS,
      Math.max(2_000, opts?.timeoutMs ?? DEFAULT_WALL_TIME_MS),
    );
    const isWindows = process.platform === "win32";
    // Windows 走 powershell -EncodedCommand（UTF-16LE base64）：彻底绕开 cmd 引号模型，带引号命令不再被破坏
    const shellFile = isWindows ? "powershell.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", toPsEncoded(sanitizeCommandForPs51(command))] : ["-c", command];
    const child = spawn(shellFile, shellArgs, {
      cwd,
      env: minimalEnv(cwd, isWindows),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (typeof child.pid === "number") activeCommandPids.add(child.pid);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const next = (key === "stdout" ? stdout : stderr) + decodeShellChunk(chunk);
      if (key === "stdout") stdout = next.slice(0, MAX_OUTPUT_CHARS);
      else stderr = next.slice(0, MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timer = setTimeout(() => {
      killed = true;
      // Windows 上必须进程树杀除：只杀 cmd 壳时孙进程仍持管道，close 迟迟不触发
      if (typeof child.pid === "number") killTree(child.pid);
    }, timeoutMs);
    return new Promise<SandboxCommandResult>((resolve) => {
      child.on("close", async (code) => {
        clearTimeout(timer);
        if (typeof child.pid === "number") activeCommandPids.delete(child.pid);
        if (killed) {
          stderr = stderr + "\n[沙箱] 命令超过 " + Math.round(timeoutMs / 1000) + " 秒被强制终止";
        }
        const exitCode = killed ? 124 : code ?? 1;
        let spillPath: string | undefined;
        try {
          if (stdout.length + stderr.length > OUTPUT_SPILL_THRESHOLD) {
            spillPath = await spillSandboxOutput(cwd, command, exitCode, stdout, stderr);
          }
        } catch { /* 落盘失败不影响结果回流 */ }
        resolve({ exitCode, stdout, stderr, spillPath });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (typeof child.pid === "number") activeCommandPids.delete(child.pid);
        resolve({ exitCode: 1, stdout, stderr: stderr + "\n[沙箱] " + error.message });
      });
    });
  });
}
/** 超长输出落盘：工作区 .output/ 目录，返回相对路径（read_file 可分页读） */
async function spillSandboxOutput(
  cwd: string,
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): Promise<string> {
  const dir = path.join(cwd, ".output");
  await fs.mkdir(dir, { recursive: true });
  const name = "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7) + ".txt";
  const body = [
    "== " + command + " == (exit " + exitCode + ")",
    "--- stdout ---",
    stdout,
    "--- stderr ---",
    stderr,
  ].join(String.fromCharCode(10));
  await fs.writeFile(path.join(dir, name), body, "utf8");
  return ".output/" + name;
}

// ---------- 二期：服务管理器（长驻 dev server 的启动 / 探活 / 日志回读） ----------

import { createConnection } from "node:net";

/** 进程树级杀除：Windows 上杀 cmd 壳不会带走子进程，必须 taskkill /T；POSIX 走进程组 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    } catch { /* 已退出 */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid); } catch { /* 已退出 */ } }
}

/** 在途命令子进程登记：DELETE 取消时整树杀除 */
const activeCommandPids = new Set<number>();
export function cancelSandboxedCommands(): void {
  for (const pid of activeCommandPids) {
    try { killTree(pid); } catch { /* 已退出 */ }
  }
  activeCommandPids.clear();
}

const MAX_SERVICES_PER_USER = 3;
const MAX_SERVICE_LOG_CHARS = 6_000;
const MAX_TAIL_CHARS = 2_000;
const SERVICE_DEFAULT_TTL_MS = 30 * 60_000;
const SERVICE_MAX_TTL_MS = 4 * 60 * 60_000;
const READY_PROBE_TIMEOUT_MS = 35_000;
const READY_PROBE_INTERVAL_MS = 350;
/** 从启动日志里嗅探服务地址（Next/Vite/http.server/Express 常见口径） */
const SERVICE_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i;

export interface ServiceRecord {
  id: string;
  userId: string;
  command: string;
  pid: number;
  port?: number;
  url?: string;
  status: "starting" | "running" | "exited";
  exitCode?: number;
  log: string;
  createdAt: number;
  expiresAt: number;
  /** 命令里提取的候选端口（静默 listen 的 server 不打 URL，靠探活兜底） */
  candidatePorts?: number[];
  verifying?: boolean;
}

/** 模块级注册表：dev 模式 HMR 会换模块实例，挂 globalThis 保跨重载存活 */
function serviceRegistry(): Map<string, ServiceRecord> {
  const g = globalThis as unknown as { __xiaoluoBrainServices?: Map<string, ServiceRecord> };
  if (!g.__xiaoluoBrainServices) g.__xiaoluoBrainServices = new Map();
  return g.__xiaoluoBrainServices;
}

let processExitHooked = false;
function hookProcessExitCleanup(): void {
  if (processExitHooked) return;
  processExitHooked = true;
  const killAll = () => {
    for (const rec of serviceRegistry().values()) {
      killTree(rec.pid);
    }
  };
  process.on("exit", killAll);
  process.on("SIGINT", () => { killAll(); process.exit(130); });
  process.on("SIGTERM", () => { killAll(); process.exit(143); });
}

/** 命令里的候选端口（4-5 位数字，防误伤只取前 4 个） */
function candidatePorts(command: string): number[] {
  return [...new Set([...String(command).matchAll(/\b(\d{4,5})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1024 && n <= 65535))].slice(0, 4);
}

async function verifyCandidatePort(rec: ServiceRecord): Promise<void> {
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

function appendServiceLog(rec: ServiceRecord, chunk: Buffer): void {
  rec.log = (rec.log + decodeShellChunk(chunk)).slice(-MAX_SERVICE_LOG_CHARS);
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

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1_200 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

function pruneServices(userId: string): void {
  const now = Date.now();
  for (const [id, rec] of serviceRegistry()) {
    if (rec.userId !== userId) continue;
    if (rec.status === "exited" || rec.expiresAt <= now) {
      killTree(rec.pid);
      serviceRegistry().delete(id);
    }
  }
}

export interface ServiceInfo {
  id: string;
  command: string;
  pid: number;
  port?: number;
  url?: string;
  status: ServiceRecord["status"];
  listening?: boolean;
  exitCode?: number;
  ageMs: number;
  logTail: string;
}

function toServiceInfo(rec: ServiceRecord, listening?: boolean): ServiceInfo {
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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 启动长驻服务：detached 子进程 + 日志环形缓冲 + 端口嗅探 + 就绪轮询 */
export async function startBrainService(
  userId: string,
  command: string,
  opts?: { ttlMs?: number; cwd?: string },
): Promise<ServiceInfo> {
  const root = await ensureWorkspace(userId);
  // AUTO-SVC-SYNC：cwd 相对工作区（deploy_program 的部署目录）；围栏限制在工作区内防穿越
  let cwd = root;
  if (opts?.cwd) {
    const target = path.resolve(root, opts.cwd);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error("服务启动目录越出工作区围栏：" + opts.cwd);
    }
    await fs.mkdir(target, { recursive: true });
    cwd = target;
  }
  pruneServices(userId);
  const registry = serviceRegistry();
  const mine = [...registry.values()].filter((r) => r.userId === userId);
  if (mine.length >= MAX_SERVICES_PER_USER) {
    throw new Error("同时运行的服务已达上限（" + MAX_SERVICES_PER_USER + " 个），请先停掉一个再启动新的。");
  }
  for (const r of mine) {
    if (r.command === command && r.status !== "exited") {
      throw new Error("同一命令的服务已在运行（id=" + r.id + (r.url ? "，地址 " + r.url : "") + "），请先停掉它或改用其他端口。");
    }
  }
  const ttlMs = Math.min(Math.max(opts?.ttlMs ?? SERVICE_DEFAULT_TTL_MS, 60_000), SERVICE_MAX_TTL_MS);
  const isWindows = process.platform === "win32";
  // 同 runSandboxedCommand：powershell -EncodedCommand 免引号破坏
  const shellFile = isWindows ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", toPsEncoded(sanitizeCommandForPs51(command))] : ["-c", command];
  const child = spawn(shellFile, shellArgs, {
    cwd,
    env: minimalEnv(cwd, isWindows),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });
  const rec: ServiceRecord = {
    id: "svc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    userId,
    command,
    candidatePorts: candidatePorts(command),
    pid: child.pid ?? -1,
    status: "starting",
    log: "",
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  registry.set(rec.id, rec);
  hookProcessExitCleanup();
  child.stdout?.on("data", (chunk: Buffer) => appendServiceLog(rec, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendServiceLog(rec, chunk));
  child.on("close", (code) => {
    rec.status = "exited";
    rec.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    rec.status = "exited";
    rec.exitCode = 1;
    appendServiceLog(rec, Buffer.from("[服务] 启动失败：" + error.message + "\n", "utf8"));
  });
  child.unref();
  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_PROBE_TIMEOUT_MS) {
    if (rec.status === "exited") break;
    await verifyCandidatePort(rec);
    if (rec.port !== undefined && (await isPortListening(rec.port))) break;
    await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
  }
  return toServiceInfo(rec);
}

/** 停止服务：先正常终止，500ms 后仍在则强杀 */
export async function stopBrainService(userId: string, serviceId: string): Promise<ServiceInfo | null> {
  const rec = serviceRegistry().get(serviceId);
  if (!rec || rec.userId !== userId) return null;
  if (rec.status !== "exited") {
    // Windows 上直接整树杀：process.kill 只杀 powershell 壳，node 孤儿进程会继续占端口，
    // 导致 AUTO-SVC-SYNC 重启撞 EADDRINUSE（探针实测）；POSIX 先 SIGTERM 进程组，未退再强杀
    killTree(rec.pid);
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
  const info = toServiceInfo(rec);
  serviceRegistry().delete(serviceId);
  return info;
}

/** 查询服务状态：id 缺省返回该用户全部；带端口时顺带探活 */
export async function listBrainServices(userId: string, serviceId?: string): Promise<ServiceInfo[]> {
  pruneServices(userId);
  const rows = [...serviceRegistry().values()].filter(
    (r) => r.userId === userId && (serviceId === undefined || r.id === serviceId),
  );
  const out: ServiceInfo[] = [];
  for (const rec of rows) {
    if (rec.status !== "exited" && !processAlive(rec.pid)) {
      rec.status = "exited";
      if (rec.exitCode === undefined) rec.exitCode = -1;
    }
    await verifyCandidatePort(rec);
    const listening = rec.port !== undefined && rec.status !== "exited" ? await isPortListening(rec.port) : undefined;
    out.push(toServiceInfo(rec, listening));
  }
  out.sort((a, b) => b.ageMs - a.ageMs);
  return out;
}

/** 取单个服务（供路由做归属校验） */
export function getBrainService(userId: string, serviceId: string): ServiceRecord | undefined {
  const rec = serviceRegistry().get(serviceId);
  return rec && rec.userId === userId ? rec : undefined;
}

// ---------- git：固定 argv 白名单（status/log/diff/commit），无 shell 解释 ----------

export type SandboxGitOp = "status" | "log" | "diff" | "commit" | "push" | "branch" | "checkout" | "merge" | "pull";

export async function runSandboxedGit(
  userId: string,
  op: SandboxGitOp,
  opts?: { message?: string; limit?: number; ref?: string },
): Promise<string> {
  const cwd = await ensureWorkspace(userId);
  const isRepo = await fs
    .stat(path.join(cwd, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!isRepo) {
    if (op === "commit") {
      throw new Error("工作区还不是 git 仓库，请先用 run_command 执行 git init");
    }
    return "工作区尚未初始化 git 仓库（可先用 run_command 执行 git init 后再试）。";
  }
  const limit = Math.min(50, Math.max(1, opts?.limit ?? 10));
  let argv: string[];
  if (op === "status") {
    argv = ["-c", "color.ui=never", "status", "--short", "--branch"];
  } else if (op === "log") {
    argv = ["-c", "color.ui=never", "log", "--oneline", "--decorate", "-n", String(limit)];
  } else if (op === "diff") {
    argv = ["-c", "color.ui=never", "diff", "HEAD"];
  } else if (op === "push") {
    argv = ["-c", "color.ui=never", "push"];
  } else if (op === "branch") {
    argv = ["-c", "color.ui=never", "branch", "--list", "--verbose"];
  } else if (op === "pull") {
    argv = ["-c", "color.ui=never", "pull", "--ff-only"];
  } else if (op === "checkout" || op === "merge") {
    const ref = opts?.ref?.trim();
    if (!ref) throw new Error(op + " 必须提供 ref（分支名/目标）");
    // ref 白名单校验：禁止 - 开头（防 argv 选项注入）与非常规字符
    if (ref.startsWith("-") || !/^[\w.\/-]+$/.test(ref)) throw new Error("ref 含非法字符：" + ref);
    argv = op === "checkout"
      ? ["-c", "color.ui=never", "checkout", ref]
      : ["-c", "color.ui=never", "merge", "--no-edit", ref];
  } else {
    const message = opts?.message?.trim();
    if (!message) throw new Error("commit 必须提供 message");
    argv = [
      "-c", "user.name=xiaoluo-brain",
      "-c", "user.email=brain@xiaoluo.local",
      "commit", "-a", "-m", message.slice(0, 500),
    ];
  }
  try {
    const { stdout } = await execFileAsync("git", argv, {
      cwd,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: minimalEnv(cwd, process.platform === "win32"),
    });
    return stdout.trim() || "(git 无输出)";
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    const text = ((detail.stdout ?? "") + "\n" + (detail.stderr ?? "")).trim();
    if (text) return text.slice(0, MAX_OUTPUT_CHARS);
    throw new Error("git 执行失败：" + (detail.message ?? "未知错误"));
  }
}

// ===================== 技能市场：SKILL.md 轻量流通层 =====================
// 发布/安装不走 packages 重体系（签名+trust 审核），文件式直存 .data/brain-workspace/.market，
// 装/发同一套 SKILL.md frontmatter 契约，任何小逻实例原样吃回。
const MARKET_ROOT = path.join(WORKSPACE_ROOT, ".market");
const SKILL_MARKET_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_MARKET_MAX_BODY = 256 * 1024;
const SKILL_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface SkillMarketListing {
  name: string;
  description: string;
  publisherId: string;
  publisherName: string;
  publishedAt: string;
  localCopy: boolean;
}

function marketSkillDir(publisherId: string, name: string): string {
  return path.join(MARKET_ROOT, sanitizeOwner(publisherId), name);
}

function parseSkillFrontmatter(raw: string): { name: string; description: string; body: string } {
  const m = raw.match(SKILL_FRONTMATTER_RE);
  if (!m) throw new Error("SKILL.md 缺少 frontmatter（--- name/description ---）");
  const pick = (key: string) => {
    const hit = m[1].match(new RegExp("^" + key + ":\\s*(.+)$", "m"));
    return hit ? hit[1].trim() : "";
  };
  return { name: pick("name"), description: pick("description"), body: (m[2] ?? "").trim() };
}

/** 浏览技能市场：聚合所有发布者目录；mine 只影响 localCopy 判定 */
export async function listSkillMarket(mine: string): Promise<SkillMarketListing[]> {
  const rows: SkillMarketListing[] = [];
  await seedOfficialMarket(MARKET_ROOT).catch(() => {});
  let publishers: string[] = [];
  try {
    publishers = await fs.readdir(MARKET_ROOT);
  } catch {
    return rows;
  }
  for (const owner of publishers.slice(0, 60)) {
    const ownerDir = path.join(MARKET_ROOT, owner);
    let skills: string[] = [];
    try {
      skills = await fs.readdir(ownerDir);
    } catch {
      continue;
    }
    for (const skillName of skills.slice(0, 60)) {
      const dir = path.join(ownerDir, skillName);
      let meta: { publisherName?: string; publishedAt?: string; publisherId?: string } = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
      } catch { /* meta 缺失按空元数据兜底 */ }
      let description = "";
      let displayName = skillName;
      try {
        const parsed = parseSkillFrontmatter(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
        description = parsed.description;
        displayName = parsed.name || skillName;
      } catch { /* 坏条目跳过描述但仍展示 */ }
      let localCopy = false;
      try {
        await fs.access(path.join(brainWorkspaceRoot(mine), "skills", skillName, "SKILL.md"));
        localCopy = true;
      } catch { /* 未安装 */ }
      rows.push({
        name: skillName,
        description,
        publisherId: meta.publisherId ?? owner,
        publisherName: meta.publisherName ?? displayName,
        publishedAt: meta.publishedAt ?? "",
        localCopy,
      });
    }
  }
  rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return rows;
}

/** 发布：从本人工作区 skills/<name>/SKILL.md 读取校验后直存市场（同名覆盖更新） */
export async function publishSkillToMarket(
  userId: string,
  publisherName: string,
  skillName: string,
): Promise<{ name: string; description: string; publishedAt: string }> {
  const name = (skillName || "").trim();
  if (!SKILL_MARKET_NAME_RE.test(name) || name.length > 40) {
    throw new Error("技能名必须是 kebab-case（a-z 0-9 -，≤40 字符）");
  }
  const file = path.join(brainWorkspaceRoot(userId), "skills", name, "SKILL.md");
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  if (!raw) throw new Error("工作区 skills/" + name + "/SKILL.md 不存在，先用 save_skill 沉淀技能");
  if (Buffer.byteLength(raw, "utf8") > SKILL_MARKET_MAX_BODY) throw new Error("技能正文超过 256KB，拒绝发布");
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed.description) throw new Error("SKILL.md frontmatter 缺 description，无法发布");
  if (parsed.body.length < 20) throw new Error("技能正文过短（<20 字），无法发布");
  const dir = marketSkillDir(userId, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), raw, "utf8");
  const publishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ publisherId: userId, publisherName, publishedAt }),
    "utf8",
  );
  return { name, description: parsed.description, publishedAt };
}

/** 下架：只能删自己发布的条目 */
export async function unpublishSkillFromMarket(userId: string, skillName: string): Promise<void> {
  const name = (skillName || "").trim();
  if (!SKILL_MARKET_NAME_RE.test(name)) throw new Error("技能名非法");
  await fs.rm(marketSkillDir(userId, name), { recursive: true, force: true });
}

/** 安装：市场 SKILL.md → 本人工作区 skills/<name>/；本地已有同名拒绝（与 install_plugin 一致） */
export async function installSkillFromMarket(userId: string, publisherId: string, skillName: string): Promise<void> {
  const name = (skillName || "").trim();
  if (!SKILL_MARKET_NAME_RE.test(name)) throw new Error("技能名非法");
  const owner = sanitizeOwner(publisherId);
  const source = path.join(MARKET_ROOT, owner, name, "SKILL.md");
  const raw = await fs.readFile(source, "utf8").catch(() => "");
  if (!raw) throw new Error("市场中不存在该技能（可能已被发布者下架）");
  const targetDir = path.join(brainWorkspaceRoot(userId), "skills", name);
  try {
    await fs.access(path.join(targetDir, "SKILL.md"));
    throw new Error("本地已存在同名技能 skills/" + name + "，请先改名或删除后再安装");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("本地已存在")) throw e;
  }
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, "SKILL.md"), raw, "utf8");
}
// ---------- setup_service：本地服务搭建服务端通道（哨兵 SVC1） ----------
export async function setupBrainService(userId: string, payload: Record<string, unknown>) {
  const root = await ensureWorkspace(userId);
  return provisionService(payload, {
    workspaceRoot: root,
    runtimeRoots: [path.join(process.cwd(), ".local-runtime"), path.join(root, ".local-runtime")],
    getServiceInfo: (id: string) => { const rec = serviceRegistry().get(id); return rec ? { id: rec.id, url: rec.url, status: rec.status } : null; },
    registerService: async (command: string, opts?: { gated?: boolean; ttlMs?: number; annotate?: Record<string, unknown> }) => {
      if (opts?.gated !== false) {
        const risk = classifyCommandRisk(command);
        if (risk.level === "blocked") {
          return { error: "命令被安全策略拦截（" + risk.reasons.join("、") + "）", code: "blocked", reasons: risk.reasons };
        }
        if (risk.level === "needs_approval") {
          return { error: "该命令风险较高，搭建通道不代执行，请老板批准后走 run_command", code: "approval_required", reasons: risk.reasons };
        }
      }
      try {
        const info = await startBrainService(userId, command, { ttlMs: opts?.ttlMs });
        if (opts?.annotate) {
          const rec = serviceRegistry().get(info.id);
          if (rec) Object.assign(rec, opts.annotate);
        }
        return info;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

/** 已搭建服务清单 + 协议级健康复查 */
export async function listBrainServiceSetups(userId: string) {
  const root = await ensureWorkspace(userId);
  const infos = readServiceInfos(root);
  const setups = [];
  for (const info of infos) setups.push(Object.assign({}, info, await recheckHealth(info, {})));
  return setups;
}
