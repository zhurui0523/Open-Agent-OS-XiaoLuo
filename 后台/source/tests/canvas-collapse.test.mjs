import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("the float bar switches between the canvas and the result panel", async () => {
  const [styles, floatBar, appShell] = await Promise.all([
    source("app/globals.css"),
    source("app/components/canvas-float-bar.tsx"),
    source("app/components/app-shell.tsx"),
  ]);

  // 七颗收进一条居中容器，不再各自绝对定位
  assert.match(styles, /\.canvas-float-bar \{\s*position: fixed;[\s\S]*?bottom: 28px;[\s\S]*?left: 50%;/);
  assert.match(styles, /\.canvas-float-bar \{[\s\S]*?transform: translateX\(-50%\);/);
  // .app-main 是 fixed 层叠上下文，画布里的东西出不去；这条挂在壳上要越过 360 那两层遮罩，
  // 又留在 1000 的对话框层下面
  assert.match(styles, /\.canvas-float-bar \{\s*position: fixed;\s*z-index: 370;/);
  assert.doesNotMatch(styles, /\.canvas-collapse-float/);
  assert.doesNotMatch(styles, /\.brain-dock-float,\s*\.canvas-surface-float \{[^}]*position: absolute;/);
  assert.doesNotMatch(styles, /\.brain-dock-float \{[^}]*right: 12px;/);

  // 高亮的那一格就是当前界面，三边共用一套 active 样式；插件台是独立一屏，开着时另两格都不亮
  assert.match(styles, /\.canvas-float-bar \.is-active \{/);
  assert.match(floatBar, /className="canvas-float-bar"/);
  assert.match(
    floatBar,
    /className=\{\s*"canvas-surface-float" \+\s*\(onCanvas && !brainDockOpen && !pluginsHubOpen \? " is-active" : ""\)/,
  );
  assert.match(
    floatBar,
    /className=\{\s*"brain-dock-float" \+\s*\(onCanvas && brainDockOpen && !pluginsHubOpen \? " is-active" : ""\)/,
  );
  assert.match(floatBar, /aria-label="画布"/);
  assert.match(floatBar, /aria-label="小逻结果面板"/);
  // 一格只管一个界面，按钮只报意图，互斥由壳来判
  assert.match(floatBar, /onClick=\{\(\) => onAction\("brain-dock"\)\}/);
  assert.match(floatBar, /onClick=\{\(\) => onAction\("canvas-surface"\)\}/);
  assert.match(appShell, /case "brain-dock":[\s\S]*?setBrainDockOpen\(true\);/);
  assert.match(appShell, /case "canvas-surface":[\s\S]*?setBrainDockOpen\(false\);/);

  // 和左下角缩放条同高、同一条底线：bottom 28px + 44px，两者中心自然重合
  assert.match(
    styles,
    /\.is-canvas-view \.zoom-controls \{[\s\S]*?bottom: 28px;[\s\S]*?height: 44px;/,
  );
  assert.match(
    styles,
    /\.canvas-float-bar > button \{[\s\S]*?width: 44px;\r?\n  height: 44px;/,
  );
  // 一排七颗，间隔一律，不给最后一颗额外留位；样式挂在容器上，新增入口自动继承
  assert.match(styles, /\.canvas-float-bar \{[\s\S]*?gap: 8px;/);
  assert.doesNotMatch(styles, /\.canvas-surface-float \{\s*margin-right/);
  assert.match(floatBar, /<AppWindow size=\{18\} \/>/);
  assert.match(floatBar, /<Frame size=\{18\} \/>/);
  assert.match(floatBar, /<Puzzle size=\{18\} \/>/);
});

test("the four nav entries moved from the rail into the float bar", async () => {
  const [styles, floatBar, canvasView, canvasToolbar, appShell] = await Promise.all([
    source("app/globals.css"),
    source("app/components/canvas-float-bar.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/components/canvas-toolbar.tsx"),
    source("app/components/app-shell.tsx"),
  ]);

  // 导航条只剩选择/多选/画布/画布管理四颗，那四颗归底部浮条
  assert.doesNotMatch(canvasToolbar, /打开资产中心|打开能力中心|运行详情|label="设置"/);
  for (const label of ["资产中心", "能力中心", "运行详情", "设置"]) {
    assert.match(floatBar, new RegExp(`aria-label="${label}"`));
  }
  // 整条搬出画布，画布卸载了它也还在
  assert.doesNotMatch(canvasView, /canvas-float-bar|canvas-float-nav/);
  assert.match(appShell, /<CanvasFloatBar[\s\S]*?currentView=\{os\.view\}/);
  // 同一排、同一套按钮样式，不再单独定义一遍尺寸
  assert.match(styles, /\.canvas-float-bar > button \{/);
  assert.doesNotMatch(styles, /\.canvas-float-nav,\r?\n\./);

  assert.match(floatBar, /onClick=\{\(\) => onAction\("assets"\)\}/);
  assert.match(floatBar, /onClick=\{\(\) => onAction\("capabilities"\)\}/);
  assert.match(floatBar, /onClick=\{\(\) => onAction\("task-center"\)\}/);
  assert.match(floatBar, /onClick=\{\(\) => onAction\("settings"\)\}/);
  assert.match(appShell, /case "assets":[\s\S]*?os\.setView\("assets"\);/);
  assert.match(appShell, /case "capabilities":[\s\S]*?os\.setView\("capabilities"\);/);
  // 这两屏现在也带浮条，按钮就压在弹层上，所以再点一次要能收掉
  assert.match(appShell, /case "task-center":[\s\S]*?setTaskCenterOpen\(\(open\) => !open\);/);
  assert.match(appShell, /case "settings":[\s\S]*?setSettingsOpen\(\(open\) => !open\);/);
  // 导航条不再需要这三个入参，画布也不再替浮条持有弹层状态
  assert.doesNotMatch(canvasToolbar, /taskCenterOpen|onOpenSettings|onOpenTaskCenter/);
  assert.doesNotMatch(canvasView, /taskCenterOpen|onOpenTaskCenter|onOpenSettings/);
  assert.match(floatBar, /className=\{"canvas-float-nav" \+ \(taskCenterOpen \? " is-active" : ""\)\}/);
});

test("the float bar centres on the window without a dock compensation", async () => {
  const styles = await source("app/globals.css");

  // 它是 fixed 相对视口，50% 本身就是窗口中线，旧的那条补半个对话面板宽度的规则要删干净
  assert.match(
    styles,
    /\.canvas-float-bar \{\s*position: fixed;\s*z-index: 370;\s*bottom: 28px;\s*left: 50%;/,
  );
  assert.doesNotMatch(styles, /\.canvas-view\.is-intent-docked \.canvas-float-bar/);
});

test("the conversation no longer offers a full-window collapse mode", async () => {
  const [styles, canvasView, intentConsole] = await Promise.all([
    source("app/globals.css"),
    source("app/components/canvas-view.tsx"),
    source("app/components/intent-console.tsx"),
  ]);

  // 老板判定「全」这一档多余：画布永远占屏，收起态的 CSS 与档位状态机一起删掉
  assert.doesNotMatch(styles, /is-canvas-collapsed/);
  assert.doesNotMatch(canvasView, /canvasCollapsed|dockMode|DockMode/);
  assert.doesNotMatch(canvasView, /selectDockMode|expandCanvasPane|paneModeRef/);
  assert.doesNotMatch(intentConsole, /dockMode|DockMode/);

  // 对话栏始终是那条可拖的分栏
  assert.match(
    styles,
    /\.canvas-view > \.intent-dock \{[\s\S]*?flex: 0 0 clamp\(360px, var\(--intent-dock-width, 420px\), 680px\);/,
  );
});

test("the header keeps only the collapse button and drag still owns the width", async () => {
  const [intentConsole, canvasView, styles] = await Promise.all([
    source("app/components/intent-console.tsx"),
    source("app/components/canvas-view.tsx"),
    source("app/globals.css"),
  ]);

  // 折叠是独立维度，删档位不能把它一起带走
  assert.match(intentConsole, /label="折叠 Intent Console"/);
  assert.doesNotMatch(intentConsole, /aria-label="对话面板宽度"/);
  assert.doesNotMatch(intentConsole, /intent-dock-mode-group/);
  assert.doesNotMatch(styles, /\.intent-dock-mode-group \{/);
  // 宽度只能靠把手拖，或把手上 Home 回默认，不再有预设档按钮
  assert.match(canvasView, /setIntentDockWidth\(clampIntentDockWidth\(intentDockWidth \+ 16\)\)/);
  assert.match(canvasView, /setIntentDockWidth\(INTENT_DOCK_DEFAULT_WIDTH\)/);
  // 最窄一档和手动拖宽重叠，老板判定为多余，不能重新长回来
  assert.doesNotMatch(intentConsole, /"narrow"/);
  assert.doesNotMatch(intentConsole, /label="最窄"/);
  assert.doesNotMatch(intentConsole, /label="展开画布"/);
  assert.doesNotMatch(canvasView, /"narrow"/);
});

test("the float bar still shows inside the four screens it opens", async () => {
  const [styles, appShell] = await Promise.all([
    source("app/globals.css"),
    source("app/components/app-shell.tsx"),
  ]);

  // 运行详情和设置是 360 的全屏遮罩，浮条要压过它们才谈得上常驻
  assert.match(styles, /\.task-center-backdrop \{[\s\S]*?z-index: 360;/);
  assert.match(styles, /\.settings-backdrop \{[\s\S]*?z-index: 360;/);
  assert.match(styles, /\.canvas-float-bar \{\s*position: fixed;\s*z-index: 370;/);
  // 浮条必须和遮罩同级挂在壳上：留在 .app-main 里再高的 z-index 也出不去那层 fixed 上下文
  assert.match(
    appShell,
    /<\/main>[\s\S]*?<CanvasFloatBar[\s\S]*?\{taskCenterOpen && \(/,
  );
});
