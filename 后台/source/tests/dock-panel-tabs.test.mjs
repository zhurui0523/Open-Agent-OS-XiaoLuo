import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("result dock tabs only come from enabled sandbox-ui plugins", async () => {
  const registry = await source("app/lib/dock-panel-registry.ts");

  assert.match(registry, /item\.runtimeType !== "sandbox-ui"/);
  assert.match(registry, /if \(!item\.enabled \|\| !item\.runtimeUrl\)/);
  assert.match(registry, /packageInstallStatus\(item\)\.available/);
  assert.match(registry, /DOCK_PANEL_TAB_PREFIX = "plugin:"/);
  assert.match(registry, /xiaoluo\.dock\.panel-pins/);
  // 卸载或停用后钉选自动失效，不留死页签
  assert.match(registry, /\.filter\(\(panel\): panel is DockPanelDescriptor => Boolean\(panel\)\)/);
});

test("panel entry is only appended when it stays inside the plugin static directory", async () => {
  const [registry, contract] = await Promise.all([
    source("app/lib/dock-panel-registry.ts"),
    source("app/lib/package-contract.ts"),
  ]);

  assert.match(registry, /if \(!isSafePanelEntry\(entry\)\) return runtimeUrl;/);
  assert.match(registry, /value\.includes\("\.\."\)/);
  assert.match(registry, /value\.includes\(":\/\/"\)/);
  assert.match(registry, /if \(!path\.includes\(PLUGIN_STATIC_RUNTIME_PREFIX\)\) return runtimeUrl;/);
  assert.match(contract, /entry 只能指向插件内的 html 页面/);
});

test("pinned plugin tabs live in the hub header and run the panel in place", async () => {
  const [dock, hub, canvasView, styles] = await Promise.all([
    source("app/components/brain-result-dock.tsx"),
    source("app/components/plugins-hub-panel.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/globals.css"),
  ]);

  // 结果面板彻底不碰插件面板：没有页签、没有 iframe，连入参都不收
  assert.doesNotMatch(dock, /PluginRuntimeFrame/);
  assert.doesNotMatch(dock, /pluginPanels/);
  assert.doesNotMatch(dock, /isDockPanelTab/);
  assert.doesNotMatch(dock, /<Puzzle/);
  assert.doesNotMatch(dock, /toggleDockPanelPin/);
  assert.match(dock, /export type DockTab = BuiltinDockTab;/);

  // 页签摆在插件台标题右边，点它在本屏运行那块面板，再点一次回清单
  assert.match(hub, /panels\.filter\(\(panel\) => pinnedTabIds\.has\(panel\.tabId\)\)/);
  assert.match(hub, /aria-label="已固定插件页签"/);
  assert.match(hub, /onRunningTabIdChange\(running \? null : panel\.tabId\)/);
  assert.match(hub, /runningPanel \? \(/);
  assert.match(hub, /<PluginRuntimeFrame/);
  assert.match(hub, /className="plugin-runtime-content hub-plugin-runtime"/);
  // 「打开」也留在本屏：没固定先固定，再就地运行
  assert.match(hub, /if \(!pinnedTabIds\.has\(panel\.tabId\)\) toggleDockPanelPin\(panel\.tabId\);/);
  assert.match(hub, /onClick=\{\(\) => runPanel\(panel\)\}/);
  // 就地运行要用画布同一份引用上下文
  assert.match(canvasView, /assetContexts=\{dockPanelAssetContexts\}/);
  assert.match(canvasView, /textContexts=\{dockPanelTextContexts\}/);
  // 运行的是哪块面板由壳记，插件台和结果面板互斥；画布只拿 props
  assert.match(canvasView, /runningTabId=\{hubRunningTabId\}/);
  assert.match(canvasView, /onRunningTabIdChange=\{onHubRunningTabIdChange\}/);
  assert.match(canvasView, /\{pluginsHubOpen && \(/);
  assert.match(canvasView, /\{brainDockOpen && \(/);
  // 旧的「交给结果面板承载」那条路要断干净
  assert.doesNotMatch(canvasView, /openDockPanelFromHub|onOpenPanel=/);
  assert.doesNotMatch(styles, /\.dock-plugin-panel|\.dock-plugin-runtime/);
});

test("canvas and capability centre both expose the pin action", async () => {
  const [canvasView, contextMenu, capabilityView] = await Promise.all([
    source("app/components/canvas-view.tsx"),
    source("app/components/canvas-context-menu.tsx"),
    source("app/components/capabilities-view.tsx"),
  ]);

  assert.match(canvasView, /usePinnedDockPanels\(os\.packages\)/);
  assert.match(canvasView, /pinnedTabIds=\{new Set\(pinnedDockPanels\.map\(\(panel\) => panel\.tabId\)\)\}/);
  assert.match(canvasView, /setPluginPanelsPinned\(panels, remove\)/);
  // 画布右键固定之后直接开插件台并跑起那块面板，状态写在壳上
  assert.match(canvasView, /onHubRunningTabIdChange\(panels\[0\]\.tabId\);/);
  assert.match(canvasView, /onPluginsHubOpenChange\(true\);/);
  assert.match(contextMenu, /onPinPluginPanel: \(/);
  assert.match(contextMenu, /固定到插件台/);
  assert.match(capabilityView, /固定到插件台/);
});

test("sandbox preview is the left pane and code the right in one tab", async () => {
  const [dock, styles, canvasView, brainPanel] = await Promise.all([
    source("app/components/brain-result-dock.tsx"),
    source("app/globals.css"),
    source("app/components/canvas-view.tsx"),
    source("app/components/xiaoluo-brain-panel.tsx"),
  ]);

  assert.doesNotMatch(dock, /\{ tab: "preview", label:/);
  assert.match(dock, /tab === "code" \? \(/);
  assert.match(dock, /<CodeCard/);
  assert.match(dock, /<SandboxFrame preview=\{sandboxDoc\} fill/);
  // flex 顺序即 DOM 顺序：预览栏必须排在代码栏前面
  const previewPane = dock.indexOf("<header>沙箱预览</header>");
  const codePane = dock.indexOf("<header>代码</header>");
  assert.ok(previewPane > -1 && codePane > -1 && previewPane < codePane);
  // 预览页签删除后，旧 localStorage 记录必须落到合并页而不是空白页
  assert.match(dock, /if \(tab === "preview"\) return "code";/);
  assert.match(dock, /normalizeDockTab\(readStoredDockTab\(\)\)/);
  assert.match(styles, /\.dock-code-split \{/);
  assert.match(styles, /@container \(max-width: 760px\)/);
  assert.match(styles, /grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(canvasView, /const openBrainDock = useCallback\(\(\) =>/);
  assert.doesNotMatch(brainPanel, /onOpenResult\("preview"\)/);
});

test("one button collapses and restores the code pane", async () => {
  const [dock, styles] = await Promise.all([
    source("app/components/brain-result-dock.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(dock, /className=\{"dock-code-split" \+ \(codeCollapsed \? " is-code-collapsed" : ""\)\}/);
  assert.match(dock, /className="dock-code-toggle"/);
  assert.match(dock, /aria-expanded=\{!codeCollapsed\}/);
  assert.match(dock, /aria-label=\{codeCollapsed \? "放开代码栏" : "收起代码栏"\}/);
  assert.match(dock, /setCodeCollapsed\(\(collapsed\) => !collapsed\)/);
  // 开关在预览栏之后、代码栏之前，就是那条分界位
  const toggle = dock.indexOf('className="dock-code-toggle"');
  assert.ok(toggle > dock.indexOf("<header>沙箱预览</header>"));
  assert.ok(toggle < dock.indexOf("<header>代码</header>"));

  // 状态存下来，刷新后仍是上次那一面
  assert.match(dock, /window\.localStorage\.getItem\(CODE_PANE_STORAGE_KEY\) === "1"/);
  assert.match(dock, /window\.localStorage\.setItem\(CODE_PANE_STORAGE_KEY, codeCollapsed \? "1" : "0"\)/);

  // 老板不要拖动：指针捕获、比例、拖动期间的 body class 全部不能留
  assert.doesNotMatch(dock, /onPointerDown|setPointerCapture|clampCodeSplit|moveCodeSplit/);
  assert.doesNotMatch(dock, /--dock-code-split|is-resizing-dock-split/);
  assert.doesNotMatch(styles, /--dock-code-split|is-resizing-dock-split/);

  // 收起只压宽度，栏位不卸载，CodeCard 的选中文件与未提交编辑都保住
  assert.match(
    styles,
    /\.dock-code-split\.is-code-collapsed > \.dock-code-pane:last-child \{\s*flex: 0 0 0;\s*padding: 0;\s*visibility: hidden;/,
  );
  assert.match(styles, /\.dock-code-toggle \{[\s\S]*?cursor: pointer;/);
  assert.match(styles, /\.dock-code-divider::after \{[\s\S]*?left: 11px;/);

  // 窄容器上下堆叠：开关还在，分隔线转成横线
  assert.match(
    styles,
    /@container \(max-width: 760px\) \{[\s\S]*?\.dock-code-divider::after \{\s*top: 17px;/,
  );
});

test("the plugins hub is its own surface and pins panels into the result dock", async () => {
  const [dock, hub, canvasView] = await Promise.all([
    source("app/components/brain-result-dock.tsx"),
    source("app/components/plugins-hub-panel.tsx"),
    source("app/components/canvas-view.tsx"),
  ]);

  // 插件台彻底不挂在这排页签上，页签注册表里也没有这一栏
  assert.doesNotMatch(dock, /"plugins"/);
  assert.doesNotMatch(dock, /availablePluginPanels|onInstallSamplePlugin/);
  assert.match(hub, /aria-label="插件台"/);
  assert.match(hub, /panels\.length === 0 \?/);
  assert.match(hub, /安装示例面板插件/);
  assert.match(hub, /onClick=\{\(\) => toggleDockPanelPin\(panel\.tabId\)\}/);
  assert.match(hub, /onInstallSample \? \(/);

  // 未固定的面板没有页签，「打开」先固定再在本屏跑起来 —— 这一步整个留在插件台内部
  assert.match(
    hub,
    /if \(!pinnedTabIds\.has\(panel\.tabId\)\) toggleDockPanelPin\(panel\.tabId\);/,
  );
  assert.match(canvasView, /runningTabId=\{hubRunningTabId\}/);
  assert.match(canvasView, /allPluginDockPanels\(os\.packages\)/);
  assert.match(canvasView, /panels=\{availableDockPanels\}/);
  assert.match(canvasView, /onInstallSample=\{installSampleDockPanelPlugin\}/);
  assert.match(canvasView, /\/samples\/xiaoluo-dock-panel-demo\.zip/);
});

test("the plugins hub opens from the float bar and takes the screen from the dock", async () => {
  const [dock, hub, canvasView, appShell, floatBar, styles] = await Promise.all([
    source("app/components/brain-result-dock.tsx"),
    source("app/components/plugins-hub-panel.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/components/app-shell.tsx"),
    source("app/components/canvas-float-bar.tsx"),
    source("app/globals.css"),
  ]);

  // 页签栏照旧，这一栏叫 浏览器（和它自己的空状态标题一致）
  assert.match(dock, /\{ tab: "browser", label: "浏览器"/);
  assert.match(dock, /\{ tab: "memory", label: "记忆".*toggle: true \}/);
  assert.match(dock, /\{ tab: "mcp", label: "MCP"/);
  assert.match(dock, /\{ tab: "services", label: "服务"/);

  // 两块都是占满画布区的一屏，开一个就关另一个，不会叠在一起
  assert.match(hub, /position: "absolute",[\s\S]*?zIndex: 40,/);
  assert.match(canvasView, /\{pluginsHubOpen && \(/);
  // 开关状态在壳上：浮条要常驻到别的屏，画布一卸载就不能再自己拿着
  assert.match(appShell, /const \[pluginsHubOpen, setPluginsHubOpen\] = useState\(false\);/);
  assert.match(appShell, /const \[hubRunningTabId, setHubRunningTabId\] = useState<string \| null>\(null\);/);
  assert.match(canvasView, /pluginsHubOpen,[\s\S]*?onPluginsHubOpenChange,[\s\S]*?hubRunningTabId,[\s\S]*?onHubRunningTabIdChange,\s*\}: CanvasViewProps/);
  // 浮条那颗不是简单 toggle：正在跑面板时先退回清单，只有已在清单才关屏
  assert.match(
    appShell,
    /if \(os\.view !== "canvas" \|\| !pluginsHubOpen \|\| hubRunningTabId !== null\) \{\s*os\.setView\("canvas"\);\s*setHubRunningTabId\(null\);\s*setPluginsHubOpen\(true\);\s*setBrainDockOpen\(false\);\s*break;\s*\}/,
  );
  assert.doesNotMatch(appShell, /setPluginsHubOpen\(\(open\) => !open\);/);
  assert.match(appShell, /case "brain-dock":[\s\S]*?setPluginsHubOpen\(false\);\s*setBrainDockOpen\(true\);/);
  // 插件台不再借页签，高亮只看它自己开没开——而且只有画布那一屏才谈得上亮
  assert.match(
    floatBar,
    /className=\{\s*"dock-plugins-float" \+\s*\(onCanvas && pluginsHubOpen \? " is-active" : ""\)/,
  );
  // 导航条挂在 .app-shell 下而不是 .canvas-main-pane，整组只能从外壳用 :has() 判定
  assert.match(
    canvasView,
    /className=\{"canvas-main-pane" \+ \(pluginsHubOpen \? " is-plugins-hub-open" : ""\)\}/,
  );
  assert.match(
    styles,
    /\.app-shell:has\(\.canvas-main-pane\.is-plugins-hub-open\) \.canvas-toolbar,[\s\S]*?\.canvas-navigation-hint \{\s*display: none;/
  );
  // 底部浮条要留着，不然插件台关不掉
  assert.doesNotMatch(styles, /is-plugins-hub-open\) \.canvas-float-bar/);
  assert.doesNotMatch(dock, /onTabChange/);
  assert.doesNotMatch(canvasView, /reportDockTab|\bdockTab\b/);
  // 浮钮沿用同一套外观
  assert.match(styles, /\.canvas-float-bar > button \{/);
});

test("the bundled sample plugin is browser-ready and one click installable", async () => {
  const [sample, capabilityView] = await Promise.all([
    source("samples/dock-panel-demo/index.html"),
    source("app/components/capabilities-view.tsx"),
  ]);

  // staticRootOf() 会把引用源码脚本的压缩包判定为需要构建，示例必须自包含
  assert.doesNotMatch(
    sample,
    /(?:src|href)\s*=\s*["'][^"']*(?:\/?src\/|\.(?:tsx?|jsx?)(?:[?#]|["']))/i,
  );
  assert.match(sample, /xiaoluo:host-ready/);
  assert.match(sample, /xiaoluo:capability-request/);
  assert.match(sample, /<input type="file"/);

  assert.match(capabilityView, /\/samples\/xiaoluo-dock-panel-demo\.zip/);
  assert.match(capabilityView, /os\.installPackageArchive\(file, "personal"\)/);
});
