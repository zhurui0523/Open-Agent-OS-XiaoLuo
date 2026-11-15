"use client";

import {
  ListChecks,
  MousePointer2,
  PanelsTopLeft,
  WandSparkles,
} from "lucide-react";
import type { AppView } from "../types";
import { IconButton } from "./icon-button";

interface CanvasToolbarProps {
  currentView: AppView;
  activeTool: string;
  drawerOpen: boolean;
  onToolChange: (tool: string) => void;
  onToggleMultiSelect: () => void;
  onToggleDrawer: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  currentView,
  activeTool,
  drawerOpen,
  onToolChange,
  onToggleMultiSelect,
  onToggleDrawer,
  onNavigate,
}: CanvasToolbarProps) {
  function chooseCanvasTool(tool: string) {
    onToolChange(tool);
    onNavigate("canvas");
  }

  function toggleMultiSelect() {
    onToggleMultiSelect();
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
        label={activeTool === "multi-select" ? "退出多选" : "多选"}
        active={currentView === "canvas" && activeTool === "multi-select"}
        onClick={toggleMultiSelect}
      >
        <ListChecks size={18} />
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
    </nav>
  );
}
