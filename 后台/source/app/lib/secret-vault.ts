import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { modelConnections, secretRefs } from "../../db/schema";
import { mysqlNow } from "./mysql";

export type SecretPurpose = "generic" | "model_api_key";

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
  if (!configured) {
    throw new Error(
      "服务端未配置 SECRET_ENCRYPTION_KEY；模型密钥不能使用数据库密码代替加密",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(configured),
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
  purpose?: SecretPurpose;
}) {
  const name = input.name.trim().slice(0, 120);
  const value = input.value.trim();
  const purpose = input.purpose ?? "generic";
  if (!name || !value) throw new Error("Secret 名称和值不能为空");
  const encrypted = await encrypt(value);
  const db = await getDb();
  const [existing] = await db
    .select({ id: secretRefs.id })
    .from(secretRefs)
    .where(
      and(
        eq(secretRefs.workspaceId, input.workspaceId),
        eq(secretRefs.createdBy, input.userId),
        eq(secretRefs.purpose, purpose),
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
      purpose,
      ...encrypted,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { id, name };
}

export async function assertOwnedSecretReference(input: {
  secretRefId: string;
  workspaceId: string;
  userId: string;
  purpose?: SecretPurpose;
}) {
  const db = await getDb();
  const [secret] = await db
    .select({ id: secretRefs.id, purpose: secretRefs.purpose })
    .from(secretRefs)
    .where(
      and(
        eq(secretRefs.id, input.secretRefId),
        eq(secretRefs.workspaceId, input.workspaceId),
        eq(secretRefs.createdBy, input.userId),
        ...(input.purpose
          ? [eq(secretRefs.purpose, input.purpose)]
          : []),
      ),
    )
    .limit(1);
  if (!secret) throw new Error("密钥不存在，或不属于当前用户");
  return secret;
}

export async function isSecretReferencedByModel(
  secretRefId: string,
  workspaceId: string,
) {
  const db = await getDb();
  const [reference] = await db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.workspaceId, workspaceId),
        eq(modelConnections.secretRefId, secretRefId),
      ),
    )
    .limit(1);
  return Boolean(reference);
}

export async function deleteModelSecretIfUnreferenced(input: {
  secretRefId: string;
  workspaceId: string;
}) {
  const db = await getDb();
  const [ownedModelSecret] = await db
    .select({ id: secretRefs.id })
    .from(secretRefs)
    .where(
      and(
        eq(secretRefs.id, input.secretRefId),
        eq(secretRefs.workspaceId, input.workspaceId),
        eq(secretRefs.purpose, "model_api_key"),
      ),
    )
    .limit(1);
  if (!ownedModelSecret) return false;
  if (await isSecretReferencedByModel(input.secretRefId, input.workspaceId)) {
    return false;
  }
  await db
    .delete(secretRefs)
    .where(
      and(
        eq(secretRefs.id, input.secretRefId),
        eq(secretRefs.workspaceId, input.workspaceId),
        eq(secretRefs.purpose, "model_api_key"),
      ),
    );
  return true;
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
  if (!secret) throw new Error("Secret 不存在或当前账号无权访问");
  await db
    .update(secretRefs)
    .set({ lastUsedAt: mysqlNow() })
    .where(eq(secretRefs.id, secret.id));
  return decrypt(secret.ciphertext, secret.iv);
}
