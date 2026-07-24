"use client";

import {
  Archive,
  AudioLines,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderPlus,
  Grid2X2,
  HardDrive,
  Image as ImageIcon,
  LayoutList,
  MoreHorizontal,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AssetKind,
  FileSystemAsset,
  FileSystemFolder,
} from "../types";
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

interface AssetVersion {
  id: string;
  version: number;
  mimeType: string;
  size: number;
  contentHash: string;
  sourceType: string;
  createdAt: string;
}

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
    return <img src={asset.contentUrl} alt={asset.name} loading="lazy" />;
  }
  if (asset.kind === "video" && detail) {
    return <video src={asset.contentUrl} controls preload="metadata" />;
  }
  if (asset.kind === "audio" && detail) {
    return <audio src={asset.contentUrl} controls preload="metadata" />;
  }
  if (
    detail &&
    (asset.kind === "text" ||
      asset.mimeType === "application/pdf")
  ) {
    return <iframe src={asset.contentUrl} title={`${asset.name} 预览`} />;
  }
  return (
    <span className={`asset-glyph file-kind-${asset.kind}`}>
      <AssetGlyph kind={asset.kind} size={detail ? 40 : 28} />
    </span>
  );
}

export function AssetsView({ workspaceId }: { workspaceId: string }) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const versionRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<FileSystemAsset[]>([]);
  const [folders, setFolders] = useState<FileSystemFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AssetKind>("all");
  const [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false);
  const [grid, setGrid] = useState(true);
  const [selected, setSelected] = useState<FileSystemAsset | null>(null);
  const [versions, setVersions] = useState<AssetVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const currentFolder = folders.find((folder) => folder.id === folderId) ?? null;
  const visibleFolders = useMemo(
    () =>
      folders.filter(
        (folder) => (folder.parentId ?? null) === folderId,
      ),
    [folderId, folders],
  );
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      else if (!trash) params.set("folder", folderId ?? "root");
      if (filter !== "all") params.set("kind", filter);
      if (trash) params.set("trash", "1");
      const payload = await requestJson<{ assets: FileSystemAsset[] }>(
        workspaceId,
        `/api/v2/files?${params}`,
      );
      setAssets(payload.assets);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "文件列表加载失败",
      );
    } finally {
      setLoading(false);
    }
  }, [filter, folderId, query, trash, workspaceId]);

  const loadFolders = useCallback(async () => {
    try {
      const payload = await requestJson<{ folders: FileSystemFolder[] }>(
        workspaceId,
        "/api/v2/folders",
      );
      setFolders(payload.folders);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "文件夹加载失败",
      );
    }
  }, [workspaceId]);

  useEffect(() => {
    let active = true;
    void requestJson<{ folders: FileSystemFolder[] }>(
      workspaceId,
      "/api/v2/folders",
    )
      .then((payload) => {
        if (active) setFolders(payload.folders);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "文件夹加载失败",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    const timeout = setTimeout(() => void loadAssets(), 160);
    return () => clearTimeout(timeout);
  }, [loadAssets]);

  useEffect(() => {
    if (!selected) return;
    void requestJson<{ versions: AssetVersion[] }>(
      workspaceId,
      `/api/v2/files/versions?assetId=${encodeURIComponent(selected.id)}`,
    )
      .then((payload) => setVersions(payload.versions))
      .catch(() => setVersions([]));
  }, [selected, workspaceId]);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(`正在上传 1/${list.length}`);
    setError("");
    try {
      for (let index = 0; index < list.length; index += 1) {
        setBusy(`正在上传 ${index + 1}/${list.length}`);
        const form = new FormData();
        form.set("file", list[index]);
        if (folderId) form.set("folderId", folderId);
        form.set("sourceType", "asset-manager-upload");
        await requestJson(workspaceId, "/api/v2/files", {
          method: "POST",
          body: form,
        });
      }
      await loadAssets();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "文件上传失败",
      );
    } finally {
      setBusy("");
    }
  }

  async function createFolder() {
    const name = window.prompt("新文件夹名称");
    if (!name?.trim()) return;
    try {
      await requestJson(workspaceId, "/api/v2/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId: folderId }),
      });
      await loadFolders();
    } catch (folderError) {
      setError(
        folderError instanceof Error ? folderError.message : "新建文件夹失败",
      );
    }
  }

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
    const name = window.prompt("重命名文件", asset.name);
    if (!name?.trim() || name.trim() === asset.name) return;
    await updateAsset(asset, { name });
  }

  async function permanentlyDelete(asset: FileSystemAsset) {
    if (!window.confirm(`永久删除“${asset.name}”？此操作不能撤销。`)) return;
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

  async function uploadVersion(file: File) {
    if (!selected) return;
    setBusy("正在创建新版本");
    try {
      const form = new FormData();
      form.set("assetId", selected.id);
      form.set("file", file);
      const payload = await requestJson<{ asset: FileSystemAsset }>(
        workspaceId,
        "/api/v2/files/versions",
        { method: "POST", body: form },
      );
      setSelected(payload.asset);
      await loadAssets();
    } catch (versionError) {
      setError(
        versionError instanceof Error ? versionError.message : "版本上传失败",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <section
      className={`content-view assets-view file-system-view ${dragging ? "is-dragging" : ""}`}
      aria-label="AI 文件系统"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void uploadFiles(event.dataTransfer.files);
      }}
    >
      <header className="content-header file-system-header">
        <div>
          <span className="eyebrow">ASSET KERNEL · VFS</span>
          <h1>AI 文件系统</h1>
          <p>文件、版本、来源和节点结果统一使用 asset:// 地址管理。</p>
        </div>
        <div className="file-header-actions">
          <button type="button" className="secondary-button" onClick={() => void createFolder()}>
            <FolderPlus size={16} /> 新建文件夹
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => uploadRef.current?.click()}
          >
            <Upload size={16} /> 上传文件
          </button>
        </div>
      </header>

      <div className="file-system-stats">
        <span><HardDrive size={15} /> 当前视图 {assets.length} 个文件</span>
        <span>{formatBytes(totalBytes)}</span>
        <span>内容哈希去重</span>
        <span>版本与血缘已启用</span>
      </div>

      <div className="file-breadcrumbs">
        <button type="button" onClick={() => setFolderId(null)}>
          文件系统
        </button>
        {currentFolder && (
          <>
            <ChevronRight size={14} />
            <strong>{currentFolder.name}</strong>
          </>
        )}
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

      {error && <div className="file-system-error" role="alert">{error}</div>}
      {busy && <div className="file-system-busy">{busy}</div>}

      {!trash && !query && filter === "all" && visibleFolders.length > 0 && (
        <div className="folder-grid" aria-label="文件夹">
          {visibleFolders.map((folder) => (
            <button
              type="button"
              key={folder.id}
              className="folder-card"
              onClick={() => setFolderId(folder.id)}
            >
              <span><Folder size={22} fill="currentColor" /></span>
              <strong>{folder.name}</strong>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      )}

      <div className={`asset-grid file-grid ${grid ? "" : "is-list"}`}>
        {assets.map((asset) => (
          <article key={asset.id} className="asset-card file-card">
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
                {!asset.tags.length && <span>{asset.sourceType}</span>}
              </div>
              <small>{formatDate(asset.updatedAt)}</small>
            </div>
          </article>
        ))}
      </div>

      {!loading && !assets.length && (
        <div className="empty-state file-empty-state">
          {trash ? <Trash2 size={30} /> : <Upload size={30} />}
          <h2>{trash ? "回收站为空" : "这里还没有文件"}</h2>
          <p>
            {trash
              ? "删除的文件会先保留在这里，直到永久删除。"
              : "上传文件或把文件拖到这里，文件内核会自动生成版本和内容哈希。"}
          </p>
          {!trash && (
            <button type="button" className="primary-button" onClick={() => uploadRef.current?.click()}>
              <Upload size={16} /> 上传第一个文件
            </button>
          )}
        </div>
      )}

      {loading && <div className="file-loading">正在读取文件索引…</div>}

      <input
        ref={uploadRef}
        type="file"
        multiple
        className="canvas-file-input"
        onChange={(event) => {
          if (event.target.files) void uploadFiles(event.target.files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={versionRef}
        type="file"
        className="canvas-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadVersion(file);
          event.currentTarget.value = "";
        }}
      />

      {dragging && (
        <div className="file-drop-overlay">
          <Upload size={34} />
          <strong>释放以写入 AI 文件系统</strong>
          <span>自动去重、建立版本并生成 asset:// 地址</span>
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
                <span className="eyebrow">ASSET:// FILE</span>
                <h2>{selected.name}</h2>
              </div>
              <IconButton label="关闭文件详情" onClick={() => setSelected(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className={`preview-hero file-detail-preview detail-${selected.kind}`}>
              <AssetMedia asset={selected} detail />
            </div>
            <div className="asset-uri-row">
              <code>{selected.uri}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(selected.uri)}
              >
                复制
              </button>
            </div>
            <p className="preview-description">
              {selected.description || "文件由 Asset Kernel 管理，可安全用于画布、模型和插件。"}
            </p>
            <dl className="asset-details">
              <div><dt>类型</dt><dd>{selected.mimeType}</dd></div>
              <div><dt>大小</dt><dd>{formatBytes(selected.size)}</dd></div>
              <div><dt>当前版本</dt><dd>v{selected.currentVersion} / 共 {selected.versionCount} 个版本</dd></div>
              <div><dt>来源</dt><dd>{selected.sourceType}{selected.sourceRef ? ` · ${selected.sourceRef}` : ""}</dd></div>
              <div><dt>内容哈希</dt><dd className="mono">{selected.contentHash.slice(0, 20)}…</dd></div>
              <div><dt>更新时间</dt><dd>{formatDate(selected.updatedAt)}</dd></div>
            </dl>
            <div className="preview-tags">
              <Tag size={15} />
              {selected.tags.length ? selected.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              )) : <span>暂无标签</span>}
            </div>
            {!!versions.length && (
              <div className="asset-version-list">
                <strong>版本历史</strong>
                {versions.slice(0, 5).map((version) => (
                  <a
                    key={version.id}
                    href={`/api/v2/files/content?assetId=${encodeURIComponent(selected.id)}&version=${version.version}&workspaceId=${encodeURIComponent(workspaceId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>v{version.version}</span>
                    <small>{formatBytes(version.size)} · {formatDate(version.createdAt)}</small>
                  </a>
                ))}
              </div>
            )}
            {!trash && (
              <label className="file-move-field">
                <span>所在文件夹</span>
                <select
                  value={selected.folderId ?? ""}
                  onChange={(event) =>
                    void updateAsset(selected, {
                      folderId: event.target.value || null,
                    })
                  }
                >
                  <option value="">文件系统根目录</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>{folder.name}</option>
                  ))}
                </select>
              </label>
            )}
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
                  <button type="button" className="secondary-button" onClick={() => void renameAsset(selected)}>
                    重命名
                  </button>
                  <button type="button" className="secondary-button" onClick={() => versionRef.current?.click()}>
                    <Upload size={15} /> 新版本
                  </button>
                  <button type="button" className="danger-text-button" onClick={() => void updateAsset(selected, { action: "trash" })}>
                    <Trash2 size={15} /> 移到回收站
                  </button>
                </>
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
