import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("execution and text result nodes use per-type adaptive sizes with internal scrolling", async () => {
  const [layout, nodeCard, canvasView, styles] = await Promise.all([
    source("app/lib/node-layout.ts"),
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(layout, /EXECUTION_NODE_SIZES/);
  assert.match(layout, /executionSizeForKind/);
  assert.match(layout, /TEXT_RESULT_NODE_WIDTH = 360/);
  assert.match(layout, /TEXT_RESULT_NODE_HEIGHT = 400/);
  assert.match(layout, /AUTO_LAYOUT_COLUMN_GAP = 64/);
  assert.match(layout, /AUTO_LAYOUT_ROW_GAP = 64/);
  assert.match(layout, /function autoLayoutHeightForNode/);
  assert.match(layout, /arrangeNodesWithoutOverlap/);
  assert.match(layout, /rowY \+=\s*autoLayoutHeightForNode\(node, measuredHeights\) \+/s);
  assert.match(layout, /columnX \+= widthForNode\(node\) \+ AUTO_LAYOUT_COLUMN_GAP/);
  assert.match(layout, /if \(role === "execution"\) return executionSizeForKind\(node\.kind\)\.width/);
  assert.match(nodeCard, /isExecutionNode/);
  assert.match(nodeCard, /executionSizeForKind\(node\.kind\)/);
  assert.match(nodeCard, /executionSize\.width/);
  assert.match(nodeCard, /executionSize\.height/);
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \{[\s\S]{0,180}width:\s*360px;[\s\S]{0,80}height:\s*300px;/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \.node-workbench-content[\s\S]{0,180}overflow-x:\s*hidden;[\s\S]{0,80}overflow-y:\s*auto/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-result\.node-kind-text:not\(\.is-empty-result-placeholder\) \{[\s\S]{0,180}width:\s*360px;[\s\S]{0,80}height:\s*400px;/,
  );
  assert.match(canvasView, /center\.y - spawnSize\.height \/ 2/);
});

test("canvas nodes use the professional typography scale", async () => {
  const styles = await source("app/globals.css");

  assert.match(styles, /--node-font-micro:\s*10px;/);
  assert.match(styles, /--node-font-label:\s*12px;/);
  assert.match(styles, /--node-font-section:\s*13px;/);
  assert.match(styles, /--node-font-body:\s*14px;/);
  assert.match(styles, /--node-font-title:\s*16px;/);
  assert.match(styles, /--node-line-body:\s*22px;/);
  assert.match(styles, /--node-line-title:\s*24px;/);
  assert.match(styles, /--node-text-primary:\s*#1d2129;/);
  assert.match(styles, /--node-text-body:\s*#272e3b;/);
  assert.match(styles, /--node-text-secondary:\s*#4e5969;/);
  assert.match(styles, /--node-text-tertiary:\s*#86909c;/);
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \.node-prompt-input \{[\s\S]{0,160}font-size:\s*var\(--node-font-body\);[\s\S]{0,80}line-height:\s*var\(--node-line-body\);/,
  );
  assert.match(
    styles,
    /\.node-workbench > header span \{[\s\S]{0,180}font-size:\s*var\(--node-font-section\);[\s\S]{0,80}font-weight:\s*600;/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-result\.node-kind-text:not\(\.is-empty-result-placeholder\)[\s\S]{0,120}\.preview-text[\s\S]{0,220}> p \{[\s\S]{0,180}font-size:\s*var\(--node-font-body\);[\s\S]{0,120}line-height:\s*var\(--node-line-body\);/,
  );
  assert.match(styles, /\.canvas-node h3 \{[\s\S]{0,140}font-size:\s*var\(--node-font-title\);/);
  assert.match(styles, /\.node-kind,[\s\S]{0,120}\.node-status \{[\s\S]{0,120}font-size:\s*var\(--node-font-label\);/);
});

test("canvas nodes do not expose the removed collapse and expand control", async () => {
  const [nodeCard, canvasView, styles] = await Promise.all([
    source("app/components/node-card.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/globals.css"),
  ]);

  assert.doesNotMatch(nodeCard, /Minimize2/);
  assert.doesNotMatch(nodeCard, /collapsed:\s*!node\.collapsed/);
  assert.doesNotMatch(nodeCard, /is-collapsed/);
  assert.doesNotMatch(canvasView, /已折叠/);
  assert.doesNotMatch(styles, /\.canvas-node\.is-collapsed/);
  assert.doesNotMatch(styles, /\.collapsed-node-title/);
});

test("execution node options wrap without horizontal scrolling", async () => {
  const styles = await source("app/globals.css");

  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \.node-workbench-content \{[\s\S]{0,180}overflow-x:\s*hidden;[\s\S]{0,80}overflow-y:\s*auto;/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution\.is-user-sized \.node-workbench-content \{[\s\S]{0,100}overflow-x:\s*hidden;[\s\S]{0,80}overflow-y:\s*auto;/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \.node-option-strip \{[\s\S]{0,180}display:\s*flex;[\s\S]{0,180}flex-wrap:\s*wrap;/,
  );
  assert.match(
    styles,
    /\.canvas-node\.node-role-execution \.node-config-section \.node-fields,[\s\S]{0,180}display:\s*contents;/,
  );
  assert.doesNotMatch(
    styles,
    /\.canvas-node\.node-role-execution \.node-option-strip \{[\s\S]{0,320}overflow-x:\s*auto;/,
  );
});

test("default node guidance clears on the first prompt interaction", async () => {
  const nodeCard = await source("app/components/node-card.tsx");

  assert.match(nodeCard, /const defaultNodePrompts = new Set/);
  assert.match(nodeCard, /选择已安装的 Skill 与模型，并描述这个节点需要完成的任务。/);
  assert.match(nodeCard, /在这里描述这个节点需要完成的任务。/);
  assert.doesNotMatch(nodeCard, /className="node-prompt"/);
  assert.match(
    nodeCard,
    /className="node-prompt-input node-prompt-rich-input"[\s\S]{0,320}onFocus=[\s\S]{0,180}isDefaultNodePrompt\(value\)[\s\S]{0,100}onChange\(""\)/,
  );
});

test("execution nodes always render the full editor and action bar", async () => {
  const nodeCard = await source("app/components/node-card.tsx");

  assert.doesNotMatch(nodeCard, /!selected && role !== "result"/);
  assert.match(
    nodeCard,
    /\{\(role === "execution" \|\|[\s\S]{0,120}selected && role === "result" && node\.kind !== "text"/,
  );
  assert.match(
    nodeCard,
    /\{role === "execution" && \([\s\S]{0,120}<div className="node-actions">/,
  );
});
