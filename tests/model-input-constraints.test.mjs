import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultModelInputConstraints,
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../app/lib/model-input-constraints.ts";
import { resolveProfessionalGeneratorRules } from "../app/lib/professional-generator-rules.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("model input defaults distinguish multimodal video protocols", () => {
  assert.deepEqual(
    defaultModelInputConstraints(
      "video",
      "runninghub-sparkvideo-multimodal",
    ),
    {
      maxTotal: 12,
      maxByType: { image: 9, video: 3, audio: 3, document: 0 },
    },
  );
  assert.equal(defaultModelInputConstraints("image").maxByType.image, 14);
  assert.equal(
    defaultModelInputConstraints("image", "dall-e-3").maxTotal,
    0,
  );
});

test("custom model limits support large and asymmetric reference sets", () => {
  const constraints = normalizeModelInputConstraints(
    {
      maxTotal: 50,
      maxByType: { image: 14, video: 20, audio: 16, document: 0 },
    },
    "video",
  );

  assert.equal(constraints.maxTotal, 50);
  assert.deepEqual(constraints.maxByType, {
    image: 14,
    video: 20,
    audio: 16,
    document: 0,
  });
});

test("professional text, image and video generation follows execution-node selection rules", () => {
  const capabilities = [
    {
      id: "core.capability.video",
      title: "系统视频",
      modality: "video",
      category: "系统",
      enabled: true,
      packageVersion: "2.0.0",
    },
    {
      id: "skill.video.package",
      title: "视频 Skill",
      modality: "video",
      category: "SKILL",
      enabled: true,
      packageId: "pkg.video",
      packageVersion: "1.0.0",
      executionMode: "model",
      modelRequirements: { protocols: ["runninghub-sparkvideo-multimodal"] },
    },
  ];
  const model = (id, protocol, priority = 10, createdAt) => ({
    id,
    name: id,
    provider: "test",
    modalities: ["video"],
    state: "healthy",
    latency: "1 ms",
    protocol,
    priority,
    createdAt,
    maxConcurrency: 1,
    retryLimit: 1,
    circuitFailureThreshold: 3,
    circuitCooldownSeconds: 60,
    circuitState: "closed",
    activeRequests: 0,
    enabled: true,
  });
  const compatible = model("compatible", "runninghub-sparkvideo-multimodal");
  const incompatible = model("incompatible", "openai-compatible", 1);

  const automatic = resolveProfessionalGeneratorRules({
    capabilities,
    models: [incompatible, compatible],
    kind: "video",
  });
  assert.equal(automatic.capability?.id, "skill.video.package");
  assert.equal(automatic.model?.id, "compatible");
  assert.deepEqual(
    automatic.compatibleCapabilities.map((item) => item.id),
    ["skill.video.package"],
  );

  const withoutSkill = resolveProfessionalGeneratorRules({
    capabilities,
    models: [incompatible, compatible],
    kind: "video",
    requestedCapabilityId: "none",
    requestedModelId: "incompatible",
  });
  assert.equal(withoutSkill.capability, null);
  assert.equal(withoutSkill.model?.id, "incompatible");

  const installedFirst = resolveProfessionalGeneratorRules({
    capabilities,
    models: [
      model(
        "installed-later",
        "runninghub-sparkvideo-multimodal",
        1,
        "2026-08-04T10:00:00.000Z",
      ),
      model(
        "installed-first",
        "runninghub-sparkvideo-multimodal",
        100,
        "2026-08-03T10:00:00.000Z",
      ),
    ],
    kind: "video",
    requestedCapabilityId: "none",
  });
  assert.equal(installedFirst.capability, null);
  assert.equal(installedFirst.model?.id, "installed-first");
  assert.deepEqual(
    installedFirst.compatibleModels.map((item) => item.id),
    ["installed-first", "installed-later"],
  );
});

test("validation applies both total and per-type model limits", () => {
  const constraints = {
    maxTotal: 12,
    maxByType: { image: 9, video: 3, audio: 3, document: 0 },
  };
  const valid = validateModelInputAssets(constraints, [
    ...Array.from({ length: 8 }, () => ({ kind: "image" })),
    ...Array.from({ length: 2 }, () => ({ kind: "video" })),
    ...Array.from({ length: 2 }, () => ({ kind: "audio" })),
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.total, 12);

  const invalid = validateModelInputAssets(constraints, [
    ...Array.from({ length: 10 }, () => ({ kind: "image" })),
    ...Array.from({ length: 3 }, () => ({ kind: "video" })),
  ]);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 2);
});

test("execution nodes keep a platform reference port when a Skill supplies custom ports", async () => {
  const { portsForNode } = await import("../app/lib/node-ports.ts");
  const ports = portsForNode({
    kind: "text",
    parameters: {
      capabilitySnapshot: {
        ports: [
          {
            id: "skill_output",
            label: "Skill 输出",
            direction: "output",
            dataTypes: ["text"],
          },
        ],
      },
    },
  });
  const reference = ports.find((port) => port.id === "reference");
  assert.deepEqual(reference?.dataTypes, [
    "image",
    "video",
    "audio",
    "document",
  ]);
});

test("connected input assets render as thumbnail-only tiles", async () => {
  const [nodeCard, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/globals.css"),
  ]);

  assert.doesNotMatch(nodeCard, /node-input-asset-counters/);
  assert.doesNotMatch(nodeCard, /<small>\{meta\.label\}<\/small>/);
  assert.doesNotMatch(nodeCard, /<strong>\{asset\.title\}<\/strong>/);
  assert.match(nodeCard, /asset\.kind === "video" && asset\.url/);
  assert.match(nodeCard, /aria-label=\{asset\.title\}/);
  assert.match(styles, /\.node-input-asset-card\s*\{[^}]*width: 54px;[^}]*height: 54px;/s);
  assert.match(styles, /\.node-input-asset-preview img,\s*\.node-input-asset-preview video/);
});

test("execution nodes can mention, upload and auto-connect canvas assets", async () => {
  const [nodeCard, canvasView, intentOS, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/hooks/use-intent-os.ts"),
    source("app/globals.css"),
  ]);

  assert.match(nodeCard, /function NodePromptEditor/);
  assert.match(nodeCard, /activeAssetMention/);
  assert.match(nodeCard, /function segmentPrompt/);
  assert.match(nodeCard, /contentEditable/);
  assert.match(nodeCard, /dataset\.assetMentionToken = segment\.token/);
  assert.match(nodeCard, /mention\.className = "node-prompt-mention"/);
  assert.match(nodeCard, /appendPromptAssetPreview\(mention, segment\.asset\)/);
  assert.match(nodeCard, /aria-label="引用画布素材"/);
  assert.match(nodeCard, /attachedSourceIds\.has\(asset\.sourceNodeId\)/);
  assert.match(nodeCard, /matchingAttachedAssets/);
  assert.match(nodeCard, /matchingCanvasAssets/);
  assert.match(nodeCard, /aria-label="已连接素材"/);
  assert.match(nodeCard, /aria-label="画布素材"/);
  assert.match(nodeCard, /matchingAttachedAssets\.length \+ index/);
  assert.match(nodeCard, /!attachedSourceIds\.has\(asset\.sourceNodeId\)/);
  assert.doesNotMatch(nodeCard, /<small>已关联<\/small>/);
  assert.match(nodeCard, /onAttach\(asset\.sourceNodeId\)/);
  assert.match(nodeCard, /<NodeInputAssets[\s\S]*?<NodePromptEditor/);
  assert.match(nodeCard, /aria-label=\{canUpload \? "上传并连接素材"/);
  assert.match(nodeCard, /accept=\{SUPPORTED_FILE_ACCEPT\}/);
  assert.match(canvasView, /function canvasAssetReference/);
  assert.match(canvasView, /connectToNodeId: node\.id/);
  assert.match(canvasView, /direction: "left"/);
  assert.match(intentOS, /connection\?: \{ targetId: string; targetPortId\?: string \}/);
  assert.match(intentOS, /source: id,\s*target: targetNode\.id/s);
  assert.match(styles, /\.node-asset-mention-menu/);
  assert.match(styles, /width: min\(270px, calc\(100% - 16px\)\)/);
  assert.match(styles, /\.node-asset-mention-menu\s*\{[^}]*overflow-y: auto;/s);
  assert.match(styles, /\.node-asset-mention-group/);
  assert.match(styles, /\.node-asset-mention-group\s*\{[^}]*max-height: none;[^}]*overflow: visible;/s);
  assert.doesNotMatch(
    styles,
    /\.node-asset-mention-group \+ \.node-asset-mention-group\s*\{[^}]*border-top:/s,
  );
  assert.match(styles, /\.node-asset-mention-group > strong\s*\{[^}]*position: sticky;/s);
  assert.match(styles, /\.node-input-assets \+ \.node-prompt-editor\s*\{[^}]*margin-top: 12px;/s);
  assert.match(styles, /\.node-prompt-mention/);
  assert.match(styles, /\.node-prompt-mention \.node-input-asset-preview\s*\{[^}]*width: 24px;[^}]*height: 24px;/s);
  assert.match(styles, /\.node-input-asset-upload/);
});

test("intent composer shares thumbnail attachments and canvas asset mentions", async () => {
  const [intentConsole, canvasView, intentOS, styles] = await Promise.all([
    source("app/components/intent-console.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/hooks/use-intent-os.ts"),
    source("app/globals.css"),
  ]);

  assert.match(intentConsole, /InputAssetPreview, NodePromptEditor/);
  assert.match(intentConsole, /canvasAssets: CanvasAssetReference\[\]/);
  assert.match(intentConsole, /<NodePromptEditor/);
  assert.match(intentConsole, /attachedSourceIds=\{[\s\S]{0,120}composerMode === "quick" \? new Set<string>\(\) : attachedSourceIds[\s\S]{0,20}\}/);
  assert.match(intentConsole, /onAttach=\{attachCanvasAsset\}/);
  assert.match(intentConsole, /resolveProfessionalGeneratorRules/);
  assert.match(intentConsole, /normalizeModelInputConstraints/);
  assert.match(intentConsole, /validateModelInputAssets/);
  assert.match(intentConsole, /professionalRules\?\.compatibleCapabilities/);
  assert.match(intentConsole, /professionalRules\?\.compatibleModels/);
  assert.match(intentConsole, /attachmentValidation\.valid/);
  assert.match(intentConsole, /className="composer-input-asset-grid"/);
  assert.match(intentConsole, /className="composer-input-asset-add"/);
  assert.match(canvasView, /canvasAssets=\{canvasAssets\}/);
  assert.match(intentOS, /previewUrl: asset\.contentUrl/);
  assert.match(intentOS, /attachments,/);
  assert.match(intentOS, /target: next\.id/);
  assert.match(styles, /\.composer-input-asset-grid/);
  assert.match(
    styles,
    /\.composer-input-asset-grid\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fill, 48px\);/s,
  );
  assert.match(styles, /\.intent-composer-editor \.node-asset-mention-menu/);
  assert.match(
    styles,
    /\.is-canvas-view \.intent-console \.intent-composer-editor \.node-asset-mention-menu\s*\{[^}]*top: auto;[^}]*bottom: calc\(100% \+ 10px\);/s,
  );
});

test("task descriptions open a large draft editor on double click", async () => {
  const [nodeCard, canvasView, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(nodeCard, /function PromptEditorDialog/);
  assert.match(nodeCard, /function renderPromptEditorContent/);
  assert.match(nodeCard, /editor\.replaceChildren\(fragment\)/);
  assert.match(
    nodeCard,
    /promptValueFromDom\(editor\) !== value[\s\S]*?renderPromptEditorContent\(editor, value, assets\)/,
  );
  assert.match(nodeCard, /onDoubleClick=\{\(event\) =>/);
  assert.match(nodeCard, /ariaLabel="放大编辑节点内容"/);
  assert.match(nodeCard, /<NodePromptEditor[\s\S]*?autoFocus/);
  assert.match(nodeCard, /assets=\{canvasAssets\}/);
  assert.match(nodeCard, /createPortal/);
  assert.match(nodeCard, /canvasStage\.setAttribute\("inert", ""\)/);
  assert.match(nodeCard, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(nodeCard, /onWheel=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(
    canvasView,
    /document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)/,
  );
  assert.match(nodeCard, /onSave=\{\(prompt\) => \{/);
  assert.match(styles, /\.prompt-editor-backdrop/);
  assert.match(styles, /\.prompt-editor-dialog/);
  assert.match(styles, /\.prompt-editor-dialog > \.node-prompt-editor > \.node-prompt-input/);
  assert.match(styles, /width: min\(900px, calc\(100vw - 64px\)\)/);
});

test("settings, canvas and runtime share the same input constraint contract", async () => {
  const [settings, nodeCard, canvasView, nodePorts, worker, executors, styles] =
    await Promise.all([
      source("app/components/settings-center.tsx"),
      source("app/components/node-card.tsx"),
      source("app/components/canvas-view.tsx"),
      source("app/lib/node-ports.ts"),
      source("app/lib/kernel-worker.ts"),
      source("app/lib/kernel-executors.ts"),
      source("app/globals.css"),
    ]);

  assert.match(settings, /function ModelInputConstraintEditor/);
  assert.match(settings, /maxTotal/);
  assert.match(settings, /MODEL_INPUT_ASSET_KINDS\.map/);
  assert.match(nodeCard, /function NodeInputAssets/);
  assert.match(nodeCard, /inputAssetValidation\.valid/);
  assert.match(canvasView, /inputAssetsByNode/);
  assert.match(canvasView, /onRemoveInputAsset=\{\(edgeId\) => os\.deleteEdge\(edgeId\)\}/);
  assert.match(nodePorts, /const REFERENCE_ASSET_TYPES/);
  assert.match(nodePorts, /"image",\s+"video",\s+"audio",\s+"document"/);
  assert.equal(
    nodePorts.match(/dataTypes: \[\.\.\.REFERENCE_ASSET_TYPES\]/g)?.length,
    5,
  );
  assert.match(nodePorts, /function withReferenceAssetPort/);
  assert.match(worker, /validateModelInputAssets/);
  assert.match(executors, /MODEL_INPUT_CONSTRAINT/);
  assert.match(executors, /function openAIChatContent/);
  assert.match(executors, /type: "image_url"/);
  assert.match(executors, /function geminiInputParts/);
  assert.match(executors, /fileData/);
  assert.match(executors, /MODEL_INPUT_FORMAT_UNSUPPORTED/);
  assert.doesNotMatch(executors, /urlsFor\("image", 9\)/);
  assert.match(styles, /\.node-input-asset-grid/);
  assert.match(styles, /\.model-input-constraints-grid/);
});

test("remote model inputs never submit authenticated in-app asset URLs", async () => {
  const [executors, assets, router] = await Promise.all([
    source("app/lib/kernel-executors.ts"),
    source("app/lib/asset-kernel.ts"),
    source("app/lib/model-runtime-router.ts"),
  ]);

  assert.match(executors, /async function providerReadyInputs/);
  assert.match(executors, /externalAssetAccessUrl/);
  assert.match(executors, /MODEL_INPUT_NOT_PUBLIC/);
  assert.match(executors, /const providerInputs = await providerReadyInputs/);
  assert.match(executors, /assertRunningHubBusinessSuccess\(payload\)/);
  assert.match(executors, /RUNNINGHUB_\$\{errorCode\}/);
  assert.match(assets, /export async function externalAssetAccessUrl/);
  assert.match(assets, /OSSAccessKeyId/);
  assert.match(assets, /Signature/);
  assert.match(router, /executeModel\(model, node, inputs, signal, \{/);
  assert.match(router, /workspaceId: context\.workspaceId/);
});
