import { performance } from "node:perf_hooks";
import { CanvasSpatialIndex } from "../app/lib/canvas-spatial-index.ts";

function fixture(count) {
  const columns = Math.ceil(Math.sqrt(count));
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node_${index}`,
    title: `Node ${index}`,
    prompt: "",
    kind: ["text", "image", "video"][index % 3],
    status: "draft",
    capabilityId: "core.capability.text",
    modelId: "unconfigured",
    x: (index % columns) * 340,
    y: Math.floor(index / columns) * 260,
  }));
  const edges = nodes.slice(1).flatMap((node, index) => {
    const result = [{
      id: `edge_${index}`,
      source: nodes[index].id,
      target: node.id,
      sourcePort: "output",
      targetPort: "context",
      dataType: "text",
    }];
    if (index > columns) {
      result.push({
        ...result[0],
        id: `branch_${index}`,
        source: nodes[index - columns].id,
      });
    }
    return result;
  });
  return { nodes, edges };
}

for (const count of [500, 1000]) {
  const { nodes, edges } = fixture(count);
  const started = performance.now();
  const index = new CanvasSpatialIndex(nodes, edges);
  const buildMs = performance.now() - started;
  const samples = [];
  let maximumNodes = 0;
  for (let sample = 0; sample < 250; sample += 1) {
    const x = (sample % 25) * 250;
    const y = Math.floor(sample / 25) * 250;
    const queryStarted = performance.now();
    maximumNodes = Math.max(
      maximumNodes,
      index.queryNodeIds({ minX: x, minY: y, maxX: x + 1600, maxY: y + 900 }).size,
    );
    index.queryEdgeIds({ minX: x, minY: y, maxX: x + 1600, maxY: y + 900 });
    samples.push(performance.now() - queryStarted);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const report = { count, edges: edges.length, buildMs, queryP95Ms: p95, maximumNodes };
  console.log(JSON.stringify(report));
  if (buildMs > 250 || p95 > 12 || maximumNodes > 180) {
    throw new Error(`Canvas benchmark regression: ${JSON.stringify(report)}`);
  }
}
