"use client";

import {
  Blocks,
  Hand,
  Library,
  ListTree,
  MousePointer2,
  PanelsTopLeft,
  Play,
  Settings,
  WandSparkles,
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
  onOpenSettings: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  currentView,
  activeTool,
  runState,
  onToolChange,
  onRun,
  onOpenDrawer,
  onOpenSettings,
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
        label="进入灵境画布"
        active={currentView === "canvas"}
        onClick={() => onNavigate("canvas")}
      >
        <WandSparkles size={18} />
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
        active={currentView === "runs"}
        onClick={() => onNavigate("runs")}
      >
        <ListTree size={18} />
      </IconButton>
      <span className="tool-separator" />
      <IconButton
        label={
          runState === "waiting"
            ? "等待第三方模型结果"
            : runState === "running"
              ? "工作流执行中"
              : "运行工作流"
        }
        active={runState === "running" || runState === "waiting"}
        onClick={runCanvas}
      >
        <Play
          size={18}
          fill={
            runState === "running" || runState === "waiting"
              ? "currentColor"
              : "none"
          }
        />
      </IconButton>
      <span className="tool-separator" />
      <IconButton label="设置" onClick={onOpenSettings}>
        <Settings size={18} />
      </IconButton>
    </nav>
  );
}
