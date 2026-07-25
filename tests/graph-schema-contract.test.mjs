import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("validates typed graph ports and rejects connections that form cycles", async () => {
  const [{ validateEdgePorts }, { wouldCreateCycle }] = await Promise.all([
    import("../app/lib/node-ports.ts"),
    import("../app/lib/workflow-kernel.ts"),
  ]);
  const text = { id: "text", kind: "text" };
  const image = { id: "image", kind: "image" };
  const video = { id: "video", kind: "video" };
  const edges = [
    {
      id: "text-image",
      source: "text",
      target: "image",
      sourcePort: "text",
      targetPort: "prompt",
      dataType: "text",
    },
    {
      id: "image-video",
      source: "image",
      target: "video",
      sourcePort: "image",
      targetPort: "reference",
      dataType: "image",
    },
  ];

  assert.equal(validateEdgePorts(edges[0], text, image), null);
  assert.equal(validateEdgePorts(edges[1], image, video), null);
  assert.match(
    validateEdgePorts(
      { ...edges[1], targetPort: "prompt" },
      image,
      video,
    ),
    /不能接收 image/,
  );
  assert.equal(wouldCreateCycle([text, image, video], edges, "text", "video"), false);
  assert.equal(wouldCreateCycle([text, image, video], edges, "video", "text"), true);
});

test("validates nested Schema-driven input on client and server boundaries", async () => {
  const { validateJsonSchema } = await import("../app/lib/json-schema.ts");
  const schema = {
    type: "object",
    required: ["prompt", "shots"],
    properties: {
      prompt: { type: "string", minLength: 3 },
      shots: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: {
          type: "object",
          required: ["duration"],
          properties: {
            duration: { type: "number", minimum: 1, maximum: 30 },
          },
        },
      },
    },
  };

  assert.deepEqual(
    validateJsonSchema(schema, {
      prompt: "生成一段视频",
      shots: [{ duration: 6 }],
    }),
    [],
  );
  const issues = validateJsonSchema(schema, {
    prompt: "短",
    shots: [{ duration: 0 }, { duration: 0 }],
  });
  assert.ok(issues.some((issue) => issue.path === "$.prompt"));
  assert.ok(issues.some((issue) => issue.path === "$.shots"));
  assert.ok(issues.some((issue) => issue.path === "$.shots[0].duration"));

  const [renderer, outputRenderer, registry, invokeRoute] = await Promise.all([
    source("app/components/schema-field.tsx"),
    source("app/components/schema-output.tsx"),
    source("app/lib/registry-serialization.ts"),
    source("app/api/v2/runtime/invoke/route.ts"),
  ]);
  assert.match(renderer, /schema\.type === "object"/);
  assert.match(renderer, /schema\.type === "array"/);
  assert.match(renderer, /\/api\/v2\/files/);
  assert.match(outputRenderer, /schema\.format === "video"/);
  assert.match(outputRenderer, /schema\.format === "audio"/);
  assert.match(outputRenderer, /download/);
  assert.match(outputRenderer, /schema\.type === "array"/);
  assert.match(registry, /outputSchemaJson/);
  assert.match(invokeRoute, /capability\.inputSchema/);
  assert.match(invokeRoute, /capability\.outputSchema/);
});

test("ships scalable canvas, asset management, sharing, and async task controls", async () => {
  const [
    canvas,
    drawer,
    controller,
    edges,
    assets,
    fileBulk,
    tasks,
    share,
    migration,
    limiter,
    kernelRuns,
    artifactFormat,
  ] =
    await Promise.all([
      source("app/components/canvas-view.tsx"),
      source("app/components/canvas-drawer.tsx"),
      source("app/hooks/use-intent-os.ts"),
      source("app/components/canvas-edge-layer.tsx"),
      source("app/components/assets-view.tsx"),
      source("app/api/v2/files/bulk/route.ts"),
      source("app/components/task-center.tsx"),
      source("app/api/v2/canvases/share/route.ts"),
      source("drizzle/0006_unknown_havok.sql"),
      source("app/lib/rate-limit.ts"),
      source("app/api/v2/kernel/runs/route.ts"),
      source("app/lib/artifact-format.ts"),
    ]);

  assert.match(canvas, /visibleWorldBounds/);
  assert.match(canvas, /requestAnimationFrame/);
  assert.match(canvas, /selectionBox/);
  assert.match(canvas, /os\.selectNodes/);
  assert.match(canvas, /file\.type\.startsWith\("audio\/"\)/);
  assert.match(drawer, /已归档/);
  assert.match(drawer, /回收站/);
  assert.match(drawer, /onDuplicate/);
  assert.match(controller, /async function duplicateCanvas/);
  assert.match(controller, /async function restoreCanvas/);
  assert.doesNotMatch(
    controller,
    /startSimulatedRun|function submitIntent\(|setInterval.*progress/s,
  );
  assert.match(edges, /function curve/);
  assert.match(edges, /visibleBounds/);
  assert.match(assets, /nextCursor/);
  assert.match(assets, /批量下载/);
  assert.match(assets, /来源追溯/);
  assert.match(assets, /添加到画布/);
  assert.match(controller, /function addAssetToCanvas/);
  assert.match(controller, /function graphForBranch/);
  assert.match(fileBulk, /action === "tags"/);
  assert.match(tasks, /window\.setInterval\(refresh, 4_000\)/);
  assert.match(tasks, /异步视频和工作流在关闭页面后继续运行/);
  assert.match(share, /tokenHash/);
  assert.match(migration, /source_port_id/);
  assert.match(migration, /xiaoluo_v2_rate_limit_buckets/);
  assert.match(limiter, /RATE_LIMITED/);
  assert.match(kernelRuns, /"audio", "document"/);
  assert.match(artifactFormat, /application\/pdf/);
});
