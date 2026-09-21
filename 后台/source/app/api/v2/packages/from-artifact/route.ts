/**
 * POST /api/v2/packages/from-artifact
 * 将代码产物生成插件并安装到能力中心（SHARE-CHAIN-FIX 全链路修复版）。
 * 链路：产物文件 → ZIP 源制品（stored）→ 存入文件桶（官方 packageArtifactKey）
 *   → 构造官方 sandbox-ui Manifest（runtime.entry 指向 /api/v2/packages/runtime/static/ 内部静态地址）
 *   → 复用 installPackage 安装。安装后「打开沙盒」走官方静态服务（含 CRC/完整性校验与授权）。
 */

import { createHash } from "node:crypto";
import { requireUser } from "../../../../lib/auth";
import {
  packageArtifactKey,
  storePackageArtifact,
} from "../../../../lib/package-import";
import { installPackage } from "../route";

interface ArtifactFile {
  path: string;
  content: string;
}

interface FromArtifactRequest {
  name: string;
  description?: string;
  workspaceId?: string;
  files: ArtifactFile[];
  entryFile?: string;
}

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 归一化产物内相对路径：拒绝绝对路径/目录穿越/非法字符 */
function normalizeArtifactPath(raw: unknown, index: number): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Response(JSON.stringify({ error: `files[${index}].path 不能为空` }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const name = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = name.split("/").filter(Boolean);
  if (
    !parts.length ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    parts.some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Response(JSON.stringify({ error: `files[${index}].path 不是安全的相对路径` }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return parts.join("/");
}

/** 插件名称 → 稳定的反向域名式 Package ID（满足 ^[a-z0-9]+(?:[._-][a-z0-9]+){1,}$） */
function buildPackageKey(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "plugin";
  return `xiaoluo.artifact.${slug}-${Date.now().toString(36)}`;
}

// ---------- 最小 ZIP 写入器（stored 存储模式，与 package-archive 解析器严格匹配） ----------

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
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

function buildStoredZip(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30 + nameBytes.length + file.bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 文件名标志
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.bytes.length, true);
    lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(file.bytes, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.bytes.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // 常规文件，非符号链接
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);
  const out = new Uint8Array(offset + centralSize + eocd.length);
  let position = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as FromArtifactRequest;

    const name = body.name?.trim() ?? "";
    const workspaceId = body.workspaceId?.trim() ?? "";
    if (!name) {
      return Response.json({ error: "插件名称不能为空" }, { status: 400 });
    }
    if (!workspaceId) {
      return Response.json({ error: "缺少 workspaceId" }, { status: 400 });
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return Response.json({ error: "至少需要一个文件" }, { status: 400 });
    }
    if (body.files.length > MAX_FILES) {
      return Response.json(
        { error: `产物文件数量不能超过 ${MAX_FILES}` },
        { status: 400 },
      );
    }

    // 归一化文件并编码为字节
    const encoder = new TextEncoder();
    const entries = new Map<string, Uint8Array>();
    let totalBytes = 0;
    body.files.forEach((file, index) => {
      const relativePath = normalizeArtifactPath(file.path, index);
      if (typeof file.content !== "string") {
        throw new Response(
          JSON.stringify({ error: `files[${index}].content 必须是字符串` }),
          { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
      const bytes = encoder.encode(file.content);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Response(JSON.stringify({ error: "产物总大小不能超过 20 MB" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      entries.set(relativePath, bytes);
    });

    // 确定沙盒入口：优先显式 entryFile，其次 index.html，再次首个 HTML
    const paths = [...entries.keys()];
    const requestedEntry =
      typeof body.entryFile === "string" && body.entryFile.trim()
        ? normalizeArtifactPath(body.entryFile, -1)
        : "";
    const entryPath =
      (requestedEntry && paths.includes(requestedEntry) ? requestedEntry : "") ||
      paths.find((item) => item.toLowerCase() === "index.html") ||
      paths.find((item) => item.toLowerCase().endsWith(".html")) ||
      "";
    if (!entryPath) {
      return Response.json(
        { error: "产物中找不到 HTML 入口，无法生成沙盒插件" },
        { status: 400 },
      );
    }

    // 打包 ZIP 源制品并计算摘要
    const zipBytes = buildStoredZip(
      [...entries].map(([zipPath, bytes]) => ({ path: zipPath, bytes })),
    );
    const archiveSha256 = createHash("sha256").update(zipBytes).digest("hex");

    const packageKey = buildPackageKey(name);
    const version = "1.0.0";

    // 存入官方文件桶（沙盒静态服务运行时按 packageArtifactKey 读取并校验完整性）
    const artifactKey = packageArtifactKey({
      workspaceId,
      packageKey,
      version,
      archiveSha256,
    });
    await storePackageArtifact({
      key: artifactKey,
      bytes: zipBytes,
      sourceKind: "archive",
    });

    // 官方内部静态运行地址：/api/v2/packages/runtime/static/{ws}/{key}/{ver}/{sha}/{root}/{path?}
    const entrySuffix = entryPath === "index.html" ? "" : `/${entryPath}`;
    const runtimeEntry =
      `/api/v2/packages/runtime/static/` +
      `${encodeURIComponent(workspaceId)}/${encodeURIComponent(packageKey)}/` +
      `${version}/${archiveSha256}/_root${entrySuffix}`;

    const manifest = {
      schemaVersion: "2.0",
      id: packageKey,
      name,
      version,
      description: body.description?.trim() || `由小逻生成的插件：${name}`,
      type: "plugin",
      access: { scope: "personal" },
      runtime: {
        type: "sandbox-ui",
        entry: runtimeEntry,
      },
      permissions: [],
      contributes: {
        panels: [
          {
            id: `${packageKey}.panel`,
            title: name,
          },
        ],
      },
    };

    // 复用官方安装流程（自动审核通过：受限沙盒插件）
    const installRequest = new Request(
      new URL("/api/v2/packages", request.url),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: request.headers.get("cookie") ?? "",
          "x-workspace-id": workspaceId,
        },
        body: JSON.stringify({
          workspaceId,
          manifest,
          source: {
            kind: "archive",
            artifactKey,
            archiveSha256,
            generatedManifest: true,
            executionReady: true,
          },
        }),
      },
    );

    const result = await installPackage(installRequest, {
      allowUnsignedSourceImport: true,
      authenticatedUser: user,
    });
    const payload = (await result.json().catch(() => ({}))) as {
      error?: string;
      issues?: string[];
    };
    if (!result.ok) {
      // 安装失败时回滚文件桶制品，避免留下孤儿数据
      try {
        const { deletePackageArtifact } = await import("../../../../lib/package-import");
        await deletePackageArtifact(artifactKey);
      } catch {
        // 回滚失败不影响错误返回
      }
      return Response.json(
        {
          error: payload.error ?? "安装失败",
          ...(Array.isArray(payload.issues) && payload.issues.length
            ? { issues: payload.issues }
            : {}),
        },
        { status: result.status },
      );
    }

    return Response.json({
      packageKey,
      version,
      name,
      entryPath,
      message: "插件已成功安装到能力中心",
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error: error instanceof Error ? error.message : "从代码产物创建插件失败",
      },
      { status: 500 },
    );
  }
}
