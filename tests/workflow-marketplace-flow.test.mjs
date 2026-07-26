import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("defines material, plugin, Skill execution, and result node contracts", async () => {
  const { portsForNode, validatePortCardinality } =
    await import("../app/lib/node-ports.ts");

  const material = {
    id: "material",
    kind: "image",
    role: "material",
    parameters: { nodeRole: "material" },
  };
  const plugin = {
    id: "plugin",
    kind: "image",
    role: "plugin",
    parameters: { nodeRole: "plugin" },
  };
  const result = {
    id: "result",
    kind: "image",
    role: "result",
    parameters: { nodeRole: "result", resultSlot: true },
  };

  assert.deepEqual(portsForNode(material, "input"), []);
  assert.equal(portsForNode(material, "output")[0].id, "material");
  assert.equal(portsForNode(plugin, "input")[0].cardinality, "many");
  assert.equal(portsForNode(plugin, "output")[0].cardinality, "many");
  assert.equal(portsForNode(result, "output").length, 0);
  assert.equal(
    validatePortCardinality(
      { target: "result", targetPort: "result" },
      [{ target: "result", targetPort: "result" }],
      result,
    ),
    "结果最多允许 1 条输入连接",
  );
});

test("publishes a privacy-safe, installable Workflow snapshot", async () => {
  const { sanitizeWorkflowGraph } =
    await import("../app/lib/workflow-marketplace.ts");
  const graph = {
    title: "批量主视觉",
    nodes: [
      {
        id: "material",
        title: "客户私有图片",
        prompt: "敏感素材说明",
        kind: "image",
        role: "material",
        status: "succeeded",
        capabilityId: "core.material.source",
        modelId: "none",
        x: 0,
        y: 0,
        parameters: {
          nodeRole: "material",
          assetId: "asset_private",
          assetContentUrl: "https://private.example/file.png",
          apiKey: "never-share",
        },
      },
      {
        id: "plugin",
        title: "抠图插件",
        prompt: "批量抠图",
        kind: "image",
        role: "plugin",
        status: "draft",
        capabilityId: "core.plugin.runner",
        modelId: "plugin-runtime",
        x: 300,
        y: 0,
        parameters: {
          nodeRole: "plugin",
          packageId: "pkg_private_id",
          packageKey: "com.example.cutout",
          packageVersion: "1.2.0",
          runtimeType: "isolated-worker",
          token: "never-share",
        },
      },
      {
        id: "execute",
        title: "品牌主视觉",
        prompt: "生成主视觉",
        kind: "image",
        role: "execution",
        status: "draft",
        capabilityId: "cap_private_id",
        modelId: "model_private_id",
        x: 600,
        y: 0,
        parameters: {
          nodeRole: "execution",
          password: "never-share",
          capabilitySnapshot: {
            id: "cap_private_id",
            capabilityKey: "com.example.brand.image",
            title: "品牌主视觉",
            packageId: "pkg_skill_private",
            packageVersion: "2.0.0",
            executionMode: "model",
            modelRequirements: {
              protocols: ["openai-compatible"],
              capabilityTags: ["image-edit"],
            },
            ports: [],
          },
        },
      },
      {
        id: "result",
        title: "主视觉结果",
        prompt: "旧结果",
        kind: "image",
        role: "result",
        status: "succeeded",
        capabilityId: "core.result.placeholder",
        modelId: "none",
        x: 900,
        y: 0,
        result: "private result",
        parameters: {
          nodeRole: "result",
          resultSlot: true,
          resultOf: "execute",
          kernelOutput: { assetUrl: "https://private.example/result.png" },
        },
      },
    ],
    edges: [
      {
        id: "m-p",
        source: "material",
        target: "plugin",
        sourcePort: "material",
        targetPort: "materials",
        dataType: "image",
      },
      {
        id: "p-e",
        source: "plugin",
        target: "execute",
        sourcePort: "plugin_output",
        targetPort: "reference",
        dataType: "image",
      },
      {
        id: "e-r",
        source: "execute",
        target: "result",
        sourcePort: "image",
        targetPort: "result",
        dataType: "image",
      },
    ],
  };

  const published = sanitizeWorkflowGraph(graph);
  assert.deepEqual(published.counts, {
    nodeCount: 4,
    materialCount: 1,
    pluginCount: 1,
    executionCount: 1,
    resultCount: 1,
  });
  assert.deepEqual(published.requirements.skills, [
    { key: "com.example.brand.image", version: "2.0.0" },
  ]);
  assert.deepEqual(published.requirements.plugins, [
    { key: "com.example.cutout", version: "1.2.0" },
  ]);
  assert.equal(published.graph.nodes[0].parameters.placeholder, true);
  assert.equal(published.graph.nodes[0].parameters.assetId, undefined);
  assert.equal(published.graph.nodes[1].parameters.token, undefined);
  assert.equal(published.graph.nodes[2].parameters.password, undefined);
  assert.equal(published.graph.nodes[2].modelId, "unconfigured");
  assert.equal(published.graph.nodes[3].result, undefined);
  assert.equal(published.graph.nodes[3].parameters.kernelOutput, undefined);
});

test("connects Workflow marketplace UI and isolated plugin execution", async () => {
  const [marketplace, installer, canvas, capabilities, worker, migration] =
    await Promise.all([
      source("app/api/v2/workflows/marketplace/route.ts"),
      source("app/api/v2/workflows/install/route.ts"),
      source("app/components/canvas-view.tsx"),
      source("app/components/capabilities-view.tsx"),
      source("app/lib/kernel-worker.ts"),
      source("drizzle/0012_workflow_marketplace_node_roles.sql"),
    ]);

  assert.match(marketplace, /sanitizeWorkflowGraph/);
  assert.match(marketplace, /workflow\.version\.published/);
  assert.match(installer, /workflowIntegrity/);
  assert.match(installer, /workflow\.installed/);
  assert.match(canvas, /发布到能力商城/);
  assert.match(capabilities, /安装到当前项目/);
  assert.match(worker, /executeIsolatedPackage/);
  assert.match(worker, /batch-each/);
  assert.match(migration, /xiaoluo_v2_workflow_versions/);
  assert.match(migration, /node_role/);
});
