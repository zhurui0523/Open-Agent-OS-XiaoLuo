import { eq } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  assets,
  assetVersions,
} from "../../db/schema";
import type {
  AssetKind,
  FileSystemAsset,
} from "../types";
import { serverRuntimeConfig } from "./server-runtime-config";
import { mysqlNow } from "./mysql";

type Database = Awaited<ReturnType<typeof getDb>>;
type AssetRow = typeof assets.$inferSelect;

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

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

export async function getFileBucket(): Promise<FileBucket> {
  const { oss } = serverRuntimeConfig().storage;
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
      headers.set(`x-oss-meta-${name.toLowerCase()}`, value);
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
    folderId: row.folderId,
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
  folderId?: string | null;
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
    folderId: input.folderId ?? null,
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
    "workspaceId" | "folderId" | "tags" | "description"
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
      customMetadata: { sha256: hash, originalName: input.name },
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
