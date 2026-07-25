"use client";

import {
  ChevronLeft,
  Archive,
  Copy,
  FolderOpen,
  Pencil,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CanvasSummary } from "../types";
import { CanvasVersionPanel } from "./canvas-version-panel";
import { IconButton } from "./icon-button";

interface CanvasDrawerProps {
  open: boolean;
  activeCanvasId: string;
  projectId: string;
  canvases: CanvasSummary[];
  workspaceName: string;
  projectName: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (id: string, title: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onStar: (id: string, starred: boolean) => Promise<void>;
  onCreateSnapshot: (label?: string) => Promise<void>;
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

export function CanvasDrawer({
  open,
  activeCanvasId,
  projectId,
  canvases,
  workspaceName,
  projectName,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onArchive,
  onDelete,
  onDuplicate,
  onRestore,
  onStar,
  onCreateSnapshot,
  onRestoreSnapshot,
}: CanvasDrawerProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "nodes">("recent");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [state, setState] = useState<"active" | "archived" | "deleted">("active");
  const [inactiveCanvases, setInactiveCanvases] = useState<CanvasSummary[]>([]);
  const sourceCanvases = state === "active" ? canvases : inactiveCanvases;
  useEffect(() => {
    if (!open || state === "active" || !projectId) return;
    let active = true;
    void fetch(
      `/api/v2/canvases?projectId=${encodeURIComponent(projectId)}&state=${state}`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as {
          canvases?: CanvasSummary[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "读取画布失败");
        if (active) setInactiveCanvases(payload.canvases ?? []);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "读取画布失败");
        }
      });
    return () => {
      active = false;
    };
  }, [open, projectId, state]);
  const visibleCanvases = useMemo(() => {
    const filtered = sourceCanvases.filter((canvas) =>
      canvas.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
    if (sort === "name") {
      return [...filtered].sort((first, second) =>
        first.title.localeCompare(second.title, "zh-CN"),
      );
    }
    if (sort === "nodes") {
      return [...filtered].sort((first, second) => second.nodes - first.nodes);
    }
    return [...filtered].sort(
      (first, second) =>
        Number(second.starred) - Number(first.starred) ||
        Date.parse(second.updatedAt) - Date.parse(first.updatedAt),
    );
  }, [query, sort, sourceCanvases]);
  if (!open) return null;

  async function act(id: string, task: () => Promise<void>) {
    setBusy(id);
    setError("");
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "画布操作失败");
    } finally {
      setBusy("");
    }
  }

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
        <input
          aria-label="搜索画布"
          placeholder="搜索画布"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="画布排序"
          value={sort}
          onChange={(event) =>
            setSort(event.target.value as "recent" | "name" | "nodes")
          }
        >
          <option value="recent">最近</option>
          <option value="name">名称</option>
          <option value="nodes">节点数</option>
        </select>
      </label>

      <div className="drawer-section-heading">
        <span>{state === "active" ? "最近画布" : state === "archived" ? "已归档" : "回收站"}</span>
        <button
          type="button"
          aria-label="新建画布"
          title="新建画布"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="canvas-state-tabs" role="tablist" aria-label="画布状态">
        {([
          ["active", "使用中"],
          ["archived", "已归档"],
          ["deleted", "回收站"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={state === id}
            className={state === id ? "is-active" : ""}
            onClick={() => setState(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="drawer-inline-error">{error}</div>}

      <div className="canvas-list">
        {visibleCanvases.map((canvas) => (
          <article
            key={canvas.id}
            className={`canvas-list-item ${canvas.id === activeCanvasId ? "is-active" : ""}`}
          >
            <button
              type="button"
              className="canvas-list-main"
              disabled={state !== "active"}
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
            </button>
            <div className="canvas-item-actions">
              {state !== "active" ? (
                <button
                  type="button"
                  aria-label="恢复画布"
                  disabled={busy === canvas.id}
                  onClick={() =>
                    void act(canvas.id, async () => {
                      await onRestore(canvas.id);
                      setInactiveCanvases((current) =>
                        current.filter((item) => item.id !== canvas.id),
                      );
                    })
                  }
                >
                  <RotateCcw size={13} />
                </button>
              ) : (
                <>
              <button
                type="button"
                aria-label={canvas.starred ? "取消收藏" : "收藏画布"}
                disabled={busy === canvas.id}
                onClick={() =>
                  void act(canvas.id, () =>
                    onStar(canvas.id, !canvas.starred),
                  )
                }
              >
                <Star size={13} fill={canvas.starred ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                aria-label="重命名画布"
                disabled={busy === canvas.id}
                onClick={() => {
                  const title = window.prompt("画布名称", canvas.title)?.trim();
                  if (title && title !== canvas.title) {
                    void act(canvas.id, () => onRename(canvas.id, title));
                  }
                }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                aria-label="复制画布"
                disabled={busy === canvas.id}
                onClick={() =>
                  void act(canvas.id, () =>
                    onDuplicate(canvas.id, `${canvas.title} 副本`),
                  )
                }
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                aria-label="归档画布"
                disabled={busy === canvas.id}
                onClick={() =>
                  void act(canvas.id, () => onArchive(canvas.id))
                }
              >
                <Archive size={13} />
              </button>
              <button
                type="button"
                aria-label="删除画布"
                disabled={busy === canvas.id || canvases.length <= 1}
                onClick={() => {
                  if (window.confirm(`删除“${canvas.title}”？30 天内可恢复。`)) {
                    void act(canvas.id, () => onDelete(canvas.id));
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
                </>
              )}
            </div>
          </article>
        ))}
        {!visibleCanvases.length && <div className="drawer-empty">没有匹配的画布</div>}
      </div>

      {state === "active" && activeCanvasId && (
        <CanvasVersionPanel
          canvasId={activeCanvasId}
          onCreate={onCreateSnapshot}
          onRestore={onRestoreSnapshot}
        />
      )}
    </aside>
  );
}
