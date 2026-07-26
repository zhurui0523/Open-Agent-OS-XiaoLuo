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
