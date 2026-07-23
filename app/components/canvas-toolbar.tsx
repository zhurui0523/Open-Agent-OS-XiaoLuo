"use client";

import {
  ArrowRight,
  Download,
  Eraser,
  ImagePlus,
  Hand,
  MousePointer2,
  Pencil,
  Play,
  Redo2,
  Square,
  Tag,
  TextCursorInput,
  Trash2,
  Undo2,
} from "lucide-react";
import type { NodeKind, RunState } from "../types";
import { IconButton } from "./icon-button";

interface CanvasToolbarProps {
  activeTool: string;
  runState: RunState;
  hasSelection: boolean;
  onToolChange: (tool: string) => void;
  onAddNode: (kind: NodeKind) => void;
  onRun: () => void;
  onDelete: () => void;
}

export function CanvasToolbar({
  activeTool,
  runState,
  hasSelection,
  onToolChange,
  onAddNode,
  onRun,
  onDelete,
}: CanvasToolbarProps) {
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="画布工具">
      <IconButton label="导入素材" onClick={() => onAddNode("image")}>
        <ImagePlus size={18} />
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
        label="画笔标注"
        active={activeTool === "draw"}
        onClick={() => onToolChange("draw")}
      >
        <Pencil size={18} />
      </IconButton>
      <IconButton
        label="连接节点"
        active={activeTool === "connect"}
        onClick={() => onToolChange("connect")}
      >
        <ArrowRight size={18} />
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
      <span className="tool-separator" />
      <IconButton
        label={runState === "running" ? "工作流执行中" : "运行工作流"}
        active={runState === "running"}
        onClick={onRun}
      >
        <Play size={18} fill={runState === "running" ? "currentColor" : "none"} />
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
  );
}
