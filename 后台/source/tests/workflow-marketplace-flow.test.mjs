import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("defines material, plugin, Skill execution, and result node contracts", async () => {
  const {
    portsForNode,
    validateEdgePorts,
    validatePortCardinality,
  } =
    await import("../app/lib/node-ports.ts");
  const { compileWorkflow } = await import("../app/lib/workflow-kernel.ts");

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

  assert.deepEqual(portsForNode(material, "input"), [
    {
      id: "material_input",
      label: "素材输入",
      direction: "input",
      dataTypes: ["image", "video", "audio", "document", "asset"],
      cardinality: "many",
    },
  ]);
  assert.equal(portsForNode(material, "output")[0].id, "material");
  assert.equal(portsForNode(plugin, "input")[0].cardinality, "many");
  assert.equal(portsForNode(plugin, "output")[0].cardinality, "many");
  assert.deepEqual(portsForNode(result, "output"), [
    {
      id: "result_output",
      label: "结果输出",
      direction: "output",
      dataTypes: ["image"],
      cardinality: "many",
    },
  ]);
  assert.equal(
    portsForNode(
      {
        ...result,
        status: "succeeded",
        result: "generated image",
        parameters: {
          ...result.parameters,
          kernelOutput: { type: "image", assetUrl: "/generated.png" },
        },
      },
      "output",
    )[0].id,
    "result_output",
  );
  assert.equal(
    validateEdgePorts(
      {
        id: "result_to_plugin",
        source: "result",
        target: "plugin",
        sourcePort: "result_output",
        targetPort: "materials",
        dataType: "image",
      },
      result,
      plugin,
    ),
    null,
  );
  assert.deepEqual(
    compileWorkflow(
      [{ id: "execute" }, { id: "result" }, { id: "plugin" }],
      [
        { id: "execute_to_result", source: "execute", target: "result" },
        { id: "result_to_plugin", source: "result", target: "plugin" },
      ],
    ).levels,
    [["execute"], ["result"], ["plugin"]],
  );
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
  const [
    marketplace,
    installer,
    canvas,
    capabilities,
    worker,
    migration,
    collaborationMigration,
  ] =
    await Promise.all([
      source("app/api/v2/workflows/marketplace/route.ts"),
      source("app/api/v2/workflows/install/route.ts"),
      source("app/components/canvas-view.tsx"),
      source("app/components/capabilities-view.tsx"),
      source("app/lib/kernel-worker.ts"),
      source("drizzle/0012_workflow_marketplace_node_roles.sql"),
      source("drizzle/0014_canvas_enterprise_live_shares.sql"),
    ]);

  assert.match(marketplace, /sanitizeWorkflowGraph/);
  assert.match(marketplace, /workflow\.version\.published/);
  assert.match(marketplace, /organizationScopes/);
  assert.match(marketplace, /organization_live/);
  assert.match(marketplace, /canvasEnterpriseShares/);
  assert.match(installer, /workflowIntegrity/);
  assert.match(installer, /workflow\.installed/);
  assert.match(installer, /organizationWorkspaceIds/);
  assert.match(canvas, /发布到能力商城/);
  assert.match(canvas, /所有用户（独立副本）/);
  assert.match(canvas, /所在企业用户（实时协作）/);
  assert.match(canvas, /双方后续修改互不影响/);
  assert.match(capabilities, /安装到当前项目/);
  assert.match(worker, /executeIsolatedPackage/);
  assert.match(worker, /batch-each/);
  assert.match(migration, /xiaoluo_v2_workflow_versions/);
  assert.match(migration, /node_role/);
  assert.match(
    collaborationMigration,
    /xiaoluo_v2_canvas_enterprise_shares/,
  );
});

test("only system administrators can delete shared Workflow canvases", async () => {
  const [marketplace, capabilities, styles] = await Promise.all([
    source("app/api/v2/workflows/marketplace/route.ts"),
    source("app/components/capabilities-view.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(marketplace, /export async function DELETE\(request: Request\)/);
  assert.match(marketplace, /user\.platformRole !== "system_admin"/);
  assert.match(marketplace, /仅系统管理员可以删除共享画布/);
  assert.match(marketplace, /\.delete\(workflowInstallations\)/);
  assert.match(marketplace, /\.delete\(workflowVersions\)/);
  assert.match(marketplace, /\.delete\(workflowListings\)/);
  assert.match(marketplace, /eventType: "workflow\.deleted"/);
  assert.match(marketplace, /retainedInstalledCanvases: true/);
  assert.match(capabilities, /async function deleteWorkflow/);
  assert.match(capabilities, /确认删除共享画布/);
  assert.match(capabilities, /tone: "danger"/);
  assert.match(capabilities, /\{isSystemAdmin && \(/);
  assert.match(capabilities, /className="workflow-admin-delete"/);
  assert.match(capabilities, /aria-label=\{`删除画布 \$\{item\.title\}`\}/);
  assert.match(capabilities, /<span>删除画布<\/span>/);
  assert.doesNotMatch(capabilities, /Workflow 分享链接已复制/);
  assert.doesNotMatch(capabilities, /current\.searchParams\.set\("workflow", item\.id\)/);
  assert.match(styles, /\.workflow-admin-delete \{/);
});
