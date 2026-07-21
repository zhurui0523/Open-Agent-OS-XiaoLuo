"use client";

import {
  CalendarDays,
  ChevronDown,
  Download,
  FileText,
  Filter,
  Grid2X2,
  Image as ImageIcon,
  LayoutList,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Tag,
  Video,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { initialAssets } from "../data";
import type { AssetItem } from "../types";
import { IconButton } from "./icon-button";

const filters = ["全部", "文本", "图片", "视频", "文档"];
const typeLabel: Record<AssetItem["kind"], string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  document: "文档",
};

function AssetGlyph({ kind }: { kind: AssetItem["kind"] }) {
  if (kind === "image") return <ImageIcon size={30} />;
  if (kind === "video") return <Video size={30} />;
  return <FileText size={30} />;
}

export function AssetsView() {
  const [filter, setFilter] = useState("全部");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AssetItem | null>(null);
  const [grid, setGrid] = useState(true);
  const assets = useMemo(
    () =>
      initialAssets.filter((asset) => {
        const matchesType = filter === "全部" || typeLabel[asset.kind] === filter;
        const matchesQuery = `${asset.title} ${asset.tags.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase());
        return matchesType && matchesQuery;
      }),
    [filter, query],
  );

  return (
    <section className="content-view assets-view" aria-label="资产库">
      <header className="content-header">
        <div>
          <span className="eyebrow">ARTIFACT LIBRARY</span>
          <h1>资产库</h1>
          <p>每个结果都保留来源画布、节点、模型和运行记录。</p>
        </div>
        <button type="button" className="primary-button">
          <Download size={16} /> 批量导出
        </button>
      </header>

      <div className="asset-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="资产类型">
          {filters.map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={filter === item}
              key={item}
              className={filter === item ? "is-active" : ""}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="asset-actions">
          <label className="view-search">
            <Search size={16} />
            <input
              aria-label="搜索资产"
              placeholder="搜索名称或标签"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="button" className="secondary-button compact">
            <CalendarDays size={15} /> 最近创建 <ChevronDown size={14} />
          </button>
          <IconButton label="筛选资产">
            <SlidersHorizontal size={17} />
          </IconButton>
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

      <div className={`asset-grid ${grid ? "" : "is-list"}`}>
        {assets.map((asset) => (
          <article key={asset.id} className="asset-card">
            <button
              type="button"
              className="asset-preview"
              style={{ background: asset.color }}
              onClick={() => setSelected(asset)}
              aria-label={`预览 ${asset.title}`}
            >
              <span className="asset-glyph">
                <AssetGlyph kind={asset.kind} />
              </span>
              <span className="asset-type">{typeLabel[asset.kind]}</span>
              {asset.kind === "video" && <span className="video-duration">00:06</span>}
            </button>
            <div className="asset-card-copy">
              <div>
                <h3>{asset.title}</h3>
                <IconButton label="更多资产操作">
                  <MoreHorizontal size={17} />
                </IconButton>
              </div>
              <p>{asset.source}</p>
              <div className="asset-tags">
                {asset.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <small>{asset.createdAt}</small>
            </div>
          </article>
        ))}
      </div>

      {!assets.length && (
        <div className="empty-state">
          <Filter size={26} />
          <h2>没有匹配的资产</h2>
          <p>清除筛选条件，或从画布运行一个节点。</p>
        </div>
      )}

      {selected && (
        <div className="preview-backdrop" onMouseDown={() => setSelected(null)}>
          <aside
            className="asset-preview-drawer"
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="资产预览"
          >
            <div className="preview-drawer-heading">
              <div>
                <span className="eyebrow">ASSET PREVIEW</span>
                <h2>{selected.title}</h2>
              </div>
              <IconButton label="关闭预览" onClick={() => setSelected(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="preview-hero" style={{ background: selected.color }}>
              <AssetGlyph kind={selected.kind} />
              <span>{typeLabel[selected.kind]}预览</span>
            </div>
            <p className="preview-description">{selected.description}</p>
            <dl className="asset-details">
              <div>
                <dt>来源</dt>
                <dd>{selected.source}</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{selected.model}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{selected.createdAt}</dd>
              </div>
              <div>
                <dt>资产 ID</dt>
                <dd className="mono">{selected.id}</dd>
              </div>
            </dl>
            <div className="preview-tags">
              <Tag size={15} />
              {selected.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <div className="preview-actions">
              <button type="button" className="secondary-button">
                在原画布中打开
              </button>
              <button type="button" className="primary-button">
                <Download size={16} /> 下载资产
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

