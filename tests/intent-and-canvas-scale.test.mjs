import test from "node:test";
import assert from "node:assert/strict";
import {
  detectIntentGaps,
  normalizeIntentPlan,
} from "../app/lib/intent-analysis.ts";
import { CanvasSpatialIndex } from "../app/lib/canvas-spatial-index.ts";

test("Intent planner detects gaps and validates a real branching DAG", () => {
  const gaps = detectIntentGaps("帮我做一个宣传内容");
  assert.ok(gaps.some((gap) => gap.required));

  const plan = normalizeIntentPlan(
    {
      goal: "为年轻用户制作 30 秒竖版品牌视频",
      estimate: "4 个节点",
      tasks: [
        { id: "brief", title: "简报", capability: "标准文本生成", duration: "10s", kind: "text", dependsOn: [] },
        { id: "script", title: "脚本", capability: "标准文本生成", duration: "20s", kind: "text", dependsOn: ["brief"] },
        { id: "visual", title: "画面", capability: "标准图像生成", duration: "30s", kind: "image", dependsOn: ["brief"] },
        { id: "video", title: "视频", capability: "标准视频生成", duration: "30s", kind: "video", dependsOn: ["script", "visual"] },
      ],
    },
    "fallback",
  );
  assert.deepEqual(plan.tasks.at(-1).dependsOn, ["script", "visual"]);
  assert.throws(
    () =>
      normalizeIntentPlan(
        {
          goal: "cycle",
          estimate: "",
          tasks: [
            { id: "a", title: "A", capability: "x", duration: "1", kind: "text", dependsOn: ["b"] },
            { id: "b", title: "B", capability: "x", duration: "1", kind: "text", dependsOn: ["a"] },
          ],
        },
        "fallback",
      ),
    /循环/,
  );
});

test("spatial indexes keep a 1000-node viewport bounded", () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => ({
    id: `n${index}`,
    title: `N${index}`,
    prompt: "",
    kind: "text",
    status: "draft",
    capabilityId: "core.capability.text",
    modelId: "unconfigured",
    x: (index % 40) * 340,
    y: Math.floor(index / 40) * 260,
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `e${index}`,
    source: nodes[index].id,
    target: node.id,
    sourcePort: "text",
    targetPort: "context",
    dataType: "text",
  }));
  const index = new CanvasSpatialIndex(nodes, edges);
  assert.ok(index.queryNodeIds({ minX: 0, minY: 0, maxX: 1600, maxY: 900 }).size < 100);
  assert.ok(index.queryEdgeIds({ minX: 0, minY: 0, maxX: 1600, maxY: 900 }).size < 200);
});
