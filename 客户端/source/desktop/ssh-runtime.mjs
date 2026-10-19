// ---------- SSH：远程执行工作区（走系统 OpenSSH 客户端，零第三方依赖） ----------
// 目标：补齐"在远程主机上跑命令"的缺口（对齐 DSH SSH 远程 / Codex 远程执行）。
// 设计纪律：
//  1) 零依赖——用系统自带 ssh.exe（Windows 10+ 内置 OpenSSH），不引 ssh2 等库。
//  2) 只密钥认证——BatchMode=yes 禁交互，绝不接收/存储密码；缺密钥直接失败并给清晰指引。
//  3) 安全——StrictHostKeyChecking=accept-new（首连自动记指纹、指纹变了拒连）；独立 known_hosts 不污染用户配置；host 参数校验防 argv 注入。
//  4) 门控——整条通道受主进程 desktopControlEnabled() 门控（复用"允许小逻控制本机"开关）。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let userDataDir = "";
/** 由 main.mjs 在 app ready 后注入 userData 路径 */
export function initSsh(dir) {
  userDataDir = String(dir || "");
}

// ssh 可执行候选（Windows 内置 OpenSSH + 常见 Unix 路径；找不到再退回 PATH 里的 "ssh"）
function candidateSshPaths() {
  const list = [
    process.env.XIAOLUO_SSH || "",
    "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    "/usr/bin/ssh",
    "/usr/local/bin/ssh",
    "/opt/homebrew/bin/ssh",
  ];
  return list.filter(Boolean);
}
function findSsh() {
  for (const p of candidateSshPaths()) {
    if (p && existsSync(p)) return p;
  }
  return "ssh"; // 退回 PATH
}

function knownHostsFile() {
  if (!userDataDir) return "";
  const dir = join(userDataDir, "ssh");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return "";
  }
  return join(dir, "known_hosts");
}

// host 校验：只允许 主机名/IPv4/IPv6 字面量，且不得以 - 开头（防被当成 ssh 选项注入）
function validHost(host) {
  const h = String(host || "").trim();
  if (!h || h.startsWith("-")) return false;
  if (h.length > 253) return false;
  // 允许字母数字、点、连字符、冒号（IPv6）、方括号（IPv6 字面量）
  return /^[A-Za-z0-9.\-:\[\]]+$/.test(h);
}

function runSsh(args, timeoutMs) {
  const exe = findSsh();
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || "").toString("utf8");
        const errText = (stderr || "").toString("utf8");
        // err.code 为退出码（进程正常结束但非0）；err.killed/timeout 为超时
        if (err && (err.killed || err.signal === "SIGTERM")) {
          resolve({ ok: false, exitCode: -1, timeout: true, stdout: out.slice(0, 8000), stderr: (errText || "连接/执行超时").slice(0, 2000) });
          return;
        }
        const exitCode = err && typeof err.code === "number" ? err.code : (err ? 1 : 0);
        resolve({ ok: exitCode === 0, exitCode, stdout: out.slice(0, 8000), stderr: errText.slice(0, 2000) });
      },
    );
  });
}

function buildSshArgs(p, command) {
  const args = [
    "-o", "BatchMode=yes", // 禁交互：不弹密码提示，缺密钥/需密码直接失败
    "-o", "StrictHostKeyChecking=accept-new", // 首连自动记指纹；指纹变更则拒连（防中间人）
    "-o", "ConnectTimeout=15",
    "-o", "NumberOfPasswordPrompts=0",
  ];
  const kh = knownHostsFile();
  if (kh) args.push("-o", "UserKnownHostsFile=" + kh);
  if (p.identityFile) args.push("-i", String(p.identityFile));
  if (p.port) args.push("-p", String(Number(p.port) || 22));
  const target = p.user ? String(p.user) + "@" + String(p.host).trim() : String(p.host).trim();
  args.push(target, command);
  return args;
}

/** brain:ssh IPC 入口。action: status|test|exec */
export async function handleSshPayload(payload) {
  const p = payload || {};
  const action = String(p.action || "status");
  try {
    if (action === "status") {
      const exe = findSsh();
      const res = await runSsh(["-V"], 8000).catch(() => null);
      // ssh -V 把版本打到 stderr
      const version = res ? String(res.stderr || res.stdout || "").trim().split(/\r?\n/)[0] : "";
      return { ok: Boolean(exe), ssh: exe, version };
    }

    if (!validHost(p.host)) {
      return { error: "host 非法：需为主机名或 IP（不能以 - 开头，只允许字母数字 . - : [ ]）" };
    }
    const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || 30000, 3000), 300000);

    if (action === "test") {
      const res = await runSsh(buildSshArgs(p, "echo __xl_ssh_ok__"), timeoutMs);
      const reachable = res.ok && String(res.stdout).includes("__xl_ssh_ok__");
      return {
        ok: reachable,
        reachable,
        exitCode: res.exitCode,
        detail: reachable ? "SSH 连通正常" : (res.stderr || res.stdout || "连接失败（检查 host/端口/密钥；本通道只支持密钥认证，不支持密码）").slice(0, 600),
      };
    }

    if (action === "exec") {
      const command = String(p.command || "").trim();
      if (!command) return { error: "command 为空" };
      const res = await runSsh(buildSshArgs(p, command), timeoutMs);
      return res;
    }

    return { error: "未知 action：" + action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
