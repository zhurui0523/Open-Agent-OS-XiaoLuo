"use client";

import {
  AppWindow,
  Blocks,
  Frame,
  Library,
  ListTree,
  Puzzle,
  Settings,
} from "lucide-react";
import type { AppView } from "../types";

/** 七颗按钮只报意图，互斥与切屏逻辑都在宿主 */
export type FloatBarAction =
  | "brain-dock"
  | "canvas-surface"
  | "plugins-hub"
  | "assets"
  | "capabilities"
  | "task-center"
  | "settings";

interface CanvasFloatBarProps {
  currentView: AppView;
  brainDockOpen: boolean;
  pluginsHubOpen: boolean;
  taskCenterOpen: boolean;
  settingsOpen: boolean;
  onAction: (action: FloatBarAction) => void;
}

/**
 * 底部居中浮条。它挂在 .app-shell 上而不是画布里，所以资产中心、能力中心、运行详情、设置
 * 这几屏也看得到、点得到；左边三颗选当前哪一屏，右边四颗是原来左侧导航条上的入口。
 */
export function CanvasFloatBar({
  currentView,
  brainDockOpen,
  pluginsHubOpen,
  taskCenterOpen,
  settingsOpen,
  onAction,
}: CanvasFloatBarProps) {
  const onCanvas = currentView === "canvas";

  return (
    <div className="canvas-float-bar">
      <button
        type="button"
        className={
          "brain-dock-float" +
          (onCanvas && brainDockOpen && !pluginsHubOpen ? " is-active" : "")
        }
        title="小逻结果面板"
        aria-label="小逻结果面板"
        onClick={() => onAction("brain-dock")}
      >
        <AppWindow size={18} />
      </button>

      <button
        type="button"
        className={
          "canvas-surface-float" +
          (onCanvas && !brainDockOpen && !pluginsHubOpen ? " is-active" : "")
        }
        title="画布"
        aria-label="画布"
        onClick={() => onAction("canvas-surface")}
      >
        <Frame size={18} />
      </button>

      <button
        type="button"
        className={
          "dock-plugins-float" +
          (onCanvas && pluginsHubOpen ? " is-active" : "")
        }
        title="插件台：把插件面板固定到这一屏"
        aria-label="插件台"
        onClick={() => onAction("plugins-hub")}
      >
        <Puzzle size={18} />
      </button>

      <button
        type="button"
        className={"canvas-float-nav" + (currentView === "assets" ? " is-active" : "")}
        title="资产中心"
        aria-label="资产中心"
        onClick={() => onAction("assets")}
      >
        <Library size={18} />
      </button>

      <button
        type="button"
        className={"canvas-float-nav" + (currentView === "capabilities" ? " is-active" : "")}
        title="能力中心"
        aria-label="能力中心"
        onClick={() => onAction("capabilities")}
      >
        <Blocks size={18} />
      </button>

      <button
        type="button"
        className={"canvas-float-nav" + (taskCenterOpen ? " is-active" : "")}
        title="运行详情"
        aria-label="运行详情"
        onClick={() => onAction("task-center")}
      >
        <ListTree size={18} />
      </button>

      <button
        type="button"
        className={"canvas-float-nav" + (settingsOpen ? " is-active" : "")}
        title="设置"
        aria-label="设置"
        onClick={() => onAction("settings")}
      >
        <Settings size={18} />
      </button>
    </div>
  );
}
