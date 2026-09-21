import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  mediaPluginSupports,
  normalizeMediaPluginTypes,
} from "../app/lib/media-plugin.ts";
import { parsePackagePayload } from "../app/lib/package-contract.ts";

const root = new URL("../", import.meta.url);

function pluginManifest(assetTypes) {
  return {
    schemaVersion: "2.0",
    id: "com.example.media-tool",
    name: "Media tool",
    version: "1.0.0",
    type: "plugin",
    assetTypes,
    runtime: {
      type: "sandbox-ui",
      entry: "https://plugin.example.com/panel",
    },
    contributes: {
      panels: [
        {
          id: "com.example.media-tool.panel",
          title: "Media tool",
        },
      ],
    },
  };
}

test("plugin manifest accepts image, video and audio applicability", () => {
  const parsed = parsePackagePayload(
    pluginManifest(["image", "video", "audio", "audio"]),
  );
  assert.deepEqual(parsed.assetTypes, ["image", "video", "audio"]);
  assert.throws(
    () => parsePackagePayload(pluginManifest(["document"])),
    /assetTypes/,
  );
});

test("media plugins only match their declared asset types", () => {
  const item = { manifest: { assetTypes: ["image", "audio", "invalid"] } };
  assert.deepEqual(normalizeMediaPluginTypes(item.manifest.assetTypes), [
    "image",
    "audio",
  ]);
  assert.equal(mediaPluginSupports(item, "image"), true);
  assert.equal(mediaPluginSupports(item, "audio"), true);
  assert.equal(mediaPluginSupports(item, "video"), false);
});

test("all image, video and audio material/result navigation uses the plugin menu", async () => {
  const [nodeCard, canvasView, runtimeDialog, referenceBridge, capabilityView, menu] =
    await Promise.all([
      readFile(new URL("app/components/node-card.tsx", root), "utf8"),
      readFile(new URL("app/components/canvas-view.tsx", root), "utf8"),
      readFile(
        new URL("app/components/plugin-runtime-dialog.tsx", root),
        "utf8",
      ),
      readFile(new URL("app/lib/plugin-reference-bridge.ts", root), "utf8"),
      readFile(
        new URL("app/components/capabilities-view.tsx", root),
        "utf8",
      ),
      readFile(new URL("app/components/asset-plugin-menu.tsx", root), "utf8"),
    ]);

  assert.equal((nodeCard.match(/<AssetPluginMenu/g) ?? []).length, 3);
  assert.match(canvasView, /mediaPluginSupports\(item, node\.kind\)/);
  assert.match(canvasView, /assetContexts: pluginAssetContextForNode\(node\)/);
  assert.match(
    runtimeDialog,
    /syncPluginReferenceFrame\([\s\S]*assetContextsRef\.current,[\s\S]*textContextsRef\.current/,
  );
  assert.match(nodeCard, /syncPluginReferenceFrame\(/);
  assert.match(referenceBridge, /pluginHostReadyPayload\(assets, texts\)/);
  assert.match(referenceBridge, /xiaoluoReferenceKey/);
  assert.match(referenceBridge, /frameRealm\.Event\("change"/);
  assert.match(capabilityView, /<span>适用类型<\/span>/);
  assert.match(capabilityView, /\["audio", "音频"\]/);
  assert.match(menu, /createPortal\(/);
  assert.match(menu, /onPointerMove=\{stopCanvasPointer\}/);
});

test("plugin runtime receives connected text and media references while preserving legacy asset context", async () => {
  const {
    pluginAssetContextsFromReferences,
    pluginHostReadyPayload,
    pluginTextContextsFromNodes,
  } = await import("../app/lib/plugin-reference-context.ts");
  const contexts = pluginAssetContextsFromReferences("canvas-1", [
    {
      sourceNodeId: "image-1",
      assetId: "asset-image",
      title: "Reference image",
      kind: "image",
      url: "/api/v2/files/asset-image/content",
      mimeType: "image/png",
      status: "succeeded",
    },
    {
      sourceNodeId: "video-1",
      assetId: "asset-video",
      title: "Reference video",
      kind: "video",
      url: "/api/v2/files/asset-video/content",
      mimeType: "video/mp4",
      status: "succeeded",
    },
    {
      sourceNodeId: "image-1",
      assetId: "asset-image",
      title: "Duplicate image edge",
      kind: "image",
      url: "/api/v2/files/asset-image/content",
      status: "succeeded",
    },
  ]);
  const textContexts = pluginTextContextsFromNodes("canvas-1", [
    {
      id: "text-1",
      kind: "text",
      title: "Prompt",
      prompt: "Build a panorama from this portrait",
      status: "succeeded",
    },
  ]);
  const payload = pluginHostReadyPayload(contexts, textContexts);

  assert.equal(contexts.length, 2);
  assert.equal(payload.asset, contexts[0]);
  assert.equal(payload.assets, contexts);
  assert.equal(payload.text, textContexts[0]);
  assert.equal(payload.texts, textContexts);
  assert.deepEqual(payload.references, [...textContexts, ...contexts]);
  assert.deepEqual(payload.capabilities, [
    "asset-context",
    "asset-context-list",
    "text-context",
    "text-context-list",
  ]);
  assert.deepEqual(
    payload.assets.map((asset) => asset.kind),
    ["image", "video"],
  );
});
