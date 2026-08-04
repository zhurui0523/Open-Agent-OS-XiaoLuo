"use client";

import {
  Blocks,
  Hand,
  Library,
  ListTree,
  MousePointer2,
  PanelsTopLeft,
  Settings,
  WandSparkles,
} from "lucide-react";
import type { AppView } from "../types";
import { IconButton } from "./icon-button";

interface CanvasToolbarProps {
  currentView: AppView;
  activeTool: string;
  drawerOpen: boolean;
  taskCenterOpen: boolean;
  onToolChange: (tool: string) => void;
  onToggleDrawer: () => void;
  onOpenTaskCenter: () => void;
  onOpenSettings: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  currentView,
  activeTool,
  drawerOpen,
  taskCenterOpen,
  onToolChange,
  onToggleDrawer,
  onOpenTaskCenter,
  onOpenSettings,
  onNavigate,
}: CanvasToolbarProps) {
  function chooseCanvasTool(tool: string) {
    onToolChange(tool);
    onNavigate("canvas");
  }

  return (
    <nav className="canvas-toolbar" aria-label="主导航">
      <IconButton
        label="选择工具"
        active={currentView === "canvas" && activeTool === "select"}
        onClick={() => chooseCanvasTool("select")}
      >
        <MousePointer2 size={18} />
      </IconButton>
      <IconButton
        label="抓手平移"
        active={currentView === "canvas" && activeTool === "hand"}
        onClick={() => chooseCanvasTool("hand")}
      >
        <Hand size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton
        label="进入灵境画布"
        active={currentView === "canvas"}
        onClick={() => onNavigate("canvas")}
      >
        <WandSparkles size={18} />
      </IconButton>
      <IconButton
        label={drawerOpen ? "收起画布管理" : "打开画布管理"}
        active={currentView === "canvas" && drawerOpen}
        onClick={onToggleDrawer}
      >
        <PanelsTopLeft size={18} />
      </IconButton>
      <IconButton
        label="打开资产中心"
        active={currentView === "assets"}
        onClick={() => onNavigate("assets")}
      >
        <Library size={18} />
      </IconButton>
      <IconButton
        label="打开能力中心"
        active={currentView === "capabilities"}
        onClick={() => onNavigate("capabilities")}
      >
        <Blocks size={18} />
      </IconButton>
      <IconButton
        label="运行详情"
        active={taskCenterOpen}
        onClick={onOpenTaskCenter}
      >
        <ListTree size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton label="设置" onClick={onOpenSettings}>
        <Settings size={18} />
      </IconButton>
    </nav>
  );
}
