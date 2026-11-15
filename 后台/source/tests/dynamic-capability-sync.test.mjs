import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("filters user models by the selected Skill contract", async () => {
  const { modelMatchesCapability, preferredModel, snapshotCapability } =
    await import("../app/lib/capability-sync.ts");
  const capability = {
    id: "capability_brand_image",
    capabilityKey: "user.skill.brand.main",
    title: "品牌主视觉",
    description: "",
    modality: "image",
    category: "SKILL",
    enabled: true,
    packageVersion: "1.0.0",
    parameterHint: "",
    packageId: "package_brand",
    executionMode: "model",
    ports: [
      {
        id: "reference",
        label: "参考图",
        direction: "input",
        dataTypes: ["image"],
      },
      {
        id: "image",
        label: "图片",
        direction: "output",
        dataTypes: ["image"],
      },
    ],
    modelRequirements: {
      required: true,
      protocols: ["openai-compatible"],
      capabilityTags: ["image-edit"],
    },
  };
  const models = [
    {
      id: "wrong",
      name: "普通图像模型",
      provider: "gemini",
      protocol: "gemini",
      modalities: ["image"],
      capabilityTags: [],
      state: "healthy",
      latency: "10 ms",
      priority: 1,
      maxConcurrency: 1,
      retryLimit: 1,
      circuitFailureThreshold: 2,
      circuitCooldownSeconds: 10,
      circuitState: "closed",
      activeRequests: 0,
    },
    {
      id: "right",
      name: "图像编辑模型",
      provider: "openai-compatible",
      protocol: "openai-compatible",
      modelName: "image-edit-v1",
      modalities: ["image"],
      capabilityTags: ["image-edit"],
      state: "healthy",
      latency: "20 ms",
      priority: 10,
      maxConcurrency: 1,
      retryLimit: 1,
      circuitFailureThreshold: 2,
      circuitCooldownSeconds: 10,
      circuitState: "closed",
      activeRequests: 0,
    },
  ];

  assert.equal(modelMatchesCapability(models[0], capability, "image"), false);
  assert.equal(modelMatchesCapability(models[1], capability, "image"), true);
  assert.equal(preferredModel(models, capability, "image")?.id, "right");
  assert.deepEqual(snapshotCapability(capability).ports, capability.ports);
});

test("uses Skill snapshot ports instead of hardcoded modality ports", async () => {
  const { portsForNode, validateEdgePorts } =
    await import("../app/lib/node-ports.ts");
  const sourceNode = {
    kind: "text",
    parameters: {
      capabilitySnapshot: {
        id: "source",
        title: "JSON Skill",
        packageVersion: "1.0.0",
        ports: [
          {
            id: "json_out",
            label: "结构化结果",
            direction: "output",
            dataTypes: ["json"],
          },
        ],
      },
    },
  };
  const targetNode = {
    kind: "image",
    parameters: {
      capabilitySnapshot: {
        id: "target",
        title: "JSON Image Skill",
        packageVersion: "1.0.0",
        ports: [
          {
            id: "json_in",
            label: "结构化提示",
            direction: "input",
            dataTypes: ["json"],
          },
          {
            id: "image",
            label: "图片",
            direction: "output",
            dataTypes: ["image"],
          },
        ],
      },
    },
  };
  assert.equal(portsForNode(sourceNode, "output")[0].id, "json_out");
  assert.equal(
    validateEdgePorts(
      {
        id: "edge",
        source: "source",
        target: "target",
        sourcePort: "json_out",
        targetPort: "json_in",
        dataType: "json",
      },
      sourceNode,
      targetNode,
    ),
    null,
  );
});

test("persists custom Skill and model schemas across registry and runtime", async () => {
  const [schema, packages, registry, models, nodeCard, runtime, executors] =
    await Promise.all([
      source("db/schema.ts"),
      source("app/api/v2/packages/route.ts"),
      source("app/api/v2/registry/route.ts"),
      source("app/api/v2/models/route.ts"),
      source("app/components/node-card.tsx"),
      source("app/lib/runtime-capability.ts"),
      source("app/lib/kernel-executors.ts"),
    ]);
  assert.match(schema, /portsJson/);
  assert.match(schema, /parameterSchemaJson/);
  assert.match(packages, /modelRequirementsJson/);
  assert.match(packages, /capabilityIds\.get\(item\.id\)/);
  assert.match(packages, /workspaceDeclarativeSkill/);
  assert.match(registry, /modelProviderTemplates/);
  assert.match(models, /capabilityTagsJson/);
  assert.match(nodeCard, /modelMatchesCapability/);
  assert.match(nodeCard, /title="模型参数"/);
  assert.match(runtime, /validateRuntimeModel/);
  assert.match(executors, /modelExecutionParameters/);
  assert.match(executors, /\.\.\.modelParameters/);
});

test("runs the selected model directly when Skill is set to none", async () => {
  const {
    hasSelectedSkillCapability,
    validateRuntimeModel,
  } = await import("../app/lib/runtime-capability.ts");
  const runRoute = await source("app/api/v2/kernel/runs/route.ts");

  assert.equal(hasSelectedSkillCapability("none"), false);
  assert.equal(hasSelectedSkillCapability("  none  "), false);
  assert.equal(hasSelectedSkillCapability(""), false);
  assert.equal(hasSelectedSkillCapability("core.execution"), false);
  assert.equal(hasSelectedSkillCapability("capability_installed"), true);
  assert.equal(hasSelectedSkillCapability("missing:skill"), true);

  assert.doesNotThrow(() =>
    validateRuntimeModel(
      undefined,
      {
        enabled: true,
        modalitiesJson: JSON.stringify(["image"]),
      },
      "image",
    ),
  );
  assert.match(runRoute, /\.filter\(hasSelectedSkillCapability\)/);
  assert.match(
    runRoute,
    /if \(hasSelectedSkillCapability\(capabilityId\) && capabilityId\)/,
  );
});
