import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// SERVER-URL 自定义连接地址（RUNTIME-MODE IPC 还原）：配置落 userData/server-url.json
// 优先级：环境变量 XIAOLUO_DESKTOP_URL > 本配置 > config.production.json
const CONFIG_NAME = "server-url.json";

function configPath() {
  return join(app.getPath("userData"), CONFIG_NAME);
}

function readConfig() {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function getStoredServerUrl() {
  return String(readConfig().url || "").trim();
}

function isLocalhost(hostname) {
  if (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  // 局域网私有网段（10/8、172.16/12、192.168/16）同样允许 http
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!parts) return false;
  const [, a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseServerUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.endsWith("/") ? rawUrl : rawUrl + "/");
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    // 正式档仅允许 HTTPS；本机/局域网调试（http）例外
    if (
      app.isPackaged &&
      parsed.protocol !== "https:" &&
      !isLocalhost(parsed.hostname)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function probeHealth(target, timeoutMs = 8_000) {
  try {
    const healthUrl = new URL("/api/v2/health/ready", target);
    const response = await fetch(healthUrl, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return "restricted";
    if (!response.ok) return "unhealthy";
    const payload = await response.json().catch(() => null);
    return payload && payload.ok === true ? "ready" : "unhealthy";
  } catch {
    return "unreachable";
  }
}

function scheduleRelaunch() {
  // 保存成功后重启应用生效；稍延迟确保 IPC 应答送达
  setTimeout(() => app.relaunch(), 300);
  setTimeout(() => app.exit(0), 700);
}

const HEALTH_TEXT = {
  restricted: "该地址限制外部访问（401/403）",
  unhealthy: "健康检查未通过",
  unreachable: "无法访问该地址",
};

// 设置页「运行模式」使用（保留旧 RUNTIME-MODE 契约：status/test/set）
export async function handleServerUrlPayload(payload) {
  const action = String((payload && payload.action) || "status");
  if (action === "status") {
    return { ok: true, data: { mode: "cloud", cloudUrl: getStoredServerUrl() } };
  }
  if (action === "test") {
    const parsed = parseServerUrl(String((payload && payload.url) || ""));
    if (!parsed) return { ok: false, message: "地址格式无效" };
    const state = await probeHealth(parsed);
    return state === "ready"
      ? { ok: true, message: "连接正常" }
      : { ok: false, message: HEALTH_TEXT[state] || state };
  }
  if (action === "set") {
    const cloudUrl = String((payload && payload.cloudUrl) || "").trim();
    const file = configPath();
    if (!cloudUrl) {
      // 清除自定义地址：恢复内置默认地址
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // 忽略
      }
      scheduleRelaunch();
      return { ok: true };
    }
    const parsed = parseServerUrl(cloudUrl);
    if (!parsed) return { ok: false, message: "地址格式无效（正式环境需要 HTTPS 或本机地址）" };
    const state = await probeHealth(parsed);
    if (state !== "ready") return { ok: false, message: HEALTH_TEXT[state] || state };
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ url: parsed.toString(), updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch (error) {
      return { ok: false, message: "配置写入失败：" + String(error) };
    }
    scheduleRelaunch();
    return { ok: true };
  }
  return { ok: false, message: "未知操作" };
}