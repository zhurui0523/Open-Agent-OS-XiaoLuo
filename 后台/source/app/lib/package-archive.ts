import type { XiaoLuoPackageManifest } from "./package-contract";

const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_FILE_COUNT = 5_000;
const MAX_COMPRESSION_RATIO = 200;
const MANIFEST_NAMES = [
  "xiaoluo.plugin.json",
  ".xiaoluo/plugin.json",
  "manifest.json",
] as const;

interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  flags: number;
  externalAttributes: number;
  localHeaderOffset: number;
  directory: boolean;
}

export interface PackageArchiveFile {
  path: string;
  relativePath: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface PackageArchiveInspection {
  archiveSha256: string;
  manifest: XiaoLuoPackageManifest | Record<string, unknown>;
  manifestPath: string;
  rootPrefix: string;
  signature?: string;
  publisherKeyId?: string;
  checksumsVerified: boolean;
  files: PackageArchiveFile[];
  readFile(path: string): Promise<Uint8Array>;
}

export interface SourceArchiveInspection {
  archiveSha256: string;
  rootPrefix: string;
  files: PackageArchiveFile[];
  readFile(path: string): Promise<Uint8Array>;
}

export class PackageArchiveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PackageArchiveError";
    this.code = code;
  }
}

function exactArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(bytes: Uint8Array) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes)),
    ),
  );
}

function safeJson(bytes: Uint8Array, label: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new PackageArchiveError(
      "INVALID_JSON",
      `${label} 不是有效的 UTF-8 JSON`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedEntryName(value: string) {
  const name = value.replaceAll("\\", "/");
  if (
    !name ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    name.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new PackageArchiveError(
      "UNSAFE_PATH",
      `压缩包包含不安全路径：${JSON.stringify(value)}`,
    );
  }
  const directory = name.endsWith("/");
  const parts = name.split("/").filter(Boolean);
  if (
    !parts.length ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.includes(":") ||
        part.length > 240,
    )
  ) {
    throw new PackageArchiveError(
      "UNSAFE_PATH",
      `压缩包包含不安全路径：${JSON.stringify(value)}`,
    );
  }
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function sensitiveEntry(path: string) {
  const parts = path.toLowerCase().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  return (
    parts.includes(".git") ||
    parts.includes("node_modules") ||
    (name.startsWith(".env") &&
      ![".env.example", ".env.sample", ".env.template"].includes(name)) ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx")
  );
}

function locateEndRecord(bytes: Uint8Array) {
  if (bytes.byteLength < 22) {
    throw new PackageArchiveError("INVALID_ZIP", "压缩包内容不完整");
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const lowerBound = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END) return offset;
  }
  throw new PackageArchiveError(
    "INVALID_ZIP",
    "未找到 ZIP 目录，文件可能不是有效压缩包",
  );
}

function parseEntries(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new PackageArchiveError(
      "ARCHIVE_TOO_LARGE",
      "插件压缩包不能超过 50 MB",
    );
  }
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const endOffset = locateEndRecord(bytes);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries
  ) {
    throw new PackageArchiveError(
      "MULTI_DISK_UNSUPPORTED",
      "不支持分卷 ZIP 插件包",
    );
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new PackageArchiveError(
      "ZIP64_UNSUPPORTED",
      "当前不支持 ZIP64 插件包，请缩小文件后重试",
    );
  }
  if (totalEntries > MAX_FILE_COUNT) {
    throw new PackageArchiveError(
      "TOO_MANY_FILES",
      `插件包文件数量不能超过 ${MAX_FILE_COUNT}`,
    );
  }
  if (
    centralOffset + centralSize > bytes.byteLength ||
    centralOffset + centralSize > endOffset
  ) {
    throw new PackageArchiveError("INVALID_ZIP", "ZIP 中央目录越界");
  }

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > bytes.byteLength ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_FILE
    ) {
      throw new PackageArchiveError("INVALID_ZIP", "ZIP 中央目录记录损坏");
    }
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const crc32Value = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const recordEnd =
      cursor + 46 + nameLength + extraLength + commentLength;
    if (
      recordEnd > bytes.byteLength ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new PackageArchiveError(
        "INVALID_ZIP",
        "ZIP 文件记录越界或包含不支持的 ZIP64 字段",
      );
    }
    const rawName = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const name = normalizedEntryName(rawName);
    const lookupName = name.toLowerCase();
    if (names.has(lookupName)) {
      throw new PackageArchiveError(
        "DUPLICATE_PATH",
        `插件包包含重复路径：${name}`,
      );
    }
    names.add(lookupName);
    if ((flags & 0x1) !== 0) {
      throw new PackageArchiveError(
        "ENCRYPTED_ARCHIVE",
        `插件包不能包含加密文件：${name}`,
      );
    }
    if (![0, 8].includes(compressionMethod)) {
      throw new PackageArchiveError(
        "UNSUPPORTED_COMPRESSION",
        `文件 ${name} 使用了不支持的压缩算法`,
      );
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new PackageArchiveError(
        "SYMLINK_REJECTED",
        `插件包不能包含符号链接：${name}`,
      );
    }
    if (sensitiveEntry(name)) {
      throw new PackageArchiveError(
        "SENSITIVE_FILE",
        `插件包包含敏感或不应分发的文件：${name}`,
      );
    }
    const directory = name.endsWith("/");
    if (!directory && uncompressedSize > MAX_ENTRY_BYTES) {
      throw new PackageArchiveError(
        "ENTRY_TOO_LARGE",
        `插件包中的 ${name} 解压后超过 50 MB`,
      );
    }
    totalUncompressed += directory ? 0 : uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new PackageArchiveError(
        "ZIP_BOMB",
        "插件包解压后总大小不能超过 200 MB",
      );
    }
    if (
      !directory &&
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new PackageArchiveError(
        "ZIP_BOMB",
        `文件 ${name} 的压缩比异常，已拒绝导入`,
      );
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc32: crc32Value,
      flags,
      externalAttributes,
      localHeaderOffset,
      directory,
    });
    cursor = recordEnd;
  }
  return entries;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry) {
  if (entry.directory) return new Uint8Array();
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const offset = entry.localHeaderOffset;
  if (
    offset + 30 > bytes.byteLength ||
    view.getUint32(offset, true) !== ZIP_LOCAL_FILE
  ) {
    throw new PackageArchiveError(
      "INVALID_ZIP",
      `文件 ${entry.name} 的本地记录损坏`,
    );
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.byteLength) {
    throw new PackageArchiveError(
      "INVALID_ZIP",
      `文件 ${entry.name} 的压缩内容越界`,
    );
  }
  const compressed = bytes.subarray(dataOffset, dataEnd);
  let output: Uint8Array;
  if (entry.compressionMethod === 0) {
    output = Uint8Array.from(compressed);
  } else {
    const { inflateRawSync } = await import("node:zlib");
    output = Uint8Array.from(inflateRawSync(compressed, {
      maxOutputLength: Math.min(
        MAX_ENTRY_BYTES,
        Math.max(entry.uncompressedSize, 1),
      ),
    }));
  }
  if (
    output.byteLength !== entry.uncompressedSize ||
    crc32(output) !== entry.crc32
  ) {
    throw new PackageArchiveError(
      "INTEGRITY_MISMATCH",
      `文件 ${entry.name} 的大小或 CRC 校验失败`,
    );
  }
  return output;
}

function commonRootPrefix(entries: ZipEntry[]) {
  const files = entries.filter((entry) => !entry.directory);
  if (!files.length) return "";
  const firstSegments = new Set(
    files.map((entry) => entry.name.split("/")[0]),
  );
  if (firstSegments.size !== 1) return "";
  const prefix = `${files[0].name.split("/")[0]}/`;
  return files.every((entry) => entry.name.startsWith(prefix)) ? prefix : "";
}

function findPackageFile(
  entries: ZipEntry[],
  rootPrefix: string,
  names: readonly string[],
) {
  const lookups = new Set(
    names.flatMap((name) => [name, rootPrefix ? `${rootPrefix}${name}` : name]),
  );
  return entries.filter(
    (entry) => !entry.directory && lookups.has(entry.name),
  );
}

async function verifyChecksums(
  bytes: Uint8Array,
  entries: ZipEntry[],
  rootPrefix: string,
  checksumEntry: ZipEntry | undefined,
) {
  if (!checksumEntry) return false;
  const value = safeJson(
    await readEntry(bytes, checksumEntry),
    checksumEntry.name,
  );
  const checksums =
    isRecord(value) && isRecord(value.files) ? value.files : value;
  if (!isRecord(checksums)) {
    throw new PackageArchiveError(
      "INVALID_CHECKSUMS",
      "checksums.json 必须是文件路径到 SHA-256 的对象",
    );
  }
  const ignored = new Set([
    "checksums.json",
    "xiaoluo.signature.json",
    "signature.json",
    "signature.sig",
    "publisher-key-id.txt",
  ]);
  const files = entries.filter((entry) => {
    if (entry.directory) return false;
    const relative = rootPrefix && entry.name.startsWith(rootPrefix)
      ? entry.name.slice(rootPrefix.length)
      : entry.name;
    return !ignored.has(relative);
  });
  for (const entry of files) {
    const relative = rootPrefix && entry.name.startsWith(rootPrefix)
      ? entry.name.slice(rootPrefix.length)
      : entry.name;
    const expected: string =
      typeof checksums[relative] === "string"
        ? (checksums[relative] as string)
        : typeof checksums[entry.name] === "string"
          ? (checksums[entry.name] as string)
          : "";
    if (!/^[a-f0-9]{64}$/i.test(expected)) {
      throw new PackageArchiveError(
        "CHECKSUM_MISSING",
        `checksums.json 缺少 ${relative} 的有效 SHA-256`,
      );
    }
    const actual = await sha256(await readEntry(bytes, entry));
    if (actual !== expected.toLowerCase()) {
      throw new PackageArchiveError(
        "CHECKSUM_MISMATCH",
        `文件 ${relative} 的 SHA-256 与 checksums.json 不一致`,
      );
    }
  }
  return true;
}

async function openArchive(
  input: ArrayBuffer | Uint8Array,
): Promise<{
  bytes: Uint8Array;
  entries: ZipEntry[];
  inspection: SourceArchiveInspection;
}> {
  const bytes =
    input instanceof Uint8Array ? Uint8Array.from(input) : new Uint8Array(input);
  const entries = parseEntries(bytes);
  const rootPrefix = commonRootPrefix(entries);
  const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    bytes,
    entries,
    inspection: {
      archiveSha256: await sha256(bytes),
      rootPrefix,
      files: entries
        .filter((entry) => !entry.directory)
        .map((entry) => ({
          path: entry.name,
          relativePath:
            rootPrefix && entry.name.startsWith(rootPrefix)
              ? entry.name.slice(rootPrefix.length)
              : entry.name,
          compressedBytes: entry.compressedSize,
          uncompressedBytes: entry.uncompressedSize,
        })),
      async readFile(path: string) {
        const entry = entryMap.get(normalizedEntryName(path));
        if (!entry || entry.directory) {
          throw new PackageArchiveError(
            "FILE_NOT_FOUND",
            `插件包中不存在文件：${path}`,
          );
        }
        return readEntry(bytes, entry);
      },
    },
  };
}

export async function inspectSourceArchive(
  input: ArrayBuffer | Uint8Array,
) {
  return (await openArchive(input)).inspection;
}

export async function inspectPackageArchive(
  input: ArrayBuffer | Uint8Array,
): Promise<PackageArchiveInspection> {
  const { bytes, entries, inspection } = await openArchive(input);
  const { rootPrefix } = inspection;
  const manifestEntries = findPackageFile(
    entries,
    rootPrefix,
    MANIFEST_NAMES,
  );
  if (!manifestEntries.length) {
    throw new PackageArchiveError(
      "PACKAGE_MANIFEST_MISSING",
      "压缩包中缺少 xiaoluo.plugin.json（或 .xiaoluo/plugin.json）",
    );
  }
  if (manifestEntries.length > 1) {
    throw new PackageArchiveError(
      "AMBIGUOUS_MANIFEST",
      "压缩包包含多个 Package Manifest，无法确定安装目标",
    );
  }
  const manifestEntry = manifestEntries[0];
  const manifest = safeJson(
    await readEntry(bytes, manifestEntry),
    manifestEntry.name,
  );
  if (!isRecord(manifest)) {
    throw new PackageArchiveError(
      "INVALID_MANIFEST",
      "Package Manifest 必须是 JSON 对象",
    );
  }

  const checksumEntry = findPackageFile(
    entries,
    rootPrefix,
    ["checksums.json"],
  )[0];
  const checksumsVerified = await verifyChecksums(
    bytes,
    entries,
    rootPrefix,
    checksumEntry,
  );
  const signatureEntry = findPackageFile(
    entries,
    rootPrefix,
    ["xiaoluo.signature.json", "signature.json"],
  )[0];
  let signature: string | undefined;
  let publisherKeyId: string | undefined;
  if (signatureEntry) {
    const signaturePayload = safeJson(
      await readEntry(bytes, signatureEntry),
      signatureEntry.name,
    );
    if (!isRecord(signaturePayload)) {
      throw new PackageArchiveError(
        "INVALID_SIGNATURE",
        "签名文件必须是 JSON 对象",
      );
    }
    signature =
      typeof signaturePayload.signature === "string"
        ? signaturePayload.signature.trim()
        : undefined;
    publisherKeyId =
      typeof signaturePayload.publisherKeyId === "string"
        ? signaturePayload.publisherKeyId.trim()
        : undefined;
  }
  return {
    archiveSha256: inspection.archiveSha256,
    manifest,
    manifestPath: manifestEntry.name,
    rootPrefix,
    signature,
    publisherKeyId,
    checksumsVerified,
    files: inspection.files,
    readFile: inspection.readFile,
  };
}
