import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  assets,
  assetVersions,
} from "../../db/schema";
import type {
  AssetKind,
  FileSystemAsset,
} from "../types";
import {
  canonicalUploadMimeType,
  fileExtension,
  SUPPORTED_FILE_GROUPS,
} from "./file-formats";
import { serverRuntimeConfig } from "./server-runtime-config";
import { mysqlNow } from "./mysql";

type Database = Awaited<ReturnType<typeof getDb>>;
type AssetRow = typeof assets.$inferSelect;

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function hasExpectedSignature(mimeType: string, bytes: Uint8Array) {
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return !bytes.slice(0, Math.min(bytes.length, 8_192)).includes(0);
  }
  if (mimeType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === "image/gif") {
    return (
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    );
  }
  if (mimeType === "image/webp") {
    return (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    );
  }
  if (mimeType === "image/avif") {
    return (
      startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
      new TextDecoder("ascii")
        .decode(bytes.slice(8, Math.min(bytes.length, 32)))
        .includes("avif")
    );
  }
  if (mimeType === "image/bmp") {
    return startsWith(bytes, [0x42, 0x4d]);
  }
  if (mimeType === "application/pdf") {
    return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  }
  if (
    mimeType === "application/zip" ||
    mimeType.includes("openxmlformats-officedocument")
  ) {
    return (
      startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
    );
  }
  if (
    mimeType === "application/msword" ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.ms-powerpoint"
  ) {
    return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  }
  if (
    mimeType === "video/mp4" ||
    mimeType === "video/quicktime" ||
    mimeType === "audio/mp4"
  ) {
    return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4);
  }
  if (mimeType === "video/webm") {
    return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  }
  if (mimeType === "video/ogg") {
    return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]);
  }
  if (mimeType === "audio/mpeg") {
    return (
      startsWith(bytes, [0x49, 0x44, 0x33]) ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    );
  }
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return (
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
    );
  }
  if (mimeType === "audio/flac") {
    return startsWith(bytes, [0x66, 0x4c, 0x61, 0x43]);
  }
  if (mimeType === "audio/ogg") {
    return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]);
  }
  if (mimeType === "audio/aac") {
    return (
      bytes[0] === 0xff &&
      (bytes[1] === 0xf1 || bytes[1] === 0xf9)
    );
  }
  return true;
}

export function validateUploadedFile(input: {
  name: string;
  declaredMimeType?: string | null;
  bytes: ArrayBuffer;
}) {
  if (!input.bytes.byteLength) throw new Error("文件内容为空");
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("单个文件暂时不能超过 100 MB");
  }
  const normalizedName = sanitizeAssetName(input.name);
  const extension = fileExtension(normalizedName);
  const resolved = canonicalUploadMimeType(
    normalizedName,
    input.declaredMimeType,
  );
  if (!extension || !resolved) {
    const summary = SUPPORTED_FILE_GROUPS
      .map((group) => `${group.label}（${group.extensions.join("、")}）`)
      .join("；");
    throw new Error(`不支持该文件类型；当前支持：${summary}`);
  }
  const mimeType = resolved.mimeType;
  if (!hasExpectedSignature(mimeType, new Uint8Array(input.bytes))) {
    throw new Error("文件内容与扩展名不一致，已拒绝上传");
  }
  return { name: normalizedName, mimeType };
}

export interface FileBucketObject {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  etag: string;
  httpEtag?: string;
  range?: { offset?: number; length?: number };
  httpMetadata?: { contentType?: string };
}

export interface FileBucket {
  health(): Promise<void>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number } },
  ): Promise<FileBucketObject | null>;
  delete(key: string | string[]): Promise<void>;
}

async function getLocalFileBucket(rootSetting: string): Promise<FileBucket> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(process.cwd(), rootSetting);

  function objectPath(key: string) {
    const segments = key
      .replaceAll("\\", "/")
      .split("/")
      .filter(Boolean);
    if (
      !segments.length ||
      segments.some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          segment.includes("\0"),
      )
    ) {
      throw new Error("本地存储对象键无效");
    }
    const target = path.resolve(root, ...segments);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("本地存储对象越过了允许目录");
    }
    return target;
  }

  function metadataPath(target: string) {
    return `${target}.xiaoluo-meta.json`;
  }

  async function digest(bytes: Uint8Array) {
    const value = await crypto.subtle.digest(
      "SHA-256",
      Uint8Array.from(bytes).buffer,
    );
    return `"${Array.from(new Uint8Array(value))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}"`;
  }

  async function remove(key: string) {
    const target = objectPath(key);
    await Promise.all([
      fs.rm(target, { force: true }),
      fs.rm(metadataPath(target), { force: true }),
    ]);
  }

  return {
    async health() {
      await fs.mkdir(root, { recursive: true });
      const probe = path.join(root, ".xiaoluo-write-probe");
      await fs.writeFile(probe, "ready", "utf8");
      await fs.rm(probe, { force: true });
    },
    async put(key, value, options) {
      const target = objectPath(key);
      const valueBuffer =
        value instanceof ReadableStream
          ? await new Response(value).arrayBuffer()
          : value instanceof ArrayBuffer
            ? value
            : Uint8Array.from(value).buffer;
      const bytes = new Uint8Array(valueBuffer);
      const etag = await digest(bytes);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const suffix = `${process.pid}-${crypto.randomUUID()}`;
      const temporary = `${target}.${suffix}.tmp`;
      const temporaryMetadata = `${metadataPath(target)}.${suffix}.tmp`;
      await fs.writeFile(temporary, bytes);
      await fs.writeFile(
        temporaryMetadata,
        JSON.stringify({
          contentType:
            options?.httpMetadata?.contentType ??
            "application/octet-stream",
          customMetadata: options?.customMetadata ?? {},
          etag,
        }),
        "utf8",
      );
      await fs.rename(temporary, target);
      await fs.rename(temporaryMetadata, metadataPath(target));
      return { etag };
    },
    async get(key, options) {
      const target = objectPath(key);
      try {
        const [bytes, stat, metadataText] = await Promise.all([
          fs.readFile(target),
          fs.stat(target),
          fs.readFile(metadataPath(target), "utf8").catch(() => "{}"),
        ]);
        const metadata = JSON.parse(metadataText) as {
          contentType?: string;
          etag?: string;
        };
        const offset = Math.max(0, options?.range?.offset ?? 0);
        const requestedLength = options?.range?.length;
        const end =
          requestedLength === undefined
            ? bytes.length
            : Math.min(bytes.length, offset + Math.max(0, requestedLength));
        const selected =
          options?.range === undefined ? bytes : bytes.subarray(offset, end);
        const etag = metadata.etag || (await digest(bytes));
        return {
          body: new Response(selected).body,
          size: options?.range === undefined ? stat.size : selected.byteLength,
          etag,
          httpEtag: etag,
          range: options?.range,
          httpMetadata: {
            contentType:
              metadata.contentType ?? "application/octet-stream",
          },
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
    },
    async delete(key) {
      if (Array.isArray(key)) {
        await Promise.all(key.map(remove));
      } else {
        await remove(key);
      }
    },
  };
}

function ossObjectUrl(
  origin: string,
  key = "",
  query = "",
) {
  const encodedKey = key
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${origin}/${encodedKey}${query}`;
}

function ossOrigin(config: {
  bucket: string;
  region: string;
  endpoint: string | null;
}) {
  const rawEndpoint =
    config.endpoint?.trim() || `${config.region}.aliyuncs.com`;
  const url = new URL(
    /^https?:\/\//i.test(rawEndpoint)
      ? rawEndpoint
      : `https://${rawEndpoint}`,
  );
  if (!url.hostname.startsWith(`${config.bucket}.`)) {
    url.hostname = `${config.bucket}.${url.hostname}`;
  }
  return url.origin;
}

function base64(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function ossAuthorization(input: {
  accessKeyId: string;
  accessKeySecret: string;
  method: string;
  contentType: string;
  date: string;
  canonicalHeaders: string;
  canonicalResource: string;
}) {
  const stringToSign = [
    input.method,
    "",
    input.contentType,
    input.date,
    `${input.canonicalHeaders}${input.canonicalResource}`,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.accessKeySecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(stringToSign),
  );
  return `OSS ${input.accessKeyId}:${base64(signature)}`;
}

async function ossQuerySignature(input: {
  accessKeySecret: string;
  canonicalResource: string;
  expires: number;
}) {
  const stringToSign = [
    "GET",
    "",
    "",
    String(input.expires),
    input.canonicalResource,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.accessKeySecret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return base64(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(stringToSign),
    ),
  );
}

/**
 * Returns a short-lived URL that a remote model provider can fetch without
 * inheriting the browser session. Browser-facing asset URLs deliberately stay
 * private and relative; they must never be sent to a third party as-is.
 */
export async function externalAssetAccessUrl(
  db: Database,
  input: {
    assetId: string;
    workspaceId: string;
    expiresInSeconds?: number;
  },
) {
  const [asset] = await db
    .select({
      blobKey: assetVersions.blobKey,
      mimeType: assetVersions.mimeType,
      size: assetVersions.size,
    })
    .from(assets)
    .innerJoin(
      assetVersions,
      eq(assetVersions.id, assets.currentVersionId),
    )
    .where(
      and(
        eq(assets.id, input.assetId),
        eq(assets.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!asset) throw new Error("输入素材不存在或无权访问");

  const storage = serverRuntimeConfig().storage;
  if (storage.driver === "oss") {
    const expires =
      Math.floor(Date.now() / 1000) +
      Math.max(300, Math.min(input.expiresInSeconds ?? 7_200, 86_400));
    const canonicalResource = `/${storage.oss.bucket}/${asset.blobKey}`;
    const signature = await ossQuerySignature({
      accessKeySecret: storage.oss.accessKeySecret,
      canonicalResource,
      expires,
    });
    const query = new URLSearchParams({
      OSSAccessKeyId: storage.oss.accessKeyId,
      Expires: String(expires),
      Signature: signature,
    });
    return ossObjectUrl(
      ossOrigin(storage.oss),
      asset.blobKey,
      `?${query.toString()}`,
    );
  }

  // Local storage has no public origin. A data URI keeps local development
  // functional for ordinary reference assets while avoiding an authenticated
  // localhost URL that external providers cannot reach.
  if (asset.size > 50 * 1024 * 1024) {
    throw new Error("本地素材超过 50 MB，无法作为第三方模型的内联输入");
  }
  const object = await (await getFileBucket()).get(asset.blobKey);
  if (!object?.body) throw new Error("输入素材内容不存在");
  const bytes = await new Response(object.body).arrayBuffer();
  return `data:${asset.mimeType};base64,${base64(bytes)}`;
}

export async function getFileBucket(): Promise<FileBucket> {
  const storage = serverRuntimeConfig().storage;
  if (storage.driver === "local") {
    return getLocalFileBucket(storage.local.root);
  }
  const { oss } = storage;
  const origin = ossOrigin(oss);

  async function request(input: {
    method: "GET" | "PUT" | "DELETE";
    key?: string;
    query?: string;
    body?: ArrayBuffer;
    contentType?: string;
    range?: string;
    metadata?: Record<string, string>;
  }) {
    const date = new Date().toUTCString();
    const contentType = input.contentType ?? "";
    const headers = new Headers({ Date: date });
    if (contentType) headers.set("content-type", contentType);
    if (input.range) headers.set("range", input.range);
    Object.entries(input.metadata ?? {}).forEach(([name, value]) => {
      // Fetch Headers only accepts ByteString values. OSS user metadata is
      // carried in HTTP headers, so Unicode values (for example Chinese file
      // names) must be converted to an ASCII-safe representation first.
      headers.set(
        `x-oss-meta-${name.toLowerCase()}`,
        encodeURIComponent(value),
      );
    });
    const canonicalHeaders = [...headers.entries()]
      .filter(([name]) => name.startsWith("x-oss-"))
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([name, value]) => `${name}:${value.trim()}\n`)
      .join("");
    const key = input.key ?? "";
    const query = input.query ?? "";
    const canonicalResource = `/${oss.bucket}/${key}${query}`;
    headers.set(
      "authorization",
      await ossAuthorization({
        accessKeyId: oss.accessKeyId,
        accessKeySecret: oss.accessKeySecret,
        method: input.method,
        contentType,
        date,
        canonicalHeaders,
        canonicalResource,
      }),
    );
    return fetch(ossObjectUrl(origin, key, query), {
      method: input.method,
      headers,
      body: input.body,
      signal: AbortSignal.timeout(8_000),
    });
  }

  return {
    async health() {
      const response = await request({
        method: "GET",
        query: "?bucketInfo",
      });
      if (!response.ok) {
        throw new Error(`OSS readiness check failed (${response.status})`);
      }
    },
    async put(key, value, options) {
      const bytes =
        value instanceof ReadableStream
          ? await new Response(value).arrayBuffer()
          : value;
      const payload =
        bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer;
      const response = await request({
        method: "PUT",
        key,
        body: payload,
        contentType:
          options?.httpMetadata?.contentType ?? "application/octet-stream",
        metadata: options?.customMetadata,
      });
      if (!response.ok) {
        throw new Error(`OSS upload failed (${response.status})`);
      }
      return { etag: response.headers.get("etag") ?? "" };
    },
    async get(key, options) {
      const range = options?.range;
      const end =
        range?.offset === undefined || range.length === undefined
          ? ""
          : String(range.offset + range.length - 1);
      const response = await request({
        method: "GET",
        key,
        range:
          range?.offset === undefined
            ? undefined
            : `bytes=${range.offset}-${end}`,
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`OSS download failed (${response.status})`);
      }
      const etag = response.headers.get("etag") ?? "";
      return {
        body: response.body,
        size: Number(response.headers.get("content-length") ?? 0),
        etag,
        httpEtag: etag,
        range,
        httpMetadata: {
          contentType:
            response.headers.get("content-type") ??
            "application/octet-stream",
        },
      };
    },
    async delete(key) {
      if (Array.isArray(key)) {
        await Promise.all(
          key.map(async (item) => {
            const response = await request({ method: "DELETE", key: item });
            if (!response.ok && response.status !== 404) {
              throw new Error(`OSS delete failed (${response.status})`);
            }
          }),
        );
        return;
      }
      const response = await request({ method: "DELETE", key });
      if (!response.ok && response.status !== 404) {
        throw new Error(`OSS delete failed (${response.status})`);
      }
    },
  };
}

export function assetKindFromMime(mimeType: string): AssetKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime.includes("json")) return "text";
  if (
    mime.includes("pdf") ||
    mime.includes("document") ||
    mime.includes("spreadsheet") ||
    mime.includes("presentation") ||
    mime.includes("word") ||
    mime.includes("excel") ||
    mime.includes("powerpoint")
  ) {
    return "document";
  }
  if (
    mime.includes("zip") ||
    mime.includes("gzip") ||
    mime.includes("tar") ||
    mime.includes("compressed")
  ) {
    return "archive";
  }
  return "other";
}

export function sanitizeAssetName(value: string) {
  const cleaned = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "未命名文件";
}

export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseTags(value: string) {
  try {
    const tags = JSON.parse(value) as unknown;
    return Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export function serializeFileAsset(row: AssetRow): FileSystemAsset {
  const versionedUri = `${row.uri}@${row.currentVersion}`;
  return {
    id: row.id,
    uri: versionedUri,
    name: row.name,
    kind: row.kind as AssetKind,
    mimeType: row.mimeType,
    size: row.size,
    tags: parseTags(row.tagsJson),
    description: row.description,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    contentHash: row.contentHash,
    favorite: row.favorite,
    currentVersion: row.currentVersion,
    versionCount: row.versionCount,
    status: row.status as FileSystemAsset["status"],
    trashedAt: row.trashedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contentUrl: `/api/v2/files/content?assetId=${encodeURIComponent(row.id)}&workspaceId=${encodeURIComponent(row.workspaceId)}`,
    downloadUrl: `/api/v2/files/content?assetId=${encodeURIComponent(row.id)}&workspaceId=${encodeURIComponent(row.workspaceId)}&download=1`,
  };
}

function searchableText(bytes: ArrayBuffer, mimeType: string) {
  if (
    bytes.byteLength > 512 * 1024 ||
    (!mimeType.startsWith("text/") && !mimeType.includes("json"))
  ) {
    return "";
  }
  return new TextDecoder().decode(bytes).slice(0, 120_000);
}

export interface StoreAssetInput {
  workspaceId: string;
  name: string;
  mimeType: string;
  bytes: ArrayBuffer;
  tags?: string[];
  description?: string;
  sourceType?: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown>;
}

export async function storeAsset(
  db: Database,
  bucket: FileBucket,
  input: StoreAssetInput,
) {
  if (!input.bytes.byteLength) throw new Error("文件内容为空");
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("单个文件暂时不能超过 100 MB");
  }
  const now = mysqlNow();
  const hash = await sha256Hex(input.bytes);
  const [existingBlob] = await db
    .select({ blobKey: assetVersions.blobKey })
    .from(assetVersions)
    .where(eq(assetVersions.contentHash, hash))
    .limit(1);
  const blobKey = existingBlob?.blobKey ?? `blobs/sha256/${hash}`;
  if (!existingBlob) {
    await bucket.put(blobKey, input.bytes, {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: {
        sha256: hash,
        originalName: sanitizeAssetName(input.name),
      },
    });
  }

  const assetId = `asset_${crypto.randomUUID()}`;
  const versionId = `aver_${crypto.randomUUID()}`;
  const name = sanitizeAssetName(input.name);
  const kind = assetKindFromMime(input.mimeType);
  const uri = `asset://workspace/${assetId}`;
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, 24);
  const searchText = [
    name,
    input.description ?? "",
    tags.join(" "),
    searchableText(input.bytes, input.mimeType),
  ]
    .filter(Boolean)
    .join("\n");
  const saved: AssetRow = {
    id: assetId,
    workspaceId: input.workspaceId,
    uri,
    name,
    kind,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.bytes.byteLength,
    currentVersionId: versionId,
    currentVersion: 1,
    versionCount: 1,
    tagsJson: JSON.stringify(tags),
    description: input.description ?? "",
    searchText,
    sourceType: input.sourceType ?? "upload",
    sourceRef: input.sourceRef ?? null,
    contentHash: hash,
    favorite: false,
    status: "ready",
    missingAt: null,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const version = {
    id: versionId,
    assetId,
    version: 1,
    blobKey,
    contentHash: hash,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.bytes.byteLength,
    sourceType: input.sourceType ?? "upload",
    sourceRef: input.sourceRef ?? null,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: now,
  };
  await db.transaction(async (transaction) => {
    await transaction.insert(assets).values(saved);
    await transaction.insert(assetVersions).values(version);
  });
  return serializeFileAsset(saved);
}

export async function storeAssetVersion(
  db: Database,
  bucket: FileBucket,
  asset: AssetRow,
  input: Omit<
    StoreAssetInput,
    "workspaceId" | "tags" | "description"
  >,
) {
  if (!input.bytes.byteLength) throw new Error("文件内容为空");
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("单个文件暂时不能超过 100 MB");
  }
  const now = mysqlNow();
  const hash = await sha256Hex(input.bytes);
  const [existingBlob] = await db
    .select({ blobKey: assetVersions.blobKey })
    .from(assetVersions)
    .where(eq(assetVersions.contentHash, hash))
    .limit(1);
  const blobKey = existingBlob?.blobKey ?? `blobs/sha256/${hash}`;
  if (!existingBlob) {
    await bucket.put(blobKey, input.bytes, {
      httpMetadata: { contentType: input.mimeType },
      customMetadata: {
        sha256: hash,
        originalName: sanitizeAssetName(input.name),
      },
    });
  }
  const nextVersion = asset.currentVersion + 1;
  const versionId = `aver_${crypto.randomUUID()}`;
  await db.transaction(async (transaction) => {
    await transaction.insert(assetVersions).values({
      id: versionId,
      assetId: asset.id,
      version: nextVersion,
      blobKey,
      contentHash: hash,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
      sourceType: input.sourceType ?? "version-upload",
      sourceRef: input.sourceRef ?? null,
      metadataJson: JSON.stringify(input.metadata ?? {}),
      createdAt: now,
    });
    await transaction
      .update(assets)
      .set({
        name: sanitizeAssetName(input.name || asset.name),
        kind: assetKindFromMime(input.mimeType),
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        currentVersionId: versionId,
        currentVersion: nextVersion,
        versionCount: asset.versionCount + 1,
        contentHash: hash,
        searchText: [
          asset.searchText,
          searchableText(input.bytes, input.mimeType),
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 240_000),
        updatedAt: now,
      })
      .where(eq(assets.id, asset.id));
  });
  const [updated] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, asset.id))
    .limit(1);
  if (!updated) throw new Error("文件版本保存后无法读取资产");
  return serializeFileAsset(updated);
}
