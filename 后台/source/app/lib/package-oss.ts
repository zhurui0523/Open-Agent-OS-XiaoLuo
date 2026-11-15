import { getFileBucket } from "./asset-kernel";
import {
  packageContentPrefix,
  packageFilesIndexKey,
} from "./capability-mirror";

/**
 * PACKAGE-OSS：隔离 Package 包体以远程 OSS 为唯一事实源。
 * 安装时把包体文件 + manifest + permissions + files-index.json 上传到
 * caps/packages/<key>/<version>/；执行前 ensurePackageMaterialized 把包体
 * 按需物化到 PACKAGE_ROOT 本地缓存（按 .integrity-sha256 标记命中复用），
 * 本地缓存可随时删除，删了会自动从 OSS 重新拉取。
 */

export interface PackageOssFile {
  relativePath: string;
  read: () => Promise<Uint8Array>;
}

interface FilesIndexEntry {
  relativePath: string;
  sha256: string;
  size: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** 安装写路径：包体 + 清单 + 文件索引整包上传 OSS（失败即安装失败，不留静默缺口） */
export async function uploadPackageContentToOss(input: {
  packageKey: string;
  version: string;
  manifestJson: string;
  permissionsJson: string;
  files: PackageOssFile[];
}): Promise<{ uploaded: number; indexKey: string }> {
  const bucket = await getFileBucket();
  const prefix = packageContentPrefix(input.packageKey, input.version);
  const index: FilesIndexEntry[] = [];
  for (const file of input.files) {
    if (!file.relativePath) continue;
    const bytes = await file.read();
    await bucket.put(`${prefix}files/${file.relativePath}`, bytes);
    index.push({
      relativePath: file.relativePath,
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
    });
  }
  await bucket.put(prefix + "manifest.json", jsonBytes(JSON.parse(input.manifestJson)), {
    httpMetadata: { contentType: "application/json" },
  });
  await bucket.put(prefix + "permissions.json", jsonBytes(JSON.parse(input.permissionsJson)), {
    httpMetadata: { contentType: "application/json" },
  });
  const indexKey = packageFilesIndexKey(input.packageKey, input.version);
  await bucket.put(indexKey, jsonBytes(index), {
    httpMetadata: { contentType: "application/json" },
  });
  return { uploaded: index.length, indexKey };
}

function packageCacheRoot(): string {
  return process.env.PACKAGE_ROOT?.trim() || ".local-data/isolated-packages";
}

/** 执行读路径：本地缓存缺失/摘要不符时从 OSS 物化；命中缓存零网络开销 */
export async function ensurePackageMaterialized(input: {
  packageKey: string;
  version: string;
  integritySha256: string;
}): Promise<{ prepared: boolean; reason: string }> {
  if (!/^[a-zA-Z0-9._-]+$/.test(input.packageKey) || !/^[a-zA-Z0-9._-]+$/.test(input.version)) {
    throw new Error("Package key/version 非法，无法物化");
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(process.cwd(), packageCacheRoot());
  const packageRoot = path.resolve(root, input.packageKey, input.version);
  if (!packageRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("隔离 Package 目标目录无效");
  }
  const markerPath = path.join(packageRoot, ".integrity-sha256");
  try {
    const current = (await fs.readFile(markerPath, "utf8")).trim();
    if (current === input.integritySha256) {
      return { prepared: true, reason: "cache-hit" };
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const bucket = await getFileBucket();
  const indexObject = await bucket.get(
    packageFilesIndexKey(input.packageKey, input.version),
  );
  if (!indexObject?.body) {
    return { prepared: false, reason: "oss-content-missing" };
  }
  const index = JSON.parse(await new Response(indexObject.body).text()) as FilesIndexEntry[];
  await fs.mkdir(root, { recursive: true });
  const stage = await fs.mkdtemp(path.join(root, ".xiaoluo-oss-stage-"));
  try {
    const prefix = packageContentPrefix(input.packageKey, input.version);
    for (const entry of index) {
      const object = await bucket.get(`${prefix}files/${entry.relativePath}`);
      if (!object?.body) throw new Error(`OSS 包体文件缺失：${entry.relativePath}`);
      const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
      const actual = await sha256Hex(bytes);
      if (actual !== entry.sha256) {
        throw new Error(`OSS 包体文件摘要不符：${entry.relativePath}`);
      }
      const target = path.resolve(stage, ...entry.relativePath.split("/"));
      if (!target.startsWith(`${stage}${path.sep}`)) {
        throw new Error("插件文件越过隔离 Package 目录");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    await fs.writeFile(path.join(stage, ".integrity-sha256"), input.integritySha256, "utf8");
    await fs.rm(packageRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.rename(stage, packageRoot);
    return { prepared: true, reason: "materialized-from-oss" };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
