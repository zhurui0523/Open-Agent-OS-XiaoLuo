/**
 * 凭据钥匙串（第 7.11 项，学 Codex `keyring-store` / `secrets` 的本地凭据托管）
 *
 * 现状：MCP token、网关 token 要么写死在配置里、要么靠环境变量，落盘即明文。这里补一个本地加密镇：
 *   1. 值用 AES-256-GCM 加密（随机 IV 12B、AAD=凭据名，防"把 A 的密文贴到 B 名下"）；
 *   2. 主密钥优先取环境变量 `XIAOLUO_VAULT_KEY`；没有就在仓库数据目录生成 `vault.key`（0600）；
 *   3. 写入临时文件 + rename 原子替换，文件 0600；列表只回名字/时间/后四位，永不回明文；
 *   4. 解不开（换机器/被篡改）抛错交给调用方降级，绝不当成空值静默放行。
 *
 * 边界：这是"文件级加密"，不是操作系统钥匙串（Windows DPAPI / macOS Keychain / Linux Secret Service）。
 * 同机同用户的进程只要有 key 文件就能解；要更强隔离得上原生 addon 或 DPAPI，见文档边界。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

const VAULT_FILE = "credentials.vault.json";
const KEY_FILE = "vault.key";
const MAX_VALUE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/;

interface VaultRecord {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
  note?: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, VaultRecord>;
}

export interface VaultSecretMeta {
  name: string;
  updatedAt: string;
  note?: string;
  /** 只露后四位，用于确认"存的是哪一条"，不泄露内容 */
  preview: string;
}

const keyCache = new Map<string, Buffer>();

export function vaultFilePath(dir: string): string {
  return path.join(dir, VAULT_FILE);
}

export function validateSecretName(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error("凭据名不合法（只允许字母数字与 _ . : @ -，长度 1–64）：" + name);
  }
  return trimmed;
}

/** 主密钥：env 优先；否则 0600 密钥文件（首次自动生成） */
async function masterKey(dir: string): Promise<Buffer> {
  const fromEnv = process.env.XIAOLUO_VAULT_KEY;
  if (fromEnv && fromEnv.trim()) return crypto.createHash("sha256").update(fromEnv.trim()).digest();
  const cached = keyCache.get(dir);
  if (cached) return cached;
  const keyPath = path.join(dir, KEY_FILE);
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length >= 32) {
      const key = crypto.createHash("sha256").update(existing).digest();
      keyCache.set(dir, key);
      return key;
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
  }
  const raw = crypto.randomBytes(32);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(keyPath, raw, { mode: 0o600 });
  const key = crypto.createHash("sha256").update(raw).digest();
  keyCache.set(dir, key);
  return key;
}

function encryptValue(key: Buffer, name: string, value: string): { iv: string; tag: string; data: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}

function decryptValue(key: Buffer, name: string, record: VaultRecord): string {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

async function readVault(dir: string): Promise<VaultFile> {
  const file = vaultFilePath(dir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as VaultFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") throw new Error("版本不符");
    return { version: 1, entries: parsed.entries ?? {} };
  } catch {
    throw new Error("凭据库文件损坏（不是合法 vault JSON）：" + file);
  }
}

async function writeVault(dir: string, vault: VaultFile): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = vaultFilePath(dir);
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  await fs.writeFile(tmp, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
  // Windows 上 chmod 基本无效，但 POSIX 上这一步能把权限收紧到只有本人可读
  await fs.chmod(file, fsConstants.S_IRUSR | fsConstants.S_IWUSR).catch(() => undefined);
}

/** 存/换一条凭据（值不超过 64KB；空值拒绝，删除请用 deleteSecret） */
export async function setSecret(dir: string, name: string, value: string, note?: string): Promise<VaultSecretMeta> {
  const key = validateSecretName(name);
  if (typeof value !== "string" || value.length === 0) throw new Error("凭据值不能为空");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new Error("凭据值超过 64KB 上限");
  const vault = await readVault(dir);
  const encrypted = encryptValue(await masterKey(dir), key, value);
  const updatedAt = new Date().toISOString();
  vault.entries[key] = { ...encrypted, updatedAt, ...(note ? { note: String(note).slice(0, 200) } : {}) };
  await writeVault(dir, vault);
  return { name: key, updatedAt, note: vault.entries[key].note, preview: maskValue(value) };
}

/** 取一条凭据；不存在返回 null；解不开抛错（不能当空） */
export async function getSecret(dir: string, name: string): Promise<string | null> {
  const key = validateSecretName(name);
  const vault = await readVault(dir);
  const record = vault.entries[key];
  if (!record) return null;
  try {
    return decryptValue(await masterKey(dir), key, record);
  } catch {
    throw new Error("凭据解密失败（换机器/主密钥变了/文件被篡改）：" + key);
  }
}

export async function deleteSecret(dir: string, name: string): Promise<boolean> {
  const key = validateSecretName(name);
  const vault = await readVault(dir);
  if (!vault.entries[key]) return false;
  delete vault.entries[key];
  await writeVault(dir, vault);
  return true;
}

/** 列表（不解密内容；preview 只用密文长度推断"有值"，不给任何明文线索） */
export async function listSecrets(dir: string): Promise<VaultSecretMeta[]> {
  const vault = await readVault(dir);
  return Object.entries(vault.entries)
    .map(([name, record]) => ({
      name,
      updatedAt: record.updatedAt,
      ...(record.note ? { note: record.note } : {}),
      preview: "••••",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function maskValue(value: string): string {
  const tail = value.length >= 8 ? value.slice(-4) : "";
  return tail ? "••••" + tail : "••••";
}

/** 给别处用的解析器：找不到返回 null（不抛），解不开抛（由调用方决定降级） */
export function vaultResolver(dir: string): (name: string) => Promise<string | null> {
  return async (name: string) => {
    try {
      return await getSecret(dir, name);
    } catch {
      return null;
    }
  };
}

/** 测试用：清空主密钥缓存（换 dir 或换 env 后避免脏缓存） */
export function resetVaultKeyCacheForTests(): void {
  keyCache.clear();
}
