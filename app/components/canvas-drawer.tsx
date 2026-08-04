"use client";

import {
  Pencil,
  PanelLeftClose,
  Plus,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { CanvasSummary } from "../types";
import { useAppDialog } from "./app-dialog";
import { IconButton } from "./icon-button";

interface CanvasDrawerProps {
  open: boolean;
  activeCanvasId: string;
  canvases: CanvasSummary[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onShare: (id: string, title: string) => void;
  onDelete: (id: string) => Promise<void>;
}

export function CanvasDrawer({
  open,
  activeCanvasId,
  canvases,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onShare,
  onDelete,
}: CanvasDrawerProps) {
  const dialog = useAppDialog();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "nodes">("recent");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const manageableCanvasCount = canvases.filter(
    (canvas) => canvas.canManage !== false,
  ).length;
  const visibleCanvases = useMemo(() => {
    const filtered = canvases.filter((canvas) =>
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
        Date.parse(second.updatedAt) - Date.parse(first.updatedAt),
    );
  }, [canvases, query, sort]);
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
    <aside
      className={`canvas-drawer ${open ? "is-open" : "is-closed"}`}
      aria-label="画布管理"
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <div className="drawer-heading">
        <strong>画布管理</strong>
        <IconButton label="收起画布管理" onClick={onClose}>
          <PanelLeftClose size={17} />
        </IconButton>
      </div>

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
        <span>画布</span>
        <button
          type="button"
          aria-label="新建画布"
          title="新建画布"
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
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
                  {canvas.enterpriseShared && <em>企业协作</em>}
                </span>
                <small>
                  {canvas.nodes} 个节点 ·{" "}
                  {new Date(canvas.updatedAt).toLocaleString("zh-CN")}
                </small>
              </span>
            </button>
            {canvas.canManage !== false && (
              <div className="canvas-item-actions">
              <button
                type="button"
                aria-label="修改画布名称"
                title="修改名称"
                disabled={busy === canvas.id}
                onClick={async () => {
                  const title = (
                    await dialog.prompt("修改画布的显示名称。", {
                      title: "修改画布名称",
                      inputLabel: "画布名称",
                      defaultValue: canvas.title,
                      confirmText: "保存名称",
                    })
                  )?.trim();
                  if (title && title !== canvas.title) {
                    void act(canvas.id, () => onRename(canvas.id, title));
                  }
                }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                aria-label="共享画布"
                title="共享"
                disabled={busy === canvas.id}
                onClick={() => onShare(canvas.id, canvas.title)}
              >
                <Share2 size={13} />
              </button>
              <button
                type="button"
                aria-label="删除画布"
                title={
                  manageableCanvasCount <= 1 ? "至少保留一张画布" : "删除画布"
                }
                disabled={busy === canvas.id || manageableCanvasCount <= 1}
                onClick={async () => {
                  if (await dialog.confirm(
                    `画布“${canvas.title}”将从当前列表中移除。`,
                    {
                      title: "删除画布",
                      confirmText: "删除画布",
                      tone: "danger",
                    },
                  )) {
                    void act(canvas.id, () => onDelete(canvas.id));
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
              </div>
            )}
          </article>
        ))}
        {!visibleCanvases.length && (
          <div className="drawer-empty">没有匹配的画布</div>
        )}
      </div>
    </aside>
  );
}
