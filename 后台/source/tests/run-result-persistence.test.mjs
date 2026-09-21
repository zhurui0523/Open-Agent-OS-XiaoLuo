import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("completed generation results are persisted without browser autosave", async () => {
  const [sync, worker, controller] = await Promise.all([
    source("app/lib/kernel-run-canvas-sync.ts"),
    source("app/lib/kernel-worker.ts"),
    source("app/hooks/use-intent-os.ts"),
  ]);

  assert.match(sync, /materializeKernelRunResultGraph/);
  assert.match(sync, /roleForNode\(node\) !== "result"/);
  assert.match(sync, /ON DUPLICATE KEY UPDATE/);
  assert.match(sync, /run\.canvas_results_persisted/);
  assert.match(sync, /revision = \?/);
  assert.match(worker, /persistKernelRunResultGraph/);
  assert.match(worker, /CANVAS_RESULT_PERSIST_RETRY_DELAYS/);
  assert.match(worker, /run\.canvas_results_persist_retry/);
  assert.match(worker, /persistCompletedRunCanvasResults\(run\)/);
  assert.match(worker, /run\.status === "succeeded" && run\.canvasId/);
  assert.match(worker, /materializeKernelRunResultGraph\(\{/);
  assert.match(worker, /canvasResultGraph/);
  assert.match(controller, /revisions\.current\.set\(activeCanvasId, result\.canvasRevision\)/);
  assert.match(controller, /snapshotEpoch !== saveEpoch\.current/);
  assert.match(controller, /persistedResultNodes/);
  assert.match(controller, /without requiring a manual canvas refresh/);
  assert.match(controller, /persistedResultEdges/);
  assert.match(controller, /CANVAS_DRAFT_PREFIX/);
  assert.match(controller, /window\.addEventListener\("pagehide"/);
  assert.match(controller, /keepalive: true/);
  assert.match(controller, /readCanvasDraft\(canvas\.id\)/);
});
