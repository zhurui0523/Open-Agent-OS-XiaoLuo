/**
 * Node 可执行文件路径：桌面端随包分发；开发环境允许环境变量覆盖。
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const NODE_EXE = (() => {
  const override = process.env.XIAOLUO_NODE_EXE?.trim();
  if (override && existsSync(override)) return override;
  const candidates = [
    process.execPath,
    join(__dirname, "..", "runtime-local-ai", "node.exe"),
  ];
  return candidates.find((p) => p && existsSync(p)) || "node.exe";
})();
