"use client";

import {
  Archive,
  AudioLines,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Grid2X2,
  HardDrive,
  Image as ImageIcon,
  LayoutList,
  MoreHorizontal,
  RotateCcw,
  Search,
  Star,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AssetKind,
  FileSystemAsset,
} from "../types";
import {
  SUPPORTED_FILE_GROUPS,
} from "../lib/file-formats";
import { AssetContentPreview } from "./asset-content-preview";
import { useAppDialog } from "./app-dialog";
import { IconButton } from "./icon-button";

const filters: Array<{ id: "all" | AssetKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "document", label: "文档" },
  { id: "text", label: "文本" },
  { id: "archive", label: "压缩包" },
];

const typeLabel: Record<AssetKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
  archive: "压缩包",
  other: "文件",
};

async function requestJson<T>(
  workspaceId: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const separator = url.includes("?") ? "&" : "?";
  const scopedUrl = `${url}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
  const response = await fetch(scopedUrl, init);
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error("上传内容超过传输上限，单个文件最大支持 100 MB");
    }
    throw new Error(payload.error ?? `文件系统请求失败：${response.status}`);
  }
  return payload;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function AssetGlyph({ kind, size = 28 }: { kind: AssetKind; size?: number }) {
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "video") return <Video size={size} />;
  if (kind === "audio") return <AudioLines size={size} />;
  if (kind === "archive") return <Archive size={size} />;
  if (kind === "document" || kind === "text") return <FileText size={size} />;
  return <FileIcon size={size} />;
}

function AssetMedia({
  asset,
  detail = false,
}: {
  asset: FileSystemAsset;
  detail?: boolean;
}) {
  if (asset.kind === "image") {
    return (
      <AssetContentPreview
        name={asset.name}
        kind={asset.kind}
        mimeType={asset.mimeType}
        contentUrl={asset.contentUrl}
        downloadUrl={asset.downloadUrl}
        compact={!detail}
      />
    );
  }
  if (detail) {
    return (
      <AssetContentPreview
        name={asset.name}
        kind={asset.kind}
        mimeType={asset.mimeType}
        contentUrl={asset.contentUrl}
        downloadUrl={asset.downloadUrl}
      />
    );
  }
  return (
    <span className={`asset-glyph file-kind-${asset.kind}`}>
      <AssetGlyph kind={asset.kind} size={detail ? 40 : 28} />
    </span>
  );
}

export function AssetsView({
  workspaceId,
  onAddToCanvas,
}: {
  workspaceId: string;
  onAddToCanvas?: (asset: FileSystemAsset) => void | Promise<void>;
}) {
  const dialog = useAppDialog();
  const [assets, setAssets] = useState<FileSystemAsset[]>([]);
  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [grid, setGrid] = useState(true);
  const [selected, setSelected] = useState<FileSystemAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState<"updated" | "name" | "size">("updated");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [formatsOpen, setFormatsOpen] = useState(false);

  useEffect(() => {
    if (!formatsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFormatsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [formatsOpen]);

  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  const visibleAssets = useMemo(() => {
    const filtered = assets.filter(
      (asset) => statusFilter === "all" || asset.status === statusFilter,
    );
    return [...filtered].sort((first, second) => {
      if (sort === "name") return first.name.localeCompare(second.name, "zh-CN");
      if (sort === "size") return second.size - first.size;
      return Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
    });
  }, [assets, sort, statusFilter]);

  const loadAssets = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (filter !== "all") params.set("kind", filter);
      if (trash) params.set("trash", "1");
      if (favoriteOnly) params.set("favorite", "1");
      if (cursor) params.set("cursor", cursor);
      const payload = await requestJson<{
        assets: FileSystemAsset[];
        nextCursor: string | null;
      }>(
        workspaceId,
        `/api/v2/files?${params}`,
      );
      setAssets((current) => cursor ? [...current, ...payload.assets] : payload.assets);
      setNextCursor(payload.nextCursor);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "文件列表加载失败",
      );
    } finally {
      setLoading(false);
    }
  }, [favoriteOnly, filter, query, trash, workspaceId]);

  useEffect(() => {
    const timeout = setTimeout(() => void loadAssets(), 160);
    return () => clearTimeout(timeout);
  }, [loadAssets]);

  async function updateAsset(
    asset: FileSystemAsset,
    patch: Record<string, unknown>,
  ) {
    setBusy("正在保存");
    try {
      const payload = await requestJson<{ asset: FileSystemAsset }>(
        workspaceId,
        "/api/v2/files",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: asset.id, ...patch }),
        },
      );
      setSelected(payload.asset);
      await loadAssets();
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : "文件更新失败",
      );
    } finally {
      setBusy("");
    }
  }

  async function renameAsset(asset: FileSystemAsset) {
    const name = await dialog.prompt("修改文件的显示名称。", {
      title: "重命名文件",
      inputLabel: "文件名称",
      defaultValue: asset.name,
      confirmText: "保存名称",
    });
    if (!name?.trim() || name.trim() === asset.name) return;
    await updateAsset(asset, { name });
  }

  async function permanentlyDelete(asset: FileSystemAsset) {
    if (
      !(await dialog.confirm(`“${asset.name}”将被永久删除，此操作不能撤销。`, {
        title: "永久删除文件",
        confirmText: "永久删除",
        tone: "danger",
      }))
    ) return;
    setBusy("正在永久删除");
    try {
      await requestJson(
        workspaceId,
        `/api/v2/files?id=${encodeURIComponent(asset.id)}`,
        { method: "DELETE" },
      );
      setSelected(null);
      await loadAssets();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "永久删除失败",
      );
    } finally {
      setBusy("");
    }
  }

  async function bulkUpdate(
    action: "trash" | "restore" | "favorite" | "tags",
    extra: Record<string, unknown> = {},
  ) {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(`正在批量处理 ${ids.length} 个文件`);
    try {
      await requestJson(workspaceId, "/api/v2/files/bulk", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, action, ...extra }),
      });
      setSelectedIds(new Set());
      await loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量操作失败");
    } finally {
      setBusy("");
    }
  }

  function bulkDownload() {
    const downloads = assets.filter((asset) => selectedIds.has(asset.id));
    downloads.forEach((asset, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = asset.downloadUrl;
        anchor.download = asset.name;
        anchor.rel = "noreferrer";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * 180);
    });
  }

  return (
    <section
      className="content-view assets-view file-system-view"
      aria-label="AI 文件系统"
    >
      <header className="content-header file-system-header">
        <div>
          <span className="eyebrow">ASSET KERNEL · VFS</span>
          <h1>AI 文件系统</h1>
        </div>
      </header>

      <div className="file-system-stats">
        <span><HardDrive size={15} /> 当前视图 {assets.length} 个文件</span>
        <span>{formatBytes(totalBytes)}</span>
        <button
          type="button"
          className="supported-formats-chip"
          onClick={() => setFormatsOpen(true)}
        >
          支持格式
        </button>
      </div>

      <div className="asset-toolbar file-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="文件类型">
          {filters.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={!trash && filter === item.id}
              key={item.id}
              className={!trash && filter === item.id ? "is-active" : ""}
              onClick={() => {
                setTrash(false);
                setFilter(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={trash}
            className={trash ? "is-active is-trash" : "is-trash"}
            onClick={() => setTrash(true)}
          >
            <Trash2 size={13} /> 回收站
          </button>
          <button
            type="button"
            className={favoriteOnly ? "is-active" : ""}
            onClick={() => setFavoriteOnly((current) => !current)}
          >
            收藏
          </button>
        </div>
        <div className="asset-actions">
          <label className="view-search">
            <Search size={16} />
            <input
              aria-label="搜索文件"
              placeholder="名称、标签或文本内容"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="view-toggle">
            <IconButton label="网格视图" active={grid} onClick={() => setGrid(true)}>
              <Grid2X2 size={16} />
            </IconButton>
            <IconButton label="列表视图" active={!grid} onClick={() => setGrid(false)}>
              <LayoutList size={16} />
            </IconButton>
          </div>
        </div>
      </div>

      <div className="file-secondary-toolbar">
        <label>
          状态
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部</option>
            <option value="ready">可用</option>
            <option value="processing">处理中</option>
            <option value="failed">失败</option>
            <option value="missing">资源缺失</option>
          </select>
        </label>
        <label>
          排序
          <select value={sort} onChange={(event) => setSort(event.target.value as "updated" | "name" | "size")}>
            <option value="updated">最近更新</option>
            <option value="name">名称</option>
            <option value="size">大小</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            setSelectedIds(
              selectedIds.size === visibleAssets.length
                ? new Set()
                : new Set(visibleAssets.map((asset) => asset.id)),
            )
          }
        >
          {selectedIds.size === visibleAssets.length && visibleAssets.length
            ? "取消全选"
            : "全选当前"}
        </button>
      </div>

      {!!selectedIds.size && (
        <div className="file-bulk-toolbar">
          <strong>已选择 {selectedIds.size} 个文件</strong>
          {!trash && (
            <>
              <button type="button" onClick={() => void bulkUpdate("favorite", { favorite: true })}>收藏</button>
              <button
                type="button"
                onClick={async () => {
                  const raw = await dialog.prompt(
                    "多个标签请使用逗号分隔。",
                    {
                      title: "批量设置标签",
                      inputLabel: "标签",
                      confirmText: "保存标签",
                    },
                  );
                  if (raw !== null) {
                    void bulkUpdate("tags", {
                      tags: raw.split(",").map((tag) => tag.trim()).filter(Boolean),
                    });
                  }
                }}
              >
                设置标签
              </button>
              <button type="button" onClick={bulkDownload}>批量下载</button>
              <button type="button" onClick={() => void bulkUpdate("trash")}>移到回收站</button>
            </>
          )}
          {trash && <button type="button" onClick={() => void bulkUpdate("restore")}>批量恢复</button>}
          <button type="button" onClick={() => setSelectedIds(new Set())}>取消选择</button>
        </div>
      )}

      {error && <div className="file-system-error" role="alert">{error}</div>}
      {busy && <div className="file-system-busy">{busy}</div>}

      <div className={`asset-grid file-grid ${grid ? "" : "is-list"}`}>
        {visibleAssets.map((asset) => (
          <article
            key={asset.id}
            className="asset-card file-card"
            draggable={!trash}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                "application/x-xiaoluo-asset",
                JSON.stringify(asset),
              );
              event.dataTransfer.setData("text/plain", asset.name);
            }}
          >
            <label className="file-select">
              <input
                type="checkbox"
                checked={selectedIds.has(asset.id)}
                onChange={(event) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(asset.id);
                    else next.delete(asset.id);
                    return next;
                  })
                }
              />
              <span>选择</span>
            </label>
            <button
              type="button"
              className={`asset-preview file-preview file-preview-${asset.kind}`}
              onClick={() => setSelected(asset)}
              aria-label={`预览 ${asset.name}`}
            >
              <AssetMedia asset={asset} />
              <span className="asset-type">{typeLabel[asset.kind]}</span>
              <span className="file-version">v{asset.currentVersion}</span>
            </button>
            <div className="asset-card-copy">
              <div>
                <h3 title={asset.name}>{asset.name}</h3>
                <IconButton label="打开文件详情" onClick={() => setSelected(asset)}>
                  <MoreHorizontal size={17} />
                </IconButton>
              </div>
              <p>{formatBytes(asset.size)} · {asset.mimeType}</p>
              <div className="asset-tags">
                {asset.tags.slice(0, 3).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <small>{formatDate(asset.updatedAt)}</small>
            </div>
          </article>
        ))}
      </div>

      {nextCursor && !loading && (
        <button
          type="button"
          className="file-load-more secondary-button"
          onClick={() => void loadAssets(nextCursor)}
        >
          加载更多文件
        </button>
      )}

      {!loading && !visibleAssets.length && (
        <div className="file-empty-state" aria-label="当前没有文件" />
      )}

      {loading && <div className="file-loading">正在读取文件索引…</div>}

      {formatsOpen && (
        <div
          className="asset-formats-backdrop"
          onMouseDown={() => setFormatsOpen(false)}
        >
          <section
            className="asset-formats-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-formats-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">UPLOAD FORMATS</span>
                <h2 id="asset-formats-title">支持的上传格式</h2>
                <p>文本、图片、视频、音频、文档和压缩文件均可进入资产系统。</p>
              </div>
              <IconButton
                label="关闭支持格式"
                onClick={() => setFormatsOpen(false)}
              >
                <X size={18} />
              </IconButton>
            </header>
            <div className="asset-format-grid">
              {SUPPORTED_FILE_GROUPS.map((group) => (
                <article key={group.label}>
                  <b>{group.label}</b>
                  <span>{group.extensions.join("、")}</span>
                </article>
              ))}
            </div>
            <small>
              单文件最大 100 MB。图片、视频、音频、文本、PDF 可直接预览；
              DOCX、XLSX、PPTX 会提取可读文本，旧版 Office 与 ZIP
              可存储、下载并拖入画布。
            </small>
          </section>
        </div>
      )}

      {selected && (
        <div className="preview-backdrop" onMouseDown={() => setSelected(null)}>
          <aside
            className="asset-preview-drawer file-preview-drawer"
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="文件详情"
          >
            <div className="preview-drawer-heading">
              <div>
                <h2>{selected.name}</h2>
              </div>
              <IconButton label="关闭文件详情" onClick={() => setSelected(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className={`preview-hero file-detail-preview detail-${selected.kind}`}>
              <AssetMedia asset={selected} detail />
            </div>
            <p className="preview-description">
              {selected.description || "文件由 Asset Kernel 管理，可安全用于画布、模型和插件。"}
            </p>
            <dl className="asset-details">
              <div><dt>类型</dt><dd>{selected.mimeType}</dd></div>
              <div><dt>大小</dt><dd>{formatBytes(selected.size)}</dd></div>
              <div><dt>当前版本</dt><dd>v{selected.currentVersion} / 共 {selected.versionCount} 个版本</dd></div>
              <div><dt>更新时间</dt><dd>{formatDate(selected.updatedAt)}</dd></div>
            </dl>
            <div className="preview-actions file-preview-actions">
              {trash ? (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void updateAsset(selected, { action: "restore" })}
                  >
                    <RotateCcw size={15} /> 恢复
                  </button>
                  <button
                    type="button"
                    className="danger-text-button"
                    onClick={() => void permanentlyDelete(selected)}
                  >
                    <Trash2 size={15} /> 永久删除
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void updateAsset(selected, { favorite: !selected.favorite })}
                  >
                    <Star size={15} fill={selected.favorite ? "currentColor" : "none"} />
                    {selected.favorite ? "取消收藏" : "收藏"}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void renameAsset(selected)}>
                    重命名
                  </button>
                  <button type="button" className="danger-text-button" onClick={() => void updateAsset(selected, { action: "trash" })}>
                    <Trash2 size={15} /> 移到回收站
                  </button>
                </>
              )}
              {!trash && onAddToCanvas && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void onAddToCanvas(selected)}
                >
                  <ChevronRight size={15} /> 添加到画布
                </button>
              )}
              <a className="primary-button" href={selected.downloadUrl}>
                <Download size={16} /> 下载
              </a>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
