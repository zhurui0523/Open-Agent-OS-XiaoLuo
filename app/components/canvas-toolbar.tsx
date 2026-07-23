"use client";

import {
  ArrowRight,
  Blocks,
  Download,
  Eraser,
  ImagePlus,
  Hand,
  Library,
  MoreHorizontal,
  MousePointer2,
  PanelsTopLeft,
  Pencil,
  Play,
  Redo2,
  Square,
  Tag,
  TextCursorInput,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import type { AppView, NodeKind, RunState } from "../types";
import { IconButton } from "./icon-button";

interface CanvasToolbarProps {
  activeTool: string;
  runState: RunState;
  hasSelection: boolean;
  onToolChange: (tool: string) => void;
  onAddNode: (kind: NodeKind) => void;
  onRun: () => void;
  onDelete: () => void;
  onOpenDrawer: () => void;
  onNavigate: (view: AppView) => void;
}

export function CanvasToolbar({
  activeTool,
  runState,
  hasSelection,
  onToolChange,
  onAddNode,
  onRun,
  onDelete,
  onOpenDrawer,
  onNavigate,
}: CanvasToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);

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
      <IconButton
        label="导入素材"
        onClick={() => onAddNode("image")}
      >
        <ImagePlus size={18} />
      </IconButton>
      <IconButton
        label="添加卡片"
        active={activeTool === "card"}
        onClick={() => {
          onToolChange("card");
          onAddNode("text");
        }}
      >
        <Square size={18} />
      </IconButton>
      <IconButton
        label="连接节点"
        active={activeTool === "connect"}
        onClick={() => onToolChange("connect")}
      >
        <ArrowRight size={18} />
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
      <div className="canvas-toolbar-more">
        <IconButton
          label={moreOpen ? "收起更多工具" : "展开更多工具"}
          active={moreOpen}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((current) => !current)}
        >
          <MoreHorizontal size={18} />
        </IconButton>
        {moreOpen && (
          <div className="canvas-toolbar-menu" role="group" aria-label="更多画布工具">
            <IconButton
              label="画笔标注"
              active={activeTool === "draw"}
              onClick={() => onToolChange("draw")}
            >
              <Pencil size={18} />
            </IconButton>
            <IconButton label="添加标签">
              <Tag size={18} />
            </IconButton>
            <IconButton
              label="添加文本节点"
              active={activeTool === "text"}
              onClick={() => {
                onToolChange("text");
                onAddNode("text");
              }}
            >
              <TextCursorInput size={18} />
            </IconButton>
            <IconButton label="橡皮擦">
              <Eraser size={18} />
            </IconButton>
            <IconButton label="撤销">
              <Undo2 size={18} />
            </IconButton>
            <IconButton label="重做">
              <Redo2 size={18} />
            </IconButton>
            <IconButton label="导出画布">
              <Download size={18} />
            </IconButton>
            <IconButton
              label="删除选中节点"
              danger
              disabled={!hasSelection}
              onClick={onDelete}
            >
              <Trash2 size={18} />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}
