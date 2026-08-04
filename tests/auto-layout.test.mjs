import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("automatic canvas layout uses measured node sizes and non-overlapping gaps", async () => {
  const [layout, controller, canvasView] = await Promise.all([
    source("app/lib/node-layout.ts"),
    source("app/hooks/use-intent-os.ts"),
    source("app/components/canvas-view.tsx"),
  ]);

  assert.match(layout, /AUTO_LAYOUT_COLUMN_GAP = 64/);
  assert.match(layout, /AUTO_LAYOUT_ROW_GAP = 64/);
  assert.match(layout, /function autoLayoutHeightForNode/);
  assert.match(layout, /measuredHeights\[node\.id\]/);
  assert.match(layout, /columnX \+= widthForNode\(node\) \+ AUTO_LAYOUT_COLUMN_GAP/);
  assert.match(
    layout,
    /rowY \+=\s*autoLayoutHeightForNode\(node, measuredHeights\) \+\s*AUTO_LAYOUT_ROW_GAP/s,
  );
  assert.match(layout, /rowY \+= rowHeight \+ AUTO_LAYOUT_ROW_GAP/);
  assert.match(controller, /arrangeNodesWithoutOverlap\(current, mode, measuredHeights\)/);
  assert.match(canvasView, /os\.arrangeNodes\(mode, nodeHeights\)/);
  assert.doesNotMatch(controller, /\* 324/);
  assert.doesNotMatch(controller, /\* 250/);
});
