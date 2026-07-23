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

export async function getFileBucket(): Promise<FileBucket> {
  const config = serverRuntimeConfig();
  if (config.storage.driver !== "r2") {
    throw new Error(
      "当前部署包未启用 OSS 驱动。OSS 适配器仅在自托管 Node 运行时加载。",
    );
  }
  const { env } = await import("cloudflare:workers");
  const bucket = (env as unknown as { FILES?: FileBucket }).FILES;
  if (!bucket) {
    throw new Error(
      "文件存储未连接。请将 .openai/hosting.json 的 r2 绑定设置为 FILES。",
    );
  }
  return bucket;
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
    currentVersion: row.currentVersion,
    versionCount: row.versionCount,
    status: row.status as FileSystemAsset["status"],
    trashedAt: row.trashedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contentUrl: `/api/v2/files/content?assetId=${encodeURIComponent(row.id)}`,
    downloadUrl: `/api/v2/files/content?assetId=${encodeURIComponent(row.id)}&download=1`,
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
  const now = new Date().toISOString();
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
    status: "ready",
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
  await db.batch([
    db.insert(assets).values(saved),
    db.insert(assetVersions).values(version),
  ]);
  return serializeFileAsset(saved);
}

export async function storeAssetVersion(
  db: Database,
  bucket: FileBucket,
  asset: AssetRow,
  input: Omit<StoreAssetInput, "folderId" | "tags" | "description">,
) {
  if (!input.bytes.byteLength) throw new Error("文件内容为空");
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error("单个文件暂时不能超过 100 MB");
  }
  const now = new Date().toISOString();
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
  const [, updatedRows] = await db.batch([
    db.insert(assetVersions).values({
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
    }),
    db
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
      .where(eq(assets.id, asset.id))
      .returning(),
  ]);
  const [updated] = updatedRows;
  return serializeFileAsset(updated);
}
