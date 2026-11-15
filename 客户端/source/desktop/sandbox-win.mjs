/**
 * 小逻桌面端 Windows 受限沙箱档（P2-2，参考 Codex windows-sandbox-rs 的理念）。
 * 原理：Windows 强制完整性控制（MIC）——低完整性进程不能写中完整性对象（用户文件默认中）。
 * setup 时工作区整体递归降为 Low 标签（子项继承），spawn 时用降权令牌启动命令子进程：
 * 受限命令只写得了工作区，工作区外写操作被操作系统直接拦下。
 * setup（一次性装机：打标 + 落启动器）与 spawn_prep（每次启动）分离（Codex 同款）；
 * 任一步失败返回 null，runCommand 自动降级普通启动，不阻塞功能。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SBX_DIR = ".sandbox";
const LAUNCHER_NAME = "launcher.ps1";
const LABEL_NAME = "label-low.ps1";
const LABEL_MARKER = "low-label.ok";

/** 受限启动脚本与打标脚本的行数据：构建期分片落盘的 JSON，此处读回拼装。
 *  启动器流程：当前进程令牌 -> DuplicateTokenEx -> 令牌完整性降 Low -> CreateProcessAsUserW 跑真命令。
 *  载荷走文件：node 侧把命令写成 UTF-8 BOM 的 .ps1（run.cmd.ps1），低权限子进程以 -File 执行，
 *  中文命令不依赖任何编码开关；stdio 继承启动器管道（node 侧照常收输出）。
 *  启动失败统一 exit 740，runCommand 识别后降级。 */
const DATA_DIR = import.meta.dirname;
const LAUNCHER_PS = JSON.parse(readFileSync(join(DATA_DIR, "launcher-lines.json"), "utf8")).join("\r\n");
const LABEL_PS = JSON.parse(readFileSync(join(DATA_DIR, "label-lines.json"), "utf8")).join("\r\n");

/** setup（一次性装机）+ 取启动器路径；失败返回 null（runCommand 降级普通启动） */
const setupCache = new Map();
export function getSandboxLauncher(root) {
  if (process.platform !== "win32" || !root) return null;
  if (setupCache.has(root)) return setupCache.get(root);
  let result = null;
  try {
    const dir = join(root, SBX_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LAUNCHER_NAME), LAUNCHER_PS, "utf8");
    const labelScript = join(dir, LABEL_NAME);
    writeFileSync(labelScript, LABEL_PS, "utf8");
    const marker = join(dir, LABEL_MARKER);
    if (!existsSync(marker)) {
      // 工作区完整性递归降 Low（(OI)(CI) 子项继承）；中完整性应用（Electron/Node）写 Low 对象不受影响，只拦低->中
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", labelScript, "-Root", root], { windowsHide: true, timeout: 120_000 });
      writeFileSync(marker, String(Date.now()), "utf8");
    }
    result = join(dir, LAUNCHER_NAME);
  } catch {
    result = null;
  }
  setupCache.set(root, result);
  return result;
}
