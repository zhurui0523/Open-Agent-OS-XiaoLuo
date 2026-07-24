"use client";

import {
  ChevronLeft,
  Ellipsis,
  FolderOpen,
  PanelLeftClose,
  Plus,
  Search,
  Star,
} from "lucide-react";
import type { CanvasSummary } from "../types";
import { IconButton } from "./icon-button";

interface CanvasDrawerProps {
  open: boolean;
  activeCanvasId: string;
  canvases: CanvasSummary[];
  workspaceName: string;
  projectName: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

export function CanvasDrawer({
  open,
  activeCanvasId,
  canvases,
  workspaceName,
  projectName,
  onClose,
  onSelect,
  onCreate,
}: CanvasDrawerProps) {
  if (!open) return null;

  return (
    <aside className="canvas-drawer" aria-label="画布管理">
      <div className="drawer-heading">
        <div>
          <span className="eyebrow">工作空间</span>
          <strong>{workspaceName || "云端工作空间"}</strong>
        </div>
        <IconButton label="收起画布管理" onClick={onClose}>
          <PanelLeftClose size={17} />
        </IconButton>
      </div>

      <button type="button" className="project-switcher">
        <span className="project-icon">
          <FolderOpen size={16} />
        </span>
        <span>
          <small>当前项目</small>
          <b>{projectName || "正在加载"}</b>
        </span>
        <ChevronLeft size={16} className="rotate-down" />
      </button>

      <label className="drawer-search">
        <Search size={15} aria-hidden="true" />
        <input aria-label="搜索画布" placeholder="搜索画布" />
        <kbd>⌘ K</kbd>
      </label>

      <div className="drawer-section-heading">
        <span>最近画布</span>
        <button
          type="button"
          aria-label="新建画布"
          title="新建画布"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="canvas-list">
        {canvases.map((canvas) => (
          <button
            type="button"
            key={canvas.id}
            className={`canvas-list-item ${canvas.id === activeCanvasId ? "is-active" : ""}`}
            onClick={() => onSelect(canvas.id)}
          >
            <span className="canvas-thumbnail" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="canvas-list-copy">
              <span>
                <b>{canvas.title}</b>
                {canvas.starred && <Star size={12} fill="currentColor" />}
              </span>
              <small>
                {canvas.nodes} 个节点 · {new Date(canvas.updatedAt).toLocaleString("zh-CN")}
              </small>
            </span>
            <Ellipsis size={16} className="canvas-more" aria-hidden="true" />
          </button>
        ))}
      </div>

    </aside>
  );
}
