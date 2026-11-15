/**
 * 小逻服务端 Windows 受限沙箱档（对齐 Codex windows-sandbox-rs 的 MIC 思路，与桌面端同一套脚本）。
 *
 * 原理：Windows 强制完整性控制（MIC）——低完整性（Low IL）进程写不了中完整性对象（用户文件默认中）。
 * setup：把工作区递归打 Low 标签（(OI)(CI) 继承），并在工作区 .sandbox/ 落启动器与打标脚本；
 * spawn：用降权令牌（DuplicateTokenEx + SetTokenInformation 到 Low）CreateProcessAsUser 跑真命令。
 * 结果：受限命令只写得了工作区，工作区外写入被操作系统直接拦下，不依赖命令文本正则。
 *
 * 边界（诚实说明）：
 *  - 仅 win32；setup 或启动失败一律返回 null，调用侧降级普通启动，不阻塞功能。
 *  - 低完整性进程读得到中完整性对象：这是「防写」不是「防读」。
 *  - 依赖工作区放在用户可写目录（Low 标签打在用户目录下才不受 ACL 阻挡）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SBX_DIR = ".sandbox";
const TMP_DIR = ".tmp";
const APP_DATA_DIR = ".appdata";
const LAUNCHER_NAME = "launcher.ps1";
const LABEL_NAME = "label-low.ps1";
const LABEL_MARKER = "low-label.ok";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = join(HERE, "..", "..", "shared", "sandbox");

/** icacls 绝对路径：同 powershell，按名走 PATH 可被劫持 */
function icaclsPath() {
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(sysRoot, "System32", "icacls.exe");
}

/**
 * MIC 档位三态：
 *  - auto（默认）：落点能打标且探针通过就启用，否则如实降级
 *  - on / off：老板显式强制
 * 默认 auto 的理由：开关打开但落点打不了标，会得到「看起来开、其实没拦」的假防护，比不开启更危险。
 */
export function winMicSetting() {
  const raw = (process.env.XIAOLUO_SANDBOX_WIN_MIC ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "force"].includes(raw)) return "on";
  if (["0", "false", "off", "no"].includes(raw)) return "off";
  return "auto";
}

/** 是否「请求」启用（auto 也算请求，是否真启用由探针决定） */
export function isWinMicEnabled() {
  return winMicSetting() !== "off";
}

const setupCache = new Map();

/**
 * PowerShell 解释器绝对路径（System32 下）。
 * 不靠 PATH 找 `powershell.exe`：PATH 里靠前的可写目录能劫持解释器，等于把沙箱交给攻击者。
 */
export function powershellPath() {
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * 是否可用 + 落盘脚本；不可用返回 null（调用侧降级）。
 * auto 档下这里就是探针：脚本缺失、目录不属于当前用户（icacls 拒绝）都会如实失败。
 * @param {string} root 工作区绝对路径
 */
export function getSandboxLauncher(root) {
  if (process.platform !== "win32" || !root) return null;
  if (winMicSetting() === "off") return null;
  const cached = setupCache.get(root);
  if (cached) return cached.launcher;
  let launcher = null;
  let reason = null;
  try {
    const launcherSrc = readFileSync(join(SCRIPT_DIR, LAUNCHER_NAME), "utf8");
    const labelSrc = readFileSync(join(SCRIPT_DIR, LABEL_NAME), "utf8");
    const dir = join(root, SBX_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LAUNCHER_NAME), launcherSrc, "utf8");
    const labelScript = join(dir, LABEL_NAME);
    writeFileSync(labelScript, labelSrc, "utf8");
    // 低完整性进程写不了中完整性对象，工具要用的临时/缓存落点必须先建好并一起降标
    const toolDirs = [TMP_DIR, APP_DATA_DIR].map((name) => join(root, name));
    for (const d of toolDirs) mkdirSync(d, { recursive: true });
    const marker = join(dir, LABEL_MARKER);
    if (!existsSync(marker)) {
      // 工作区完整性递归降 Low：中完整性进程（node/electron）写 Low 对象不受影响，只拦低 -> 中
      execFileSync(
        powershellPath(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", labelScript, "-Root", root],
        { windowsHide: true, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      writeFileSync(marker, String(Date.now()), "utf8");
    } else {
      // 已有标记说明之前打过标；本次新建的工具目录要单独补标，否则子进程写不进去
      for (const d of toolDirs) {
        try {
          execFileSync(icaclsPath(), [d, "/setintegritylevel", "(OI)(CI)Low", "/T", "/Q"], {
            windowsHide: true,
            timeout: 60_000,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          /* 已打过标时 icacls 可能返回非零，不影响使用 */
        }
      }
    }
    launcher = join(dir, LAUNCHER_NAME);
  } catch (error) {
    launcher = null;
    reason = String(error && error.message ? error.message : error);
    if (/access is denied|拒绝访问|exit code 5/i.test(reason)) {
      reason = "工作区目录不属于当前用户，打不了低完整性标签（需把工作区放到用户自有目录）";
    } else if (/ENOENT/.test(reason)) {
      reason = "沙箱脚本缺失：" + reason;
    }
  }
  setupCache.set(root, { launcher, reason });
  return launcher;
}

/** 当前机器能提供的隔离级别（回流给小逻，别让它以为禁区之外还有内核级防护） */
export function describeIsolation(root) {
  const setting = winMicSetting();
  if (process.platform === "win32") {
    const launcher = getSandboxLauncher(root);
    if (launcher) {
      return {
        level: "mic-low",
        setting,
        note: "Windows 低完整性沙箱：工作区外写入被操作系统拦截（防写不防读）",
      };
    }
    const reason = setupCache.get(root)?.reason;
    if (setting === "off") {
      return {
        level: "none",
        setting,
        note: "Windows 低完整性沙箱被显式关闭（XIAOLUO_SANDBOX_WIN_MIC=0），当前仅有命令策略 + 应用层围栏 + 最小 env",
      };
    }
    return {
      level: "none",
      setting,
      note:
        "Windows 低完整性沙箱不可用，已降级为普通进程：" +
        (reason ?? "未开启（auto 档探针未通过）") +
        "。当前仅有命令策略 + 应用层围栏 + 最小 env",
    };
  }
  return {
    level: "none",
    setting,
    note: "当前平台未接入内核级沙箱，隔离依赖命令策略 + 应用层围栏 + 最小 env",
  };
}

/**
 * 受限档下把工具惯用的临时/缓存目录指进工作区：
 * 低完整性进程写不了中完整性对象，不重定向就会在 npm cache / 临时文件上大面积失败。
 */
export function restrictedHomeEnv(env, root) {
  const tmp = join(root, TMP_DIR);
  const appData = join(root, APP_DATA_DIR);
  return {
    ...env,
    TEMP: tmp,
    TMP: tmp,
    APPDATA: appData,
    LOCALAPPDATA: appData,
  };
}

/**
 * 把命令写成低权限子进程要执行的载荷脚本（UTF-8 BOM，中文命令不依赖任何编码开关）。
 * @returns {string} 载荷文件绝对路径
 */
export function writePayload(root, command, nonce) {
  const dir = join(root, SBX_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${nonce}.ps1`);
  const body =
    "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;\r\n" +
    // 遇错即停：被沙箱拦下的写入必须以非零退出码回流，不能看着像成功
    "$ErrorActionPreference='Stop';\r\n" +
    command +
    "\r\n" +
    "if ($LASTEXITCODE) { exit $LASTEXITCODE }\r\n";
  // 显式 BOM：powershell.exe -File 读无 BOM 的 UTF-8 中文会按 ANSI 解，命令里的中文就成乱码
  writeFileSync(file, "\uFEFF" + body, "utf8");
  return file;
}

/** 载荷执行完就删，工作区里不堆临时脚本 */
export function cleanupPayload(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* 清理失败不影响结果 */
  }
}
