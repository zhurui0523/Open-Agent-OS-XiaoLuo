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
  assert.match(html, /aria-label="无限画布"/);
  assert.match(
    html,
    /open-console-button[\s\S]*xiaoluo-intent-mark\.png[\s\S]*Intent/,
  );
  assert.match(
    html,
    /<link[^>]+rel="icon"[^>]+href="\/xiaoluo-intent-mark\.png"/,
  );
  assert.match(html, /夏日品牌短片/);
  assert.doesNotMatch(html, /个人额度|用量与额度|6,820|credit-ring/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
  await access(new URL("../public/xiaoluo-intent-mark.png", import.meta.url));
});

test("ships without a credits, points, quota, or billing system", async () => {
  const [appShell, styles, types, controller, schema] = await Promise.all([
    readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/use-intent-os.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  const productSource = [appShell, styles, types, controller, schema].join("\n");

  assert.doesNotMatch(
    productSource,
    /积分|额度|计费|余额|\bcredits?\b|\bquota\b|\bbilling\b/i,
  );
  assert.doesNotMatch(productSource, /credit-ring|6,820/);
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
  const [appShell, canvasView, canvasToolbar, contextMenu, nodeCard, controller, styles] =
    await Promise.all([
    readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-toolbar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-context-menu.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/node-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/use-intent-os.ts", import.meta.url), "utf8"),
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
  assert.deepEqual(
    geometry.centeredPortPoint(
      { x: 100, y: 200 },
      { width: 264, height: 156 },
      "output",
    ),
    { x: 364, y: 278 },
  );
  assert.deepEqual(
    geometry.centeredPortPoint(
      { x: 100, y: 200 },
      { width: 264, height: 382 },
      "input",
    ),
    { x: 100, y: 391 },
  );

  assert.match(canvasView, /translate3d\(/);
  assert.match(canvasView, /Ctrl\/⌘ \+ 滚轮缩放/);
  assert.match(canvasView, /visibleWorldBounds/);
  assert.match(canvasView, /onContextMenu=\{handleStageContextMenu\}/);
  assert.match(canvasView, /screenToWorld\(screenPoint/);
  assert.match(contextMenu, /文本占位卡片/);
  assert.match(contextMenu, /图片占位卡片/);
  assert.match(contextMenu, /视频占位卡片/);
  assert.match(contextMenu, /新建专业节点/);
  assert.match(contextMenu, /添加 AI 插件卡片/);
  assert.match(contextMenu, /自由画布/);
  assert.match(contextMenu, /时间排序/);
  assert.match(contextMenu, /类型排序/);
  assert.doesNotMatch(
    canvasToolbar,
    /导入素材|添加卡片|连接节点|展开更多工具|canvas-toolbar-more/,
  );
  assert.match(canvasToolbar, /WandSparkles/);
  assert.match(canvasToolbar, /onClick=\{\(\) => onNavigate\("canvas"\)\}/);
  assert.match(controller, /function undoCanvas/);
  assert.match(controller, /function selectNode/);
  assert.match(controller, /function arrangeNodes\(mode: "free" \| "time" \| "type"\)/);
  assert.match(styles, /\.canvas-context-menu[\s\S]*z-index:\s*220;/);
  assert.doesNotMatch(nodeCard, /Math\.max\(16|Math\.max\(24/);
  assert.doesNotMatch(styles, /width:\s*1240px|height:\s*720px/);
  assert.match(styles, /\.canvas-content[\s\S]*width:\s*0;[\s\S]*height:\s*0;/);
  assert.match(appShell, /is-canvas-view/);
  assert.match(styles, /\.is-canvas-view \.app-main[\s\S]*inset:\s*0;/);
  assert.match(styles, /\.app-shell \.canvas-toolbar[\s\S]*flex-direction:\s*column;/);
  assert.match(appShell, /<CanvasToolbar/);
  assert.doesNotMatch(appShell, /className="app-dock"/);
  assert.match(styles, /\.is-canvas-view \.minimap[\s\S]*bottom:\s*24px;[\s\S]*left:\s*24px;/);
  assert.match(canvasView, /minimapOpen/);
  assert.match(canvasView, /收起地图导航/);
  assert.match(canvasView, /展开地图导航/);
  assert.match(styles, /\.minimap-close[\s\S]*border-radius:\s*50%;/);
  assert.match(styles, /\.minimap-toggle[\s\S]*border-radius:\s*50%;/);
  assert.match(styles, /\.is-minimap-collapsed \.zoom-controls[\s\S]*left:\s*96px;/);
  assert.match(styles, /\.is-canvas-view \.open-console-button[\s\S]*right:\s*24px;[\s\S]*bottom:\s*24px;/);
  assert.match(controller, /useState\(false\)/);
  assert.match(nodeCard, /ResizeObserver/);
  assert.match(canvasView, /nodeHeights\[source\.id\]/);
  assert.match(styles, /\.port\s*\{[\s\S]*top:\s*50%;[\s\S]*transform:\s*translateY\(-50%\);/);
});
