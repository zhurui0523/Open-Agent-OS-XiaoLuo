/**
 * 本机凭据钥匙串（第 7.11 收尾项：把 mcp.json 里的明文 secrets 挪到加密文件）
 *
 * mcp.json 里 env 值或 oauth 字段写 `vault://<名字>`，真正明文放这里：
 *   - AES-256-GCM，随机 IV，AAD = 凭据名（换名贴密文解不开）；
 *   - 主密钥取 `XIAOLUO_MCP_VAULT_KEY`，否则生成 `<dataDir>/mcp-secrets.key`（0600）；
 *   - 密文文件 `<dataDir>/mcp-secrets.json`（0600），原子写；
 *   - 列表只回名字 / 更新时间 / 备注，永不回显明文。
 *
 * 边界：文件级加密，不是系统钥匙串（DPAPI / Keychain / Secret Service 未接）；
 * 同机同用户拿得到 key 文件就能解；没有审计日志。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const SECRET_PATTERN = /(key|token|secret|password|passwd|credential|authorization|cookie)/i;

export function vaultDataDir() {
  return process.env.XIAOLUO_DATA_DIR?.trim() || path.join(process.env.APPDATA || path.join(os.homedir(), ".local", "share"), "xiaoluo-appserver");
}

function vaultPaths(dir = vaultDataDir()) {
  return { dir, key: path.join(dir, "mcp-secrets.key"), file: path.join(dir, "mcp-secrets.json") };
}

let cachedKey = null;
let cachedKeyDir = "";
let chmodSkips = 0;

function masterKey(dir) {
  if (process.env.XIAOLUO_MCP_VAULT_KEY?.trim()) {
    return crypto.createHash("sha256").update(process.env.XIAOLUO_MCP_VAULT_KEY.trim()).digest();
  }
  if (cachedKey && cachedKeyDir === dir) return cachedKey;
  const { key } = vaultPaths(dir);
  fsp.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  try {
    const raw = fs.readFileSync(key);
    const parsed = Buffer.from(raw.toString("utf8").trim(), "base64");
    if (parsed.length === 32) {
      cachedKey = parsed;
      cachedKeyDir = dir;
      return parsed;
    }
  } catch {
    cachedKey = null; // 文件不存在/损坏：走下面重新生成
  }
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(key, fresh.toString("base64"), { mode: 0o600 });
  try { fs.chmodSync(key, 0o600); } catch { chmodSkips += 1; }
  cachedKey = fresh;
  cachedKeyDir = dir;
  return fresh;
}

function encrypt(name, value) {
  const key = masterKey(vaultDataDir());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(name, entry) {
  const key = masterKey(vaultDataDir());
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

async function readStore() {
  const { file } = vaultPaths();
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed.secrets === "object" ? parsed : { secrets: {} };
  } catch {
    return { secrets: {} };
  }
}

async function writeStore(store) {
  const { dir, file } = vaultPaths();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch { chmodSkips += 1; }
}

/** 列表：只有名字/时间/备注，没有明文 */
export async function listSecrets() {
  const store = await readStore();
  return Object.entries(store.secrets).map(([name, entry]) => ({
    name,
    updatedAt: Number(entry.updatedAt) || 0,
    note: String(entry.note ?? ""),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function setSecret(name, value, note = "") {
  const clean = String(name ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clean)) throw new Error("凭据名只能用字母/数字/._:-，最长 120");
  if (!String(value ?? "").length) throw new Error("凭据值不能为空");
  const store = await readStore();
  store.secrets[clean] = { ...encrypt(clean, value), updatedAt: Date.now(), note: String(note ?? "").slice(0, 80) };
  await writeStore(store);
  return { name: clean, updatedAt: store.secrets[clean].updatedAt };
}

export async function getSecret(name) {
  const store = await readStore();
  const entry = store.secrets[String(name ?? "").trim()];
  if (!entry) return undefined;
  return decrypt(String(name).trim(), entry);
}

export async function deleteSecret(name) {
  const clean = String(name ?? "").trim();
  const store = await readStore();
  if (!store.secrets[clean]) return { deleted: false };
  delete store.secrets[clean];
  await writeStore(store);
  return { deleted: true };
}

/** 把 `vault://name` 解成明文；不是引用就原样返回；引用不存在返回 undefined */
export async function resolveSecretValue(value) {
  if (typeof value !== "string" || !value.startsWith("vault://")) return value;
  return getSecret(value.slice("vault://".length));
}

/** 解析一个 server 配置的 env/oauth 引用；缺失的引用名收集到 missing */
export async function resolveServerSecrets(serverCfg) {
  const missing = [];
  const env = {};
  for (const [key, value] of Object.entries(serverCfg?.env ?? {})) {
    const resolved = await resolveSecretValue(value);
    if (resolved === undefined) missing.push("env." + key);
    else env[key] = resolved;
  }
  const oauth = { ...(serverCfg?.oauth ?? {}) };
  for (const key of ["clientSecret", "subjectToken", "refreshToken"]) {
    if (typeof oauth[key] !== "string") continue;
    const resolved = await resolveSecretValue(oauth[key]);
    if (resolved === undefined) missing.push("oauth." + key);
    else oauth[key] = resolved;
  }
  return { serverCfg: { ...serverCfg, env, oauth }, missing };
}

/**
 * 迁移：把 mcp.json 里看起来是凭据的明文挪进钥匙串，原位置换成 vault://引用。
 * 只改 env.* 与 oauth.clientSecret/subjectToken/refreshToken，别的一律不动。
 */
export async function migrateMcpConfig(configPath) {
  let raw;
  try {
    raw = await fsp.readFile(configPath, "utf8");
  } catch {
    return { ok: false, error: "找不到 mcp.json", moved: [] };
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return { ok: false, error: "mcp.json 不是合法 JSON", moved: [] };
  }
  const moved = [];
  const servers = data && typeof data.mcpServers === "object" ? data.mcpServers : {};
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") continue;
    if (cfg.env && typeof cfg.env === "object") {
      for (const [key, value] of Object.entries(cfg.env)) {
        if (typeof value !== "string" || value.startsWith("vault://") || !SECRET_PATTERN.test(key)) continue;
        const secretName = serverName + "." + key;
        await setSecret(secretName, value, serverName + " 的 " + key);
        cfg.env[key] = "vault://" + secretName;
        moved.push(secretName);
      }
    }
    if (cfg.oauth && typeof cfg.oauth === "object") {
      for (const key of ["clientSecret", "subjectToken", "refreshToken"]) {
        const value = cfg.oauth[key];
        if (typeof value !== "string" || !value || value.startsWith("vault://")) continue;
        const secretName = serverName + ".oauth." + key;
        await setSecret(secretName, value, serverName + " 的 oauth " + key);
        cfg.oauth[key] = "vault://" + secretName;
        moved.push(secretName);
      }
    }
  }
  if (moved.length) {
    const tmp = configPath + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, configPath);
  }
  return { ok: true, moved };
}

/** 测试用：清掉进程内主密钥缓存 */
export function resetVaultCacheForTests() {
  cachedKey = null;
  cachedKeyDir = "";
}
