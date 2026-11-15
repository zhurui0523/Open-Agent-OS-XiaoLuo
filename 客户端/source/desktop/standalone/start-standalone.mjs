// XIAOLUO-STANDALONE-ENTRY 自包含入口：存在 runtime.env 时加载它（本地 MySQL + 远程 OSS）；否则单机模式兜底
import { existsSync as envExists } from "node:fs";
if (envExists("runtime.env")) {
  process.loadEnvFile("runtime.env");
} else {
  process.env.XIAOLUO_MODE ||= "standalone";
  process.env.XIAOLUO_DATA_DIR ||= ".local-data";
}
await import("./server.js");
