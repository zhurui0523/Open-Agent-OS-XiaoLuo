import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the XiaoLuo AI workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>XiaoLuo AI Intent OS V2<\/title>/i);
  assert.match(html, /XiaoLuo AI/);
  assert.match(html, /Intent Console/);
  assert.match(html, /夏日品牌短片/);
  assert.match(html, /AI 会先生成可检查计划/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("ships the extension engine without creating user SKILL content", async () => {
  const [data, capabilityView, packageJson, contract, schemaRenderer] = await Promise.all([
    readFile(new URL("../app/data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/capabilities-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/package-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/schema-fields.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(data, /core\.capability\.text/);
  assert.match(data, /core\.capability\.image/);
  assert.match(data, /core\.capability\.video/);
  assert.doesNotMatch(data, /core\.skill\.|analyze-script|create-script|video-dissect/);
  assert.match(capabilityView, /Skill 引擎已经就位，内容保持为空/);
  assert.match(capabilityView, /程序不会预装或创建任何具体 Skill/);
  assert.match(capabilityView, /sandbox="allow-scripts"/);
  assert.doesNotMatch(capabilityView, /sandbox="[^"]*allow-same-origin/);
  assert.match(contract, /Skill Package 默认无代码执行权/);
  assert.match(contract, /network:https:\/\//);
  assert.match(schemaRenderer, /Schema 自动渲染/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("public/_sites-preview", root)));
});

test("validates Package Contract namespaces, permissions, and runtime isolation", async () => {
  const { parsePackagePayload, ManifestValidationError } = await import(
    "../app/lib/package-contract.ts"
  );

  const manifest = parsePackagePayload({
    schemaVersion: "2.0",
    id: "com.example.review",
    name: "Review Panel",
    version: "1.0.0",
    type: "plugin",
    runtime: {
      type: "sandbox-ui",
      entry: "https://plugins.example.com/review",
    },
    permissions: ["assets:read"],
    contributes: {
      panels: [{ id: "com.example.review.panel", title: "Review" }],
    },
  });
  assert.equal(manifest.runtime.type, "sandbox-ui");
  assert.deepEqual(manifest.permissions, ["assets:read"]);

  assert.throws(
    () =>
      parsePackagePayload({
        schemaVersion: "2.0",
        id: "com.example.skill",
        name: "Unsafe Skill",
        version: "1.0.0",
        type: "skill",
        runtime: {
          type: "remote-api",
          entry: "https://plugins.example.com/execute",
        },
        permissions: ["network:https://plugins.example.com"],
        contributes: {
          skills: [
            {
              id: "com.example.skill.run",
              title: "Run",
              modality: "text",
            },
          ],
        },
      }),
    (error) =>
      error instanceof ManifestValidationError &&
      error.issues.some((issue) => issue.includes("无代码执行权")),
  );
});

test("uses an unbounded world-coordinate canvas with pointer-centered zoom", async () => {
  const geometry = await import("../app/lib/canvas-geometry.ts");
  const [canvasView, nodeCard, styles] = await Promise.all([
    readFile(new URL("../app/components/canvas-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/node-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const viewport = { x: 120, y: 80, zoom: 100 };
  const anchor = { x: 420, y: 280 };
  const before = geometry.screenToWorld(anchor, viewport);
  const zoomed = geometry.zoomViewportAt(viewport, 175, anchor);
  const after = geometry.screenToWorld(anchor, zoomed);
  assert.deepEqual(after, before);

  assert.equal(geometry.clampCanvasZoom(1), 15);
  assert.equal(geometry.clampCanvasZoom(900), 300);
  assert.deepEqual(
    geometry.screenToWorld(
      { x: 0, y: 0 },
      { x: 200, y: 100, zoom: 50 },
    ),
    { x: -400, y: -200 },
  );

  assert.match(canvasView, /translate3d\(/);
  assert.match(canvasView, /Ctrl\/⌘ \+ 滚轮缩放/);
  assert.match(canvasView, /visibleWorldBounds/);
  assert.doesNotMatch(nodeCard, /Math\.max\(16|Math\.max\(24/);
  assert.doesNotMatch(styles, /width:\s*1240px|height:\s*720px/);
  assert.match(styles, /\.canvas-content[\s\S]*width:\s*0;[\s\S]*height:\s*0;/);
});
