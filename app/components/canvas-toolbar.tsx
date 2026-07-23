"use client";

import {
  Blocks,
  Hand,
  Library,
  MousePointer2,
  PanelsTopLeft,
  Play,
} from "lucide-react";
import type { AppView, RunState } from "../types";
import { IconButton } from "./icon-button";

interface CanvasToolbarProps {
  currentView: AppView;
  activeTool: string;
  runState: RunState;
  onToolChange: (tool: string) => void;
  onRun: () => void;
  onOpenDrawer: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  currentView,
  activeTool,
  runState,
  onToolChange,
  onRun,
  onOpenDrawer,
  onNavigate,
}: CanvasToolbarProps) {
  function chooseCanvasTool(tool: string) {
    onToolChange(tool);
    onNavigate("canvas");
  }

  function runCanvas() {
    onNavigate("canvas");
    onRun();
  }

  return (
    <nav className="canvas-toolbar" aria-label="主导航">
      <IconButton label="打开画布管理" onClick={onOpenDrawer}>
        <PanelsTopLeft size={18} />
      </IconButton>
      <span className="tool-separator" />
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
      <span className="tool-separator" />
      <IconButton
        label={runState === "running" ? "工作流执行中" : "运行工作流"}
        active={runState === "running"}
        onClick={runCanvas}
      >
        <Play size={18} fill={runState === "running" ? "currentColor" : "none"} />
      </IconButton>
    </nav>
  );
}
