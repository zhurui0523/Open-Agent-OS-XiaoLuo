import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("normalizes the common upload formats through one shared registry", async () => {
  const {
    SUPPORTED_FILE_ACCEPT,
    SUPPORTED_FILE_GROUPS,
    canonicalUploadMimeType,
    supportedFormatForName,
  } = await import("../app/lib/file-formats.ts");

  for (const name of [
    "notes.md",
    "brief.yaml",
    "photo.avif",
    "clip.mp4",
    "movie.mkv",
    "voice.m4a",
    "report.pdf",
    "script.docx",
    "budget.xlsx",
    "deck.pptx",
    "bundle.zip",
  ]) {
    assert.ok(supportedFormatForName(name), `${name} should be supported`);
  }

  assert.equal(
    canonicalUploadMimeType("data.csv", "application/vnd.ms-excel")?.mimeType,
    "text/plain;charset=utf-8",
  );
  assert.equal(
    canonicalUploadMimeType("page.html", "text/html")?.mimeType,
    "text/plain;charset=utf-8",
  );
  assert.match(SUPPORTED_FILE_ACCEPT, /\.mp4/);
  assert.match(SUPPORTED_FILE_ACCEPT, /\.docx/);
  assert.equal(SUPPORTED_FILE_GROUPS.length, 6);
});

test("connects upload, safe reading, asset storage, and canvas rendering", async () => {
  const [
    assetKernel,
    contentRoute,
    assetPreview,
    assetsView,
    canvasView,
    nodeCard,
  ] = await Promise.all([
    source("app/lib/asset-kernel.ts"),
    source("app/api/v2/files/content/route.ts"),
    source("app/components/asset-content-preview.tsx"),
    source("app/components/assets-view.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/components/node-card.tsx"),
  ]);

  assert.match(assetKernel, /canonicalUploadMimeType/);
  assert.match(assetKernel, /contentHash/);
  assert.match(assetKernel, /bucket\.put/);
  assert.match(contentRoute, /x-content-type-options/);
  assert.match(assetPreview, /readTextPreview/);
  assert.match(assetPreview, /readOfficePreview/);
  assert.match(assetPreview, /DecompressionStream\("deflate-raw"\)/);
  assert.match(assetsView, /SUPPORTED_FILE_GROUPS/);
  assert.match(canvasView, /multiple/);
  assert.match(canvasView, /assetDownloadUrl/);
  assert.match(nodeCard, /AssetContentPreview/);
});

test("streams file uploads outside the framework multipart action parser", async () => {
  const { assetUploadRequestInit } =
    await import("../app/lib/asset-upload.ts");
  const request = assetUploadRequestInit(
    new File([new Uint8Array([1, 2, 3])], "参考图.png", {
      type: "image/png",
    }),
    { sourceType: "canvas-upload", tags: ["参考图"] },
  );
  const [uploadProtocol, filesRoute, assetKernel, intentOs, schemaField] =
    await Promise.all([
    source("app/lib/asset-upload.ts"),
    source("app/api/v2/files/route.ts"),
    source("app/lib/asset-kernel.ts"),
    source("app/hooks/use-intent-os.ts"),
    source("app/components/schema-field.tsx"),
  ]);

  assert.equal(request.method, "POST");
  assert.equal(request.body.size, 3);
  assert.equal(request.headers["content-type"], "image/png");
  assert.equal(
    decodeURIComponent(request.headers["x-xiaoluo-file-name"]),
    "参考图.png",
  );
  assert.match(uploadProtocol, /ASSET_UPLOAD_FILE_NAME_HEADER/);
  assert.match(uploadProtocol, /body: file/);
  assert.match(filesRoute, /await request\.arrayBuffer\(\)/);
  assert.match(filesRoute, /ASSET_UPLOAD_FILE_NAME_HEADER/);
  assert.match(assetKernel, /MAX_FILE_BYTES = 100 \* 1024 \* 1024/);
  assert.match(intentOs, /assetUploadRequestInit\(file, metadata\)/);
  assert.match(schemaField, /assetUploadRequestInit\(file/);
  assert.match(intentOs, /response\.status === 413/);
  assert.match(intentOs, /单个文件最大支持 100 MB/);
});
