"use client";

import {
  Check,
  AudioLines,
  BoxSelect,
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
  Trash2,
  Shapes,
  Undo2,
  Upload,
  Video,
  Workflow,
  ClipboardPaste,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { packageInstallStatus } from "../lib/package-install-status";
import type {
  InstalledPackage,
  NodeKind,
} from "../types";

type ArrangeMode = "free" | "time" | "type";
type SubmenuName = "node" | "placeholder" | "plugin" | "arrange";

interface CanvasContextMenuProps {
  x: number;
  y: number;
  opensLeft: boolean;
  packages: InstalledPackage[];
  canUndo: boolean;
  canRedo: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDelete: boolean;
  multiSelectActive: boolean;
  arrangeMode: ArrangeMode;
  onAddNode: (kind: NodeKind) => void;
  onAddPlaceholder: (kind: NodeKind) => void;
  onAddPlugin: (plugin: InstalledPackage) => void | Promise<void>;
  onAddGroup: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onDelete: () => void | Promise<void>;
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
  packages,
  canUndo,
  canRedo,
  canCopy,
  canPaste,
  canDelete,
  multiSelectActive,
  arrangeMode,
  onAddNode,
  onAddPlaceholder,
  onAddPlugin,
  onAddGroup,
  onUndo,
  onRedo,
  onCopy,
  onDelete,
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
  const pluginPackages = useMemo(
    () =>
      packages
        .filter(
          (item) =>
            item.packageType === "plugin" &&
            item.lifecycleState !== "uninstalled",
        )
        .sort((first, second) => first.name.localeCompare(second.name, "zh-CN")),
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

  function run(action: () => void | Promise<void>) {
    void action();
    onClose();
  }

  function pluginUnavailableReason(plugin: InstalledPackage) {
    const installStatus = packageInstallStatus(plugin);
    if (!installStatus.available) {
      return `${installStatus.label} · ${installStatus.detail}`;
    }
    const rejectedOrRevoked =
      ["rejected", "revoked"].includes(plugin.trustState ?? "") ||
      ["rejected", "revoked"].includes(plugin.lifecycleState ?? "");
    const quarantined =
      plugin.trustState === "quarantined" ||
      plugin.lifecycleState === "quarantined";
    if (
      rejectedOrRevoked ||
      (quarantined && plugin.runtimeType !== "sandbox-ui")
    ) {
      return "安全审核未通过，无法添加";
    }
    return null;
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
        disabled={!canCopy}
        onClick={() => run(onCopy)}
      >
        <Copy size={19} />
        <span>复制</span>
        <kbd>Ctrl+C</kbd>
      </button>
      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        disabled={!canPaste}
        onClick={() => run(onPaste)}
      >
        <ClipboardPaste size={19} />
        <span>粘贴</span>
        <kbd>Ctrl+V</kbd>
      </button>
      {canDelete && (
        <button
          type="button"
          className="canvas-context-item is-danger"
          role="menuitem"
          onClick={() => run(onDelete)}
        >
          <Trash2 size={19} />
          <span>删除</span>
          <kbd>Delete</kbd>
        </button>
      )}
      <span className="canvas-context-separator" role="separator" />

      <button
        type="button"
        className="canvas-context-item"
        role="menuitem"
        onClick={() => run(onAddGroup)}
      >
        <BoxSelect size={19} />
        <span>新建节点群区域</span>
      </button>

      <div
        className="canvas-context-submenu-wrap"
        onPointerEnter={() => setActiveSubmenu("node")}
        onPointerLeave={() => setActiveSubmenu(null)}
      >
        <button
          type="button"
          className="canvas-context-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === "node"}
          onClick={() =>
            setActiveSubmenu((current) =>
              current === "node" ? null : "node",
            )
          }
        >
          <Workflow size={19} />
          <span>新建节点</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("node")}
          role="menu"
          aria-label="新建节点"
        >
          <span className="canvas-context-submenu-label">基础节点</span>
          {([
            ["text", "文本节点", FileText],
            ["image", "图片节点", ImageIcon],
            ["video", "视频节点", Video],
            ["audio", "音频节点", AudioLines],
            ["document", "文档节点", FileOutput],
          ] as const).map(([kind, label, Icon]) => (
            <button
              key={kind}
              type="button"
              className="canvas-context-item"
              role="menuitem"
              onClick={() => run(() => onAddNode(kind))}
            >
              <Icon size={17} />
              <span>
                {label}
                    <small>仅创建执行节点</small>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div
        className="canvas-context-submenu-wrap"
        onPointerEnter={() => setActiveSubmenu("placeholder")}
        onPointerLeave={() => setActiveSubmenu(null)}
      >
        <button
          type="button"
          className="canvas-context-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={activeSubmenu === "placeholder"}
          onClick={() =>
            setActiveSubmenu((current) =>
              current === "placeholder" ? null : "placeholder",
            )
          }
        >
          <FileOutput size={19} />
          <span>新建占位卡片</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("placeholder")}
          role="menu"
          aria-label="新建占位卡片"
        >
          {([
            ["text", "文本占位卡片", FileText],
            ["image", "图片占位卡片", ImageIcon],
            ["video", "视频占位卡片", Video],
            ["audio", "音频占位卡片", AudioLines],
            ["document", "文档占位卡片", FileOutput],
          ] as const).map(([kind, label, Icon]) => (
            <button
              key={kind}
              type="button"
              className="canvas-context-item"
              role="menuitem"
              onClick={() => run(() => onAddPlaceholder(kind))}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
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
          <span>添加插件</span>
          <ChevronRight size={17} />
        </button>
        <div
          className={submenuClass("plugin")}
          role="menu"
          aria-label="已安装插件"
        >
          {pluginPackages.length ? (
            pluginPackages.map((plugin) => {
              const unavailableReason = pluginUnavailableReason(plugin);
              return (
                <button
                  key={plugin.id}
                  type="button"
                  className="canvas-context-item"
                  role="menuitem"
                  disabled={Boolean(unavailableReason)}
                  onClick={() => run(() => onAddPlugin(plugin))}
                >
                  <Puzzle size={17} />
                  <span>
                    {plugin.name}
                    <small>
                      {unavailableReason ??
                        (plugin.enabled
                          ? `已安装 · ${plugin.runtimeType}`
                          : plugin.trustState === "quarantined" ||
                              plugin.lifecycleState === "quarantined"
                            ? "点击后安全复核并添加"
                            : "点击后自动启用并添加")}
                    </small>
                  </span>
                </button>
              );
            })
          ) : (
            <button
              type="button"
              className="canvas-context-item"
              role="menuitem"
              onClick={() => run(onOpenExtensions)}
            >
              <Puzzle size={17} />
              <span>
                安装插件
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
        className={`canvas-context-item ${multiSelectActive ? "is-active" : ""}`}
        role="menuitemcheckbox"
        aria-checked={multiSelectActive}
        onClick={() => run(onToggleMultiSelect)}
      >
        <ListChecks size={19} />
        <span>{multiSelectActive ? "退出多选" : "多选"}</span>
        <kbd>Ctrl+M</kbd>
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
