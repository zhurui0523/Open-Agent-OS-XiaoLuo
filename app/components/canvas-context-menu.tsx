"use client";

import {
  Check,
  AudioLines,
  ChevronRight,
  Copy,
  Clock3,
  FileText,
  FileOutput,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  MousePointer2,
  Puzzle,
  Redo2,
  Shapes,
  Undo2,
  Upload,
  Video,
  Workflow,
  ClipboardPaste,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Capability,
  InstalledPackage,
  NodeKind,
} from "../types";

type ArrangeMode = "free" | "time" | "type";
type SubmenuName = "professional" | "plugin" | "arrange";

interface CanvasContextMenuProps {
  x: number;
  y: number;
  opensLeft: boolean;
  capabilities: Capability[];
  packages: InstalledPackage[];
  canUndo: boolean;
  canRedo: boolean;
  canCopy: boolean;
  multiSelectActive: boolean;
  arrangeMode: ArrangeMode;
  onAddNode: (kind: NodeKind) => void;
  onAddCapability: (capability: Capability) => void;
  onAddPlugin: (plugin: InstalledPackage) => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onToggleMultiSelect: () => void;
  onArrange: (mode: ArrangeMode) => void;
  onUpload: () => void;
  onOpenExtensions: () => void;
  onClose: () => void;
}

export function CanvasContextMenu({
  x,
  y,
  opensLeft,
  capabilities,
  packages,
  canUndo,
  canRedo,
  canCopy,
  multiSelectActive,
  arrangeMode,
  onAddNode,
  onAddCapability,
  onAddPlugin,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  onToggleMultiSelect,
  onArrange,
  onUpload,
  onOpenExtensions,
  onClose,
}: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] =
    useState<SubmenuName | null>(null);
  const professionalCapabilities = useMemo(
    () =>
      capabilities.filter(
        (capability) =>
          capability.enabled &&
          ["SKILL", "Agent", "Workflow"].includes(capability.category),
      ),
    [capabilities],
  );
  const pluginPackages = useMemo(
    () =>
      packages.filter(
        (item) => item.enabled && item.packageType === "plugin",
      ),
    [packages],
  );

  useEffect(() => {
    menuRef.current?.focus();
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  function run(action: () => void) {
    action();
    onClose();
  }

  function submenuClass(name: SubmenuName) {
    return [
      "canvas-context-submenu",
      activeSubmenu === name ? "is-open" : "",
      opensLeft ? "opens-left" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return (
    <div
      ref={menuRef}
      className="canvas-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      aria-label="画布右键菜单"
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(() => onAddNode("text"))}
      >
        <FileText size={19} />
        <span>文本占位卡片</span>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        disabled={!canRedo}
        onClick={() => run(onRedo)}
      >
        <Redo2 size={19} />
        <span>重做</span>
        <kbd>Ctrl+Y</kbd>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        disabled={!canCopy}
        onClick={() => run(onCopy)}
      >
        <Copy size={19} />
        <span>复制节点</span>
        <kbd>Ctrl+C</kbd>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(onPaste)}
      >
        <ClipboardPaste size={19} />
        <span>粘贴节点</span>
        <kbd>Ctrl+V</kbd>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(() => onAddNode("image"))}
      >
        <ImageIcon size={19} />
        <span>图片占位卡片</span>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(() => onAddNode("video"))}
      >
        <Video size={19} />
        <span>视频占位卡片</span>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(() => onAddNode("audio"))}
      >
        <AudioLines size={19} />
        <span>音频占位卡片</span>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(() => onAddNode("document"))}
      >
        <FileOutput size={19} />
        <span>文档占位卡片</span>
      </button>

      <div
        className="canvas-context-submenu-wrap"
        onPointerEnter={() => setActiveSubmenu("professional")}
        onPointerLeave={() => setActiveSubmenu(null)}
      >
        <button
          type="button"
          className="canvas-context-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === "professional"}
          onClick={() =>
            setActiveSubmenu((current) =>
              current === "professional" ? null : "professional",
            )
          }
        >
          <Workflow size={19} />
          <span>新建专业节点</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("professional")}
          role="menu"
          aria-label="专业节点"
        >
          {professionalCapabilities.length ? (
            professionalCapabilities.map((capability) => (
              <button
                key={capability.id}
                type="button"
                className="canvas-context-item"
                role="menuitem"
                onClick={() => run(() => onAddCapability(capability))}
              >
                <Workflow size={17} />
                <span>
                  {capability.title}
                  <small>{capability.modality}</small>
                </span>
              </button>
            ))
          ) : (
            <button
              type="button"
              className="canvas-context-item"
              role="menuitem"
              onClick={() => run(onOpenExtensions)}
            >
              <Puzzle size={17} />
              <span>
                添加专业能力
                <small>前往能力中心</small>
              </span>
            </button>
          )}
        </div>
      </div>

      <div
        className="canvas-context-submenu-wrap"
        onPointerEnter={() => setActiveSubmenu("plugin")}
        onPointerLeave={() => setActiveSubmenu(null)}
      >
        <button
          type="button"
          className="canvas-context-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === "plugin"}
          onClick={() =>
            setActiveSubmenu((current) =>
              current === "plugin" ? null : "plugin",
            )
          }
        >
          <Puzzle size={19} />
          <span>添加 AI 插件卡片</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("plugin")}
          role="menu"
          aria-label="AI 插件卡片"
        >
          {pluginPackages.length ? (
            pluginPackages.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className="canvas-context-item"
                role="menuitem"
                onClick={() => run(() => onAddPlugin(plugin))}
              >
                <Puzzle size={17} />
                <span>
                  {plugin.name}
                  <small>{plugin.runtimeType}</small>
                </span>
              </button>
            ))
          ) : (
            <button
              type="button"
              className="canvas-context-item"
              role="menuitem"
              onClick={() => run(onOpenExtensions)}
            >
              <Puzzle size={17} />
              <span>
                安装 AI 插件
                <small>前往能力中心</small>
              </span>
            </button>
          )}
        </div>
      </div>

      <span className="canvas-context-separator" role="separator" />

      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        disabled={!canUndo}
        onClick={() => run(onUndo)}
      >
        <Undo2 size={19} />
        <span>撤销</span>
        <kbd>Ctrl+Z</kbd>
      </button>
      <button
        type="button"
        className={`canvas-context-item ${multiSelectActive ? "is-active" : ""}`}
        role="menuitemcheckbox"
        aria-checked={multiSelectActive}
        onClick={() => run(onToggleMultiSelect)}
      >
        <ListChecks size={19} />
        <span>{multiSelectActive ? "退出多选" : "多选"}</span>
        {multiSelectActive && <Check size={17} />}
      </button>

      <div
        className="canvas-context-submenu-wrap"
        onPointerEnter={() => setActiveSubmenu("arrange")}
        onPointerLeave={() => setActiveSubmenu(null)}
      >
        <button
          type="button"
          className="canvas-context-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === "arrange"}
          onClick={() =>
            setActiveSubmenu((current) =>
              current === "arrange" ? null : "arrange",
            )
          }
        >
          <Layers3 size={19} />
          <span>自动整理</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("arrange")}
          role="menu"
          aria-label="自动整理"
        >
          <button
            type="button"
            className={`canvas-context-item ${arrangeMode === "free" ? "is-active" : ""}`}
            role="menuitemradio"
            aria-checked={arrangeMode === "free"}
            onClick={() => run(() => onArrange("free"))}
          >
            <MousePointer2 size={17} />
            <span>
              自由画布
              <small>保留当前自由拖拽位置</small>
            </span>
            {arrangeMode === "free" && <Check size={16} />}
          </button>
          <button
            type="button"
            className={`canvas-context-item ${arrangeMode === "time" ? "is-active" : ""}`}
            role="menuitemradio"
            aria-checked={arrangeMode === "time"}
            onClick={() => run(() => onArrange("time"))}
          >
            <Clock3 size={17} />
            <span>
              时间排序
              <small>按节点创建顺序排列</small>
            </span>
            {arrangeMode === "time" && <Check size={16} />}
          </button>
          <button
            type="button"
            className={`canvas-context-item ${arrangeMode === "type" ? "is-active" : ""}`}
            role="menuitemradio"
            aria-checked={arrangeMode === "type"}
            onClick={() => run(() => onArrange("type"))}
          >
            <Shapes size={17} />
            <span>
              类型排序
              <small>文本、图片、视频、音频、文档分组</small>
            </span>
            {arrangeMode === "type" && <Check size={16} />}
          </button>
        </div>
      </div>

      <span className="canvas-context-separator" role="separator" />

      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(onUpload)}
      >
        <Upload size={19} />
        <span>上传</span>
      </button>
    </div>
  );
}
