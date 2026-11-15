import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

function section(contents, start, end) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return contents.slice(startIndex, endIndex);
}

test("every canvas node or asset deletion requires explicit confirmation", async () => {
  const [intentOs, canvasView] = await Promise.all([
    source("app/hooks/use-intent-os.ts"),
    source("app/components/canvas-view.tsx"),
  ]);

  const selectedDeletion = section(
    intentOs,
    "async function deleteSelected()",
    "async function deleteNode(id: string)",
  );
  const singleDeletion = section(
    intentOs,
    "async function deleteNode(id: string)",
    "function connectNodes(",
  );

  for (const deletion of [selectedDeletion, singleDeletion]) {
    assert.match(deletion, /await dialog\.confirm\(/);
    assert.match(deletion, /title:\s*"确认删除"/);
    assert.match(deletion, /cancelText:\s*"取消"/);
    assert.match(deletion, /confirmText:\s*"确认删除"/);
    assert.doesNotMatch(deletion, /downstream\.size\s*&&/);
  }

  assert.match(
    canvasView,
    /event\.key === "Delete"[\s\S]{0,260}void deleteSelected\(\)/,
  );
  assert.match(canvasView, /onDelete=\{\(\) => void os\.deleteNode\(node\.id\)\}/);
  assert.match(
    canvasView,
    /if \(contextMenu\.nodeId\) \{[\s\S]{0,100}await os\.deleteNode\(contextMenu\.nodeId\)/,
  );
});
