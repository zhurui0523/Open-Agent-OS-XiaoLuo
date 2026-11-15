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
  // 占位卡片标题栏不再显示“图片占位卡片”等文字，只留删除按钮（2026-11-03 用户裁决）
  assert.doesNotMatch(nodeCard, /result-placeholder-title/);
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
  assert.match(
    styles,
    /not\(\.is-user-sized\):is\([\s\S]{0,100}\.node-kind-image,[\s\S]{0,100}\.node-kind-video[\s\S]{0,160}height:\s*156px;[\s\S]{0,80}min-height:\s*156px;/,
  );
  assert.match(
    styles,
    /> \.node-workbench-content[\s\S]{0,700}> \.node-workbench[\s\S]{0,700}\.workbench-preview[\s\S]{0,180}height:\s*100%;/,
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
    /hasTextResultActions =\s*selected &&[\s\S]{0,80}role === "result" && node\.kind === "text"/,
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

test("node dragging previews with compositor transforms and commits once", async () => {
  const [nodeCard, canvasView, edgeLayer, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/components/canvas-edge-layer.tsx"),
    source("app/globals.css"),
  ]);
  const finishDrag = nodeCard.slice(
    nodeCard.indexOf("const finishNodeDrag"),
    nodeCard.indexOf("const copyFeedbackTimer"),
  );
  const pointerMove = nodeCard.slice(
    nodeCard.indexOf("function handlePointerMove"),
    nodeCard.indexOf("function endDrag"),
  );

  assert.match(pointerMove, /requestAnimationFrame/);
  assert.match(pointerMove, /card\.style\.transform = `translate3d\(/);
  assert.match(pointerMove, /onMovePreview\(next\.x, next\.y\)/);
  assert.doesNotMatch(pointerMove, /onMove\(/);
  assert.match(finishDrag, /onMove\(finalMove\.x, finalMove\.y\)/);
  assert.match(canvasView, /const previewNodeMove = useCallback/);
  assert.match(canvasView, /onMovePreview=\{\(x, y\) => previewNodeMove\(node\.id, x, y\)\}/);
  assert.match(edgeLayer, /export function canvasEdgeGeometry/);
  assert.match(styles, /\.canvas-node\.is-dragging[\s\S]{0,120}will-change:\s*transform/);
});

test("successful text image video and audio results omit the completed badge", async () => {
  const nodeCard = await source("app/components/node-card.tsx");

  assert.match(
    nodeCard,
    /const hideSucceededResultStatus =[\s\S]{0,180}role === "result"[\s\S]{0,100}node\.status === "succeeded"[\s\S]{0,240}node\.kind === "text"[\s\S]{0,80}node\.kind === "image"[\s\S]{0,80}node\.kind === "video"[\s\S]{0,80}node\.kind === "audio"/,
  );
  assert.match(
    nodeCard,
    /node\.status !== "draft" &&\s*!hideSucceededResultStatus/,
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

test("结果去向：覆盖原图复用已有结果卡片，另存新图保持新建占位", async () => {
  const [controller, nodeCard] = await Promise.all([
    source("app/hooks/use-intent-os.ts"),
    source("app/components/node-card.tsx"),
  ]);

  // 开关在运行策略区，默认另存新图，所以已有节点不需要迁移
  assert.match(nodeCard, /<span>结果去向<\/span>/);
  assert.match(
    nodeCard,
    /value=\{String\(node\.parameters\?\.resultMode \?\? "new"\)\}/,
  );
  assert.match(nodeCard, /\{ value: "new", label: "另存" \}/);
  assert.match(nodeCard, /\{ value: "overwrite", label: "覆盖" \}/);

  // 覆盖原图：下游已有结果卡片留在运行图里，并且被当作待复用占位
  assert.match(
    controller,
    /node\.parameters\?\.resultMode !== "overwrite"[\s\S]{0,1200}overwriteResultIds\.add/,
  );
  // 一个节点挂了多张结果卡片时只替换最新的一张，其余历史结果保留
  assert.match(controller, /cards\.some\(\(card\) => !hasGeneratedOutput\(card\)\)\) return;/);
  assert.match(controller, /latest\.createdAt \?\? 0/);
  assert.match(
    controller,
    /!isGeneratedResultNode\(node\) \|\|\s*overwriteResultIds\.has\(node\.id\)/,
  );
  assert.match(
    controller,
    /return !hasGeneratedOutput \|\| overwriteResultIds\.has\(node\.id\);/,
  );
  // 不标记复用，服务端才会为这张卡片重跑一次 result-slot
  assert.match(
    controller,
    /if \(overwriteResultIds\.has\(node\.id\)\) return node;/,
  );

  // 新结果回来之前旧图不能被清空，否则一次失败运行就毁掉上一版
  assert.match(
    controller,
    /const keepsPreviousResult = overwriteResultIds\.has\(node\.id\);/,
  );
  assert.match(
    controller,
    /result: keepsPreviousResult \? node\.result : undefined,/,
  );
  assert.match(
    controller,
    /const overwritesExisting =\s*upstreamNode\.parameters\?\.resultMode === "overwrite" &&\s*taskMap\.has\(node\.id\) &&\s*taskMap\.has\(upstreamNode\.id\);/,
  );
});
