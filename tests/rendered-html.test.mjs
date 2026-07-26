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

test("server-renders the connected XiaoLuo AI shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>XiaoLuo AI Intent OS V2<\/title>/i);
  assert.match(html, /XiaoLuo AI/);
  assert.match(html, /正在连接 XiaoLuo AI 云端内核/);
  assert.match(
    html,
    /<link[^>]+rel="icon"[^>]+href="\/xiaoluo-intent-mark\.png"/,
  );
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

test("ships an empty extension engine that lets users create their own Skills", async () => {
  const [
    data,
    capabilityView,
    settingsCenter,
    packageJson,
    contract,
    schemaRenderer,
  ] = await Promise.all([
    readFile(new URL("../app/data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/capabilities-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/settings-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/package-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/schema-fields.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(data, /core\.capability\.text/);
  assert.match(data, /core\.capability\.image/);
  assert.match(data, /core\.capability\.video/);
  assert.match(data, /core\.capability\.audio/);
  assert.match(data, /core\.capability\.document/);
  assert.doesNotMatch(data, /core\.skill\.|analyze-script|create-script|video-dissect/);
  assert.match(capabilityView, /Skill 契约与节点保持同步/);
  assert.match(capabilityView, /系统不会预装开发文档中的具体 Skill/);
  assert.match(capabilityView, /创建 Skill/);
  assert.match(capabilityView, /SchemaOptionBuilder/);
  assert.doesNotMatch(
    capabilityView,
    /添加模型|模型 Provider Adapter|modelDialog|tab === "models"/,
  );
  assert.match(settingsCenter, /添加 API/);
  assert.match(settingsCenter, /os\.createModel/);
  assert.match(settingsCenter, /os\.updateModel/);
  assert.match(settingsCenter, /os\.deleteModel/);
  assert.match(settingsCenter, /os\.testModel/);
  assert.match(capabilityView, /sandbox="allow-scripts"/);
  assert.doesNotMatch(capabilityView, /sandbox="[^"]*allow-same-origin/);
  assert.match(contract, /Skill、Agent 与 Workflow Package 默认无代码执行权/);
  assert.match(contract, /network:https:\/\//);
  assert.match(schemaRenderer, /Schema 校验通过/);
  assert.match(schemaRenderer, /<SchemaField/);
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

  const agent = parsePackagePayload({
    schemaVersion: "2.0",
    id: "com.example.agent",
    name: "Review Agent",
    version: "1.0.0",
    type: "agent",
    runtime: { type: "declarative" },
    contributes: {
      agents: [
        {
          id: "com.example.agent.review",
          title: "Review Agent",
          modality: "text",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    },
  });
  assert.equal(agent.contributes?.agents?.length, 1);
});

test("uses an unbounded world-coordinate canvas with pointer-centered zoom", async () => {
  const geometry = await import("../app/lib/canvas-geometry.ts");
  const [appShell, canvasView, edgeLayer, canvasToolbar, contextMenu, nodeCard, controller, styles] =
    await Promise.all([
    readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-edge-layer.tsx", import.meta.url), "utf8"),
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
  assert.match(contextMenu, /文本素材卡片/);
  assert.match(contextMenu, /图片素材卡片/);
  assert.match(contextMenu, /视频素材卡片/);
  assert.match(contextMenu, /新建 Skill 执行节点/);
  assert.match(contextMenu, /添加插件运行器/);
  assert.match(contextMenu, /自由画布/);
  assert.match(contextMenu, /时间排序/);
  assert.match(contextMenu, /类型排序/);
  assert.doesNotMatch(
    canvasToolbar,
    /导入素材|添加卡片|连接节点|展开更多工具|canvas-toolbar-more/,
  );
  assert.match(canvasToolbar, /WandSparkles/);
  assert.match(canvasToolbar, /onClick=\{\(\) => onNavigate\("canvas"\)\}/);
  assert.match(
    canvasToolbar,
    /tool-separator[\s\S]*进入灵境画布[\s\S]*打开资产中心/,
  );
  assert.match(controller, /function undoCanvas/);
  assert.match(controller, /function selectNode/);
  assert.match(controller, /function connectNodes/);
  assert.match(controller, /function deleteEdge/);
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
  assert.match(nodeCard, /function NodeWorkbench/);
  assert.match(nodeCard, /workbench-\$\{node\.kind\}/);
  assert.match(nodeCard, /语气|参考素材|首帧素材/);
  assert.match(canvasView, /nodeHeights\[node\.id\]/);
  assert.match(canvasView, /<CanvasEdgeLayer/);
  assert.match(nodeCard, /node-workbench-content/);
  assert.doesNotMatch(styles, /\.node-workbench-content[\s\S]{0,180}overflow/);
  assert.match(styles, /\.image-workbench-preview[\s\S]*height:\s*108px;/);
  assert.match(styles, /\.video-workbench-preview[\s\S]*height:\s*104px;/);
  assert.match(styles, /\.port\s*\{[\s\S]*top:\s*50%;[\s\S]*transform:\s*translateY\(-50%\);/);
  assert.match(nodeCard, /onConnectionStart/);
  assert.match(nodeCard, /data-node-id=\{node\.id\}/);
  assert.match(canvasView, /connectionDraft/);
  assert.match(canvasView, /document[\s\S]*\.elementFromPoint/);
  assert.match(edgeLayer, /canvas-edge-remove/);
  assert.match(styles, /\.edge-line\.is-selected/);
  assert.match(styles, /\.canvas-stage\.is-connecting \.port-input\.is-available/);
});

test("compiles and executes workflows through the AI microkernel contract", async () => {
  const { compileWorkflow, WorkflowCompileError } = await import(
    "../app/lib/workflow-kernel.ts"
  );
  const nodes = [{ id: "brief" }, { id: "script" }, { id: "image" }, { id: "video" }];
  const edges = [
    { id: "e1", source: "brief", target: "script" },
    { id: "e2", source: "brief", target: "image" },
    { id: "e3", source: "script", target: "video" },
    { id: "e4", source: "image", target: "video" },
  ];
  const workflow = compileWorkflow(nodes, edges);
  assert.deepEqual(workflow.levels, [
    ["brief"],
    ["script", "image"],
    ["video"],
  ]);
  assert.deepEqual(workflow.dependencies.video, ["script", "image"]);

  assert.throws(
    () =>
      compileWorkflow(nodes, [
        ...edges,
        { id: "cycle", source: "video", target: "brief" },
      ]),
    (error) =>
      error instanceof WorkflowCompileError &&
      error.code === "CYCLE_DETECTED",
  );

  const [controller, worker, runRoute, executeRoute, executors, schema, appShell] =
    await Promise.all([
      readFile(new URL("../app/hooks/use-intent-os.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/lib/kernel-worker.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/v2/kernel/runs/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/v2/kernel/execute/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/lib/kernel-executors.ts", import.meta.url), "utf8"),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
    ]);
  assert.match(controller, /compileWorkflow/);
  assert.match(controller, /kernelOutput/);
  assert.match(worker, /Promise\.allSettled/);
  assert.match(worker, /sourceType: "kernel-output"/);
  assert.doesNotMatch(controller, /function startRun\(\)[\s\S]{0,500}setTimeout/);
  assert.match(runRoute, /kernel\.run\.created/);
  assert.match(executeRoute, /kernel\.node\.succeeded/);
  assert.match(executeRoute, /dependency\.status !== "succeeded"/);
  assert.match(executors, /executeRemotePackage/);
  assert.match(executors, /executeModel/);
  assert.match(executors, /kernel\.builtin-preview/);
  assert.match(schema, /kernel_runs/);
  assert.match(schema, /kernel_tasks/);
  assert.match(appShell, /AI 微内核在线/);
});

test("ships a persistent AI file system with versioned asset URIs", async () => {
  const [
    hosting,
    schema,
    kernel,
    filesRoute,
    contentRoute,
    versionsRoute,
    assetsView,
    canvasView,
    controller,
    runtimeConfig,
    envExample,
    gitignore,
  ] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/asset-kernel.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/files/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/files/content/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/files/versions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/assets-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/canvas-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/use-intent-os.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/server-runtime-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);

  assert.equal(typeof JSON.parse(hosting).project_id, "string");
  assert.match(schema, /asset_folders/);
  assert.match(schema, /asset_versions/);
  assert.match(schema, /asset_relations/);
  assert.match(kernel, /asset:\/\/workspace\//);
  assert.match(kernel, /blobs\/sha256\//);
  assert.match(kernel, /sha256Hex/);
  assert.match(filesRoute, /asset\.created/);
  assert.match(filesRoute, /action\?: "trash" \| "restore"/);
  assert.match(contentRoute, /accept-ranges/);
  assert.match(contentRoute, /content-range/);
  assert.match(versionsRoute, /storeAssetVersion/);
  assert.match(assetsView, /AI 文件系统/);
  assert.match(assetsView, /\/api\/v2\/files/);
  assert.match(assetsView, /版本历史/);
  assert.doesNotMatch(assetsView, /initialAssets/);
  assert.match(canvasView, /os\.uploadAsset/);
  assert.match(canvasView, /source: "asset-kernel"/);
  assert.match(kernel, /sourceType: input\.sourceType \?\? "upload"/);
  assert.match(controller, /async function uploadAsset/);
  assert.match(runtimeConfig, /driver: "mysql"/);
  assert.match(runtimeConfig, /driver: "oss"/);
  assert.match(kernel, /ossAuthorization/);
  assert.match(kernel, /HMAC/);
  assert.match(kernel, /SHA-1/);
  assert.doesNotMatch(kernel, /import\("ali-oss"\)/);
  assert.match(envExample, /^DB_PASSWORD=$/m);
  assert.match(envExample, /^OSS_ACCESS_KEY_SECRET=$/m);
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test("offers a local development entry that uses remote MySQL and OSS", async () => {
  const [packageJson, launcher, nextLauncher, envExample, gitignore] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../start-local.cmd", import.meta.url), "utf8"),
      readFile(
        new URL("../scripts/start-local-next.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    ]);

  assert.equal(
    JSON.parse(packageJson).scripts["dev:local"],
    "node scripts/start-local-next.mjs",
  );
  assert.match(nextLauncher, /node_modules\/next\/dist\/bin\/next/);
  assert.match(nextLauncher, /127\.0\.0\.1/);
  assert.match(launcher, /http:\/\/localhost:3001\//);
  assert.match(launcher, /remote MySQL \+ Alibaba Cloud OSS/);
  assert.doesNotMatch(launcher, /DATABASE_DRIVER=d1/);
  assert.doesNotMatch(launcher, /STORAGE_DRIVER=r2/);
  assert.match(envExample, /no local business-data fallback/);
  assert.match(envExample, /^DB_HOST=$/m);
  assert.match(envExample, /^OSS_BUCKET=$/m);
  assert.match(gitignore, /^\/\.wrangler\/$/m);
});

test("keeps identity, canvases, and files on authenticated cloud services", async () => {
  const [
    auth,
    schema,
    canvasRoute,
    workspaceStore,
    fileRoute,
    fileContentRoute,
    controller,
  ] = await Promise.all([
    readFile(new URL("../app/lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/canvases/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/workspace-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/files/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/v2/files/content/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/hooks/use-intent-os.ts", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /PBKDF2/);
  assert.match(auth, /token_hash/);
  assert.match(auth, /xiaoluo_access/);
  assert.match(auth, /xiaoluo_refresh/);
  assert.match(auth, /ACCESS_TOKEN_SECONDS = 15 \* 60/);
  assert.match(auth, /refresh_token_hash = \?/);
  assert.match(auth, /refresh_rotated_at = CURRENT_TIMESTAMP/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Lax/);
  assert.match(schema, /export const users/);
  assert.match(schema, /export const authSessions/);
  assert.match(schema, /export const workspaces/);
  assert.match(schema, /export const canvases/);
  assert.match(canvasRoute, /requireCanvasAccess/);
  assert.match(workspaceStore, /revision = revision \+ 1/);
  assert.match(canvasRoute, /status: 409/);
  assert.match(fileRoute, /requireWorkspaceContext/);
  assert.match(fileContentRoute, /eq\(assets\.workspaceId, home\.workspaceId\)/);
  assert.doesNotMatch(controller, /localStorage|sessionStorage/);
});

test("ships phone recovery and the deliberately small membership model", async () => {
  const [
    schema,
    phoneAuth,
    sms,
    loginRoute,
    registerRoute,
    resetRoute,
    organizationRoute,
    membersRoute,
    adminRoute,
    authScreen,
    accountCenter,
    mysql,
    adminBootstrap,
  ] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/phone-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/sms.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/auth/register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/auth/password/reset/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/organizations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/organizations/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/admin/enterprises/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/auth-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/account-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/mysql.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bootstrap-system-admin.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /platformRole: mysqlEnum\("platform_role", \["system_admin", "user"\]\)/);
  assert.match(schema, /role: mysqlEnum\("role", \["admin", "member"\]\)/);
  assert.doesNotMatch(schema, /operations_admin|security_auditor|enterprise_owner/);
  assert.match(phoneAuth, /INTERVAL 60 SECOND/);
  assert.match(phoneAuth, /max_attempts AS maxAttempts/);
  assert.match(phoneAuth, /consumed_at = CURRENT_TIMESTAMP/);
  assert.match(sms, /生产环境禁止使用开发短信模式/);
  assert.match(sms, /dysmsapi\.aliyuncs\.com/);
  assert.match(loginRoute, /userByLoginIdentifier/);
  assert.match(registerRoute, /verifyPhoneChallenge/);
  assert.match(registerRoute, /normalizeUsername/);
  assert.match(registerRoute, /id, email, username, display_name/);
  assert.match(registerRoute, /password\.length < 6/);
  assert.match(resetRoute, /DELETE FROM xiaoluo_v2_auth_sessions/);
  assert.match(resetRoute, /password\.length < 6/);
  assert.match(organizationRoute, /enterprise_applications/);
  assert.match(membersRoute, /企业必须至少保留一名启用的管理员/);
  assert.match(adminRoute, /requireSystemAdmin/);
  assert.match(authScreen, /通过手机号找回密码/);
  assert.match(authScreen, /邮箱或用户名/);
  assert.match(authScreen, /用于登录，全局唯一/);
  assert.match(authScreen, /minLength=\{6\}/);
  assert.match(adminBootstrap, /password\.length < 6/);
  assert.match(accountCenter, /仅企业管理员与企业普通用户两种角色/);
  assert.match(mysql, /disableEval: true/);
  assert.match(mysql, /await database\.end\(\)/);
  assert.doesNotMatch(mysql, /pool \?\?=/);
  assert.doesNotMatch(
    mysql,
    /\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|ALTER TABLE|DELETE FROM)\s+users\b/,
  );
  assert.match(schema, /xiaoluo_v2_users/);
  assert.doesNotMatch(mysql, /\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b/i);
});

test("ships settings for API keys, canvas gestures, and shortcuts", async () => {
  const [toolbar, settings, canvas, preferencesRoute, schema] =
    await Promise.all([
      readFile(
        new URL("../app/components/canvas-toolbar.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/components/settings-center.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/components/canvas-view.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/v2/preferences/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    ]);

  assert.match(toolbar, /label="设置"/);
  assert.match(settings, /API Key/);
  assert.match(settings, /画布手势/);
  assert.match(settings, /快捷键/);
  assert.doesNotMatch(settings, /自定义接口|请求体 JSON|响应示例 JSON/);
  assert.match(canvas, /gesturePreset === "zoom-wheel"/);
  assert.match(canvas, /keyboardShortcuts/);
  assert.match(preferencesRoute, /onDuplicateKeyUpdate/);
  assert.match(schema, /xiaoluo_v2_user_preferences/);
});

test("ships a secure personal center with profile and device management", async () => {
  const [
    settings,
    personal,
    profileRoute,
    phoneRoute,
    passwordRoute,
    securityRoute,
    sessionsRoute,
    auth,
    schema,
  ] = await Promise.all([
    readFile(
      new URL("../app/components/settings-center.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/personal-settings.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/account/profile/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/account/phone/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/account/password/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/account/security/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/account/sessions/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(settings, /个人中心/);
  assert.match(personal, /编辑资料/);
  assert.match(personal, /改绑手机号/);
  assert.match(personal, /修改密码/);
  assert.match(personal, /安全设置/);
  assert.match(personal, /登录设备/);
  assert.match(profileRoute, /requireUser/);
  assert.match(phoneRoute, /verifyPhoneChallenge/);
  assert.match(phoneRoute, /verifyPassword/);
  assert.match(passwordRoute, /hashPassword/);
  assert.match(passwordRoute, /id <> \?/);
  assert.match(securityRoute, /allow_multiple_sessions/);
  assert.match(sessionsRoute, /currentSessionId/);
  assert.match(sessionsRoute, /clearAuthCookieHeaders/);
  assert.match(auth, /device_name, user_agent, ip_address/);
  assert.match(auth, /email = \? OR username = \?/);
  assert.doesNotMatch(auth, /email = \? OR display_name = \?/);
  assert.match(personal, /value=\{user\.username\}/);
  assert.match(personal, /readOnly/);
  assert.doesNotMatch(profileRoute, /SET username = \?/);
  assert.doesNotMatch(profileRoute, /normalizeUsername/);
  assert.match(schema, /username: varchar\("username"/);
  assert.match(schema, /refreshTokenHash: varchar\("refresh_token_hash"/);
  assert.match(schema, /xiaoluo_v2_user_security_settings/);
});

test("isolates system administration from ordinary user settings", async () => {
  const [
    shell,
    settings,
    account,
    adminCenter,
    adminUsersRoute,
    adminOverviewRoute,
  ] = await Promise.all([
    readFile(
      new URL("../app/components/app-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/settings-center.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/account-center.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/admin-center.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/admin/users/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/v2/admin/overview/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(shell, /user\.platformRole === "system_admin"/);
  assert.match(shell, /后台管理/);
  assert.match(shell, /<AdminCenter/);
  assert.doesNotMatch(settings, /内核运维|AdminOperations|"kernel"/);
  assert.doesNotMatch(account, /\/api\/v2\/admin\/users|企业审核/);
  assert.match(adminCenter, /<AdminOperations/);
  assert.match(adminCenter, /用户管理/);
  assert.match(adminCenter, /企业审核/);
  assert.match(adminCenter, /文本 \{managedUser\.textCount\}/);
  assert.match(adminCenter, /图片 \{managedUser\.imageCount\}/);
  assert.match(adminCenter, /视频 \{managedUser\.videoCount\}/);
  assert.match(adminCenter, /OSS 存储量/);
  assert.match(adminCenter, /修改密码/);
  assert.match(adminCenter, /删除用户/);
  assert.match(adminUsersRoute, /requireSystemAdmin/);
  assert.match(adminUsersRoute, /xiaoluo_v2_model_execution_audits/);
  assert.match(adminUsersRoute, /xiaoluo_v2_assets/);
  assert.match(adminUsersRoute, /hashPassword/);
  assert.match(adminUsersRoute, /export async function DELETE/);
  assert.match(adminUsersRoute, /deletionMode: "anonymized"/);
  assert.match(adminOverviewRoute, /requireSystemAdmin/);
});
