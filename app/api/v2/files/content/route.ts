import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { assets, assetVersions } from "../../../../../db/schema";
import { getFileBucket } from "../../../../lib/asset-kernel";

function errorResponse(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function requestedRange(header: string | null, size: number) {
  const match = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1, end };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const assetId = url.searchParams.get("assetId")?.trim();
    const versionNumber = Number(url.searchParams.get("version") ?? 0);
    if (!assetId) return errorResponse("文件 ID 必填", 400);
    const db = await getDb();
    const [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    if (!asset) return errorResponse("文件不存在", 404);
    const [version] = await db
      .select()
      .from(assetVersions)
      .where(
        versionNumber > 0
          ? and(
              eq(assetVersions.assetId, asset.id),
              eq(assetVersions.version, versionNumber),
            )
          : eq(assetVersions.id, asset.currentVersionId ?? ""),
      )
      .limit(1);
    if (!version) return errorResponse("文件版本不存在", 404);

    const rangeHeader = request.headers.get("range");
    const range = requestedRange(rangeHeader, version.size);
    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes */${version.size}`,
        },
      });
    }
    const bucket = await getFileBucket();
    const object = await bucket.get(
      version.blobKey,
      range
        ? { range: { offset: range.offset, length: range.length } }
        : undefined,
    );
    if (!object?.body) return errorResponse("文件内容不存在", 404);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-type": version.mimeType,
      etag: object.httpEtag ?? object.etag,
      "x-asset-uri": `${asset.uri}@${version.version}`,
      "x-content-sha256": version.contentHash,
    });
    if (url.searchParams.get("download") === "1") {
      headers.set(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      );
    }
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.offset}-${range.end}/${version.size}`,
      );
      headers.set("content-length", String(range.length));
    } else {
      headers.set("content-length", String(version.size));
    }
    return new Response(object.body, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "读取文件失败",
      500,
    );
  }
}
