import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("canvas plugins keep independent inline and expanded runtime instances", async () => {
  const [nodeCard, canvasView, runtimeDialog, runtimeStatic, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/components/plugin-runtime-dialog.tsx"),
    source("app/lib/plugin-runtime-static.ts"),
    source("app/globals.css"),
  ]);

  assert.match(nodeCard, /className="plugin-canvas-toolbar"/);
  assert.match(nodeCard, /className="plugin-launcher-surface"/);
  assert.match(nodeCard, /aria-label="插件显示方式"/);
  assert.match(nodeCard, /"window"/);
  assert.match(nodeCard, /"fullscreen"/);
  assert.match(nodeCard, /aria-current="page"/);
  assert.match(
    nodeCard,
    /"allow-scripts allow-same-origin allow-forms allow-downloads"/,
  );
  assert.match(nodeCard, /created\.tabIndex = 0/);
  assert.doesNotMatch(nodeCard, /<iframe/);
  assert.match(nodeCard, /xiaoluo:runtime-grant-expired/);
  assert.match(nodeCard, /setPluginLaunchRevision/);
  assert.doesNotMatch(nodeCard, /parkedPluginFrame/);
  assert.match(
    styles,
    /\.plugin-launcher-preview iframe[\s\S]{0,180}pointer-events:\s*auto/,
  );
  assert.match(
    styles,
    /\.plugin-launcher-preview iframe[\s\S]{0,140}width:\s*100%[\s\S]{0,80}height:\s*100%/,
  );
  assert.doesNotMatch(nodeCard, /--plugin-preview-scale|width:\s*920px|height:\s*612px/);
  assert.match(canvasView, /mode:\s*PluginRuntimeMode/);
  assert.match(canvasView, /initialMode=\{pluginRuntime\.mode\}/);
  assert.doesNotMatch(canvasView, /adoptedFrame|parkedPluginFrame/);
  assert.match(
    runtimeDialog,
    /allow-scripts allow-same-origin allow-forms allow-downloads/,
  );
  assert.match(runtimeDialog, /initialMode\?: PluginRuntimeMode/);
  assert.match(runtimeDialog, /useState<PluginRuntimeMode>\(initialMode\)/);
  assert.match(runtimeDialog, /xiaoluo:runtime-grant-expired/);
  assert.doesNotMatch(runtimeDialog, /appendChild\(adoptedFrame\)/);
  assert.match(runtimeStatic, /xiaoluo:runtime-grant-expired/);
  assert.match(runtimeStatic, /status: 401/);
});
