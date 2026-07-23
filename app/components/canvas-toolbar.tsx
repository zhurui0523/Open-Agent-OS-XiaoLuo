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
  activeTool: string;
  runState: RunState;
  onToolChange: (tool: string) => void;
  onRun: () => void;
  onOpenDrawer: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  activeTool,
  runState,
  onToolChange,
  onRun,
  onOpenDrawer,
  onNavigate,
}: CanvasToolbarProps) {
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
      <IconButton label="打开画布管理" onClick={onOpenDrawer}>
        <PanelsTopLeft size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton
        label="选择工具"
        active={activeTool === "select"}
        onClick={() => onToolChange("select")}
      >
        <MousePointer2 size={18} />
      </IconButton>
      <IconButton
        label="抓手平移"
        active={activeTool === "hand"}
        onClick={() => onToolChange("hand")}
      >
        <Hand size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton
        label="打开资产中心"
        onClick={() => onNavigate("assets")}
      >
        <Library size={18} />
      </IconButton>
      <IconButton
        label="打开能力中心"
        onClick={() => onNavigate("capabilities")}
      >
        <Blocks size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton
        label={runState === "running" ? "工作流执行中" : "运行工作流"}
        active={runState === "running"}
        onClick={onRun}
      >
        <Play size={18} fill={runState === "running" ? "currentColor" : "none"} />
      </IconButton>
    </div>
  );
}
