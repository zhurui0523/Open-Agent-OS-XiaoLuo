import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("node runs include connected result slots and clear stale output", async () => {
  const controller = await source("app/hooks/use-intent-os.ts");

  assert.match(controller, /roleForNode\(target\) === "result"/);
  assert.match(controller, /delete parameters\.kernelOutput/);
  assert.match(controller, /delete nextParameters\.kernelOutput/);
  assert.match(controller, /missingResultOutput/);
  assert.match(
    controller,
    /上游节点已完成，但没有返回可写入占位卡片的结果/,
  );
});

test("result slots reject empty upstream output and preserve usable output", async () => {
  const [executors, nodeCard, styles, nodeLayout] = await Promise.all([
    source("app/lib/kernel-executors.ts"),
    source("app/components/node-card.tsx"),
    source("app/globals.css"),
    source("app/lib/node-layout.ts"),
  ]);
  const workbenchSource = nodeCard.slice(
    nodeCard.indexOf("function NodeWorkbench"),
    nodeCard.indexOf("export function NodeCard"),
  );

  assert.match(executors, /inputs\.find\(\(input\) => hasResultValue/);
  assert.match(executors, /结果占位卡片没有连接上游节点/);
  assert.match(
    executors,
    /上游节点已完成，但没有返回可写入占位卡片的结果/,
  );
  assert.match(executors, /selectedSourceNodeId: selectedInput\.nodeId/);
  assert.match(
    nodeCard,
    /role === "result" &&[\s\S]{0,160}kernelOutput &&[\s\S]{0,160}<NodeWorkbench/,
  );
  assert.match(nodeCard, /node\.result &&[\s\S]{0,80}!kernelOutput/);
  assert.match(nodeCard, /isGeneratingResultPlaceholder/);
  assert.match(nodeCard, /正在生成中…/);
  assert.match(nodeCard, /role="status"/);
  assert.match(nodeCard, /node-kind-\$\{node\.kind\}/);
  assert.match(nodeCard, /isSizedTextResult/);
  assert.match(nodeCard, /TEXT_RESULT_NODE_WIDTH/);
  assert.match(nodeCard, /TEXT_RESULT_NODE_HEIGHT/);
  assert.doesNotMatch(nodeCard, /usesFlatHeader/);
  assert.doesNotMatch(nodeCard, /node-header-identity/);
  assert.match(nodeCard, /result-placeholder-header/);
  assert.match(nodeCard, /result-placeholder-title/);
  assert.match(nodeCard, /node-corner-status/);
  assert.match(
    nodeCard,
    /onPointerDown=\{\(event\) => \{\s*handlePointerDown\(event\);\s*\}\}/,
  );
  assert.doesNotMatch(nodeCard, /result-placeholder-empty/);
  assert.doesNotMatch(workbenchSource, /专业工作台/);
  assert.doesNotMatch(workbenchSource, /node\.kind\.toUpperCase/);
  assert.doesNotMatch(workbenchSource, /<Type/);
  assert.doesNotMatch(workbenchSource, /media-preview-badge/);
  assert.match(styles, /@keyframes result-placeholder-spin/);
  assert.match(
    styles,
    /\.canvas-node\.is-empty-result-placeholder \{[\s\S]{0,220}border:\s*1px solid #dbe3ee;[\s\S]{0,100}border-radius:\s*22px;[\s\S]{0,100}background:\s*#f8fafc;/,
  );
  assert.match(styles, /\.result-placeholder-header \{[\s\S]{0,260}border-bottom:\s*1px solid #e8edf3;/);
  assert.match(
    styles,
    /node-role-result\.node-kind-text:not\(\.is-empty-result-placeholder\)[\s\S]{0,180}width: 360px;[\s\S]{0,80}height: 400px/,
  );
  assert.match(styles, /\.preview-text[\s\S]{0,220}overflow: auto/);
  assert.match(styles, /> :is\(\.schema-output, \.node-result\)[\s\S]{0,180}overflow: auto/);
  assert.doesNotMatch(styles, /\.node-drag-handle\.node-flat-header/);
  assert.match(styles, /\.canvas-node\.node-role-result \{[\s\S]{0,180}border:\s*0;[\s\S]{0,120}background:\s*transparent;[\s\S]{0,100}box-shadow:\s*none;/);
  assert.match(styles, /\.canvas-node\.node-role-result \.node-workbench[\s\S]{0,180}border:\s*0;[\s\S]{0,120}background:\s*transparent/);
  assert.match(styles, /\.canvas-node\.node-role-result \.workbench-preview[\s\S]{0,120}border:\s*0;[\s\S]{0,100}background:\s*transparent/);
  assert.match(
    styles,
    /:is\(\.preview-image > img, \.preview-video > video\)[\s\S]{0,220}border:\s*0;[\s\S]{0,100}border-radius:\s*0;/,
  );
  assert.match(nodeLayout, /TEXT_RESULT_NODE_WIDTH = 360/);
  assert.match(nodeLayout, /TEXT_RESULT_NODE_HEIGHT = 400/);
  assert.match(nodeLayout, /if \(textResultHasOutput\(node\)\) return TEXT_RESULT_NODE_WIDTH/);
});

test("failed runs settle downstream placeholders instead of leaving them spinning", async () => {
  const [controller, worker] = await Promise.all([
    source("app/hooks/use-intent-os.ts"),
    source("app/lib/kernel-worker.ts"),
  ]);

  assert.match(controller, /blockedByFailedRun/);
  assert.match(controller, /\["queued", "waiting", "running"\]\.includes\(task\.status\)/);
  assert.match(controller, /reconciledKernelRuns/);
  assert.match(controller, /recoverableRunIds/);
  assert.match(controller, /void readRunState\(runId\)\.catch/);
  assert.match(worker, /status: "skipped"/);
  assert.match(worker, /eq\(kernelTasks\.status, "queued"\)/);
  assert.match(worker, /因上游节点失败未执行/);
});

test("selected text results can be edited, copied, and downloaded", async () => {
  const [nodeCard, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(
    nodeCard,
    /hasTextResultActions =\s*selected && role === "result" && node\.kind === "text"/,
  );
  assert.match(nodeCard, /aria-label="编辑文本结果"/);
  assert.match(
    nodeCard,
    /onFocus=\{\(\) => \{[\s\S]{0,100}if \(!selected\) onSelect\(false\)/,
  );
  assert.match(nodeCard, /onChange=\{\(event\) => updateTextResult\(event\.target\.value\)\}/);
  assert.match(nodeCard, /aria-label=\{copyState === "copied" \? "文本已复制" : "复制文本内容"\}/);
  assert.match(nodeCard, /navigator\.clipboard\.writeText\(content\)/);
  assert.match(nodeCard, /document\.execCommand\("copy"\)/);
  assert.match(nodeCard, /new Blob\(\[content\], \{ type: "text\/plain;charset=utf-8" \}\)/);
  assert.match(nodeCard, /anchor\.download = textDownloadName\(node\.title\)/);
  assert.match(nodeCard, /"下载文本内容"/);
  assert.match(nodeCard, /<nav[\s\S]{0,100}className="result-action-nav"/);
  assert.match(nodeCard, /aria-label="文本结果功能导航"/);
  assert.match(styles, /\.result-action-nav \{/);
  assert.match(
    styles,
    /\.result-action-nav \{[\s\S]{0,180}top: -50px;[\s\S]{0,120}left: 50%/,
  );
  assert.match(styles, /transform: translateX\(-50%\)/);
  assert.match(styles, /\.text-result-editor \{/);
  assert.match(styles, /\.text-result-editor:focus \{/);
  assert.match(styles, /\.text-result-editor \{[\s\S]{0,260}padding:\s*0 0 34px;/);
  assert.match(
    styles,
    /node-role-result\.node-kind-text:not\(\.is-empty-result-placeholder\)\.is-selected[\s\S]{0,180}box-shadow:\s*none/,
  );
  assert.match(
    styles,
    /\.text-result-editor \{[\s\S]{0,220}overflow-x: hidden;[\s\S]{0,100}border: 0;[\s\S]{0,80}border-radius: 0;/,
  );
  assert.match(
    styles,
    /\.text-result-editor:focus \{[\s\S]{0,100}box-shadow: none;/,
  );
});

test("media clicks do not immediately capture the pointer or move nodes", async () => {
  const nodeCard = await source("app/components/node-card.tsx");
  const pointerDown = nodeCard.slice(
    nodeCard.indexOf("function handlePointerDown"),
    nodeCard.indexOf("function handlePointerMove"),
  );
  const pointerMove = nodeCard.slice(
    nodeCard.indexOf("function handlePointerMove"),
    nodeCard.indexOf("function endDrag"),
  );

  assert.match(nodeCard, /const NODE_DRAG_THRESHOLD_PX = 8/);
  assert.match(pointerDown, /captured:\s*false/);
  assert.doesNotMatch(pointerDown, /setPointerCapture/);
  assert.doesNotMatch(pointerDown, /preventDefault/);
  assert.match(
    pointerMove,
    /if \(distance < NODE_DRAG_THRESHOLD_PX\) return;/,
  );
  assert.match(pointerMove, /setPointerCapture\(event\.pointerId\)/);
  assert.match(pointerMove, /onMoveStart\(\)/);
  assert.match(nodeCard, /alt=\{`\$\{node\.title\} 生成结果`\}[\s\S]{0,80}draggable=\{false\}/);
});

test("successful text image and video results omit the completed badge", async () => {
  const nodeCard = await source("app/components/node-card.tsx");

  assert.match(
    nodeCard,
    /const hideSucceededResultStatus =[\s\S]{0,180}role === "result"[\s\S]{0,100}node\.status === "succeeded"[\s\S]{0,160}node\.kind === "text"[\s\S]{0,80}node\.kind === "image"[\s\S]{0,80}node\.kind === "video"/,
  );
  assert.match(
    nodeCard,
    /node\.status !== "draft" && !hideSucceededResultStatus/,
  );
  assert.match(
    nodeCard,
    /hideSucceededResultStatus\s*\? node\.title\s*:\s*`\$\{node\.title\}，\$\{status\.label\}`/,
  );
});

test("text results and media failure messages use a white card surface", async () => {
  const [nodeCard, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(
    nodeCard,
    /const hasResultTextSurface =[\s\S]{0,220}node\.kind === "text"[\s\S]{0,180}node\.kind === "image" \|\| node\.kind === "video"[\s\S]{0,140}!hasMediaAssetOutput/,
  );
  assert.match(nodeCard, /hasResultTextSurface \? "has-result-text-surface"/);
  assert.match(
    styles,
    /\.canvas-node\.node-role-result\.has-result-text-surface \{[\s\S]{0,320}border: 1px solid #dbe3ec;[\s\S]{0,180}background: rgba\(255, 255, 255, 0\.98\)/,
  );
  assert.match(
    styles,
    /has-result-text-surface > \.node-result \{[\s\S]{0,220}overflow-wrap: anywhere/,
  );
});
