import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { secretRefs } from "../../db/schema";
import { serverRuntimeConfig } from "./server-runtime-config";
import { mysqlNow } from "./mysql";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const configured = process.env.SECRET_ENCRYPTION_KEY?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置独立的 SECRET_ENCRYPTION_KEY");
  }
  const developmentKey =
    configured || serverRuntimeConfig().database.mysql.password;
  if (!developmentKey) throw new Error("服务端未配置 Secret 加密密钥");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(developmentKey),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

async function decrypt(ciphertext: string, iv: string) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    await encryptionKey(),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function saveSecret(input: {
  workspaceId: string;
  userId: string;
  name: string;
  value: string;
}) {
  const name = input.name.trim().slice(0, 120);
  const value = input.value.trim();
  if (!name || !value) throw new Error("Secret 名称和值不能为空");
  const encrypted = await encrypt(value);
  const db = await getDb();
  const [existing] = await db
    .select({ id: secretRefs.id })
    .from(secretRefs)
    .where(
      and(
        eq(secretRefs.workspaceId, input.workspaceId),
        eq(secretRefs.name, name),
      ),
    )
    .limit(1);
  const now = mysqlNow();
  const id = existing?.id ?? `secret_${crypto.randomUUID()}`;
  if (existing) {
    await db
      .update(secretRefs)
      .set({ ...encrypted, updatedAt: now })
      .where(eq(secretRefs.id, id));
  } else {
    await db.insert(secretRefs).values({
      id,
      workspaceId: input.workspaceId,
      name,
      ...encrypted,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { id, name };
}

export async function resolveSecret(
  secretRefId: string,
  workspaceId: string,
) {
  const db = await getDb();
  const [secret] = await db
    .select()
    .from(secretRefs)
    .where(
      and(
        eq(secretRefs.id, secretRefId),
        eq(secretRefs.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!secret) throw new Error("Secret 不存在或不属于当前工作区");
  await db
    .update(secretRefs)
    .set({ lastUsedAt: mysqlNow() })
    .where(eq(secretRefs.id, secret.id));
  return decrypt(secret.ciphertext, secret.iv);
}
