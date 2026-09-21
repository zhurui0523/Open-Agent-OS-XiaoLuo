/**
 * 小逻 v3 —— 代码卡（对话流里"查看代码"的地方）
 *
 * 形态：左侧代码文件列表 + 右侧行号代码区 + 操作栏（编辑/下载/预览）。
 * 样式自包含（inline style），集成时可按现有 UI 规范替换 className 方案。
 */

import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CodeArtifact } from "../../lib/brain/types";
import { isPreviewable } from "../../lib/brain/preview";
import { scanCodeRisk } from "../../lib/brain/code";

export interface CodeCardProps {
  artifact: CodeArtifact;
  /** 点"预览效果"（仅 HTML 类产物显示该按钮） */
  onPreview?: () => void;
  /** 撑满父容器（结果面板全屏模式用），此时忽略 maxWidth/高度上限 */
  fill?: boolean;
  /** 用户编辑保存后回调（path + newContent） */
  onFileChange?: (path: string, content: string) => void;

  /** 分享到能力中心（生成插件并安装） */
  onShareToCapability?: () => void;}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #e2e4ea",
    borderRadius: 12,
    background: "#fff",
    overflow: "hidden",
    fontSize: 13,
    maxWidth: 560,
  },
  tabBar: {
    display: "flex",
    flexDirection: "column",
    width: 150,
    flexShrink: 0,
    padding: "6px 0",
    borderRight: "1px solid #eef0f4",
    overflowY: "auto",
    background: "#fafbfc",
  },
  tab: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontSize: 12,
    color: "#555",
    textAlign: "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tabActive: {
    background: "#eef2ff",
    color: "#4f46e5",
    fontWeight: 600,
    boxShadow: "inset 2px 0 0 #4f6ef7",
  },
  codeArea: {
    display: "flex",
    maxHeight: 320,
    overflow: "auto",
    background: "#0f1117",
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.6,
  },
  lineNos: {
    padding: "10px 8px",
    color: "#5b6170",
    textAlign: "right",
    userSelect: "none",
    borderRight: "1px solid #23262f",
    whiteSpace: "pre",
  },
  codeBody: {
    padding: "10px 12px",
    color: "#d7dae0",
    whiteSpace: "pre",
    flex: 1,
  },
  actionBar: {
    display: "flex",
    gap: 8,
    padding: "8px 10px",
    borderTop: "1px solid #eef0f4",
    background: "#fafbfc",
  },
  btn: {
    padding: "5px 12px",
    borderRadius: 999,
    border: "1px solid #d9dce3",
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
  btnPrimary: {
    background: "#4f6ef7",
    borderColor: "#4f6ef7",
    color: "#fff",
  },
  warnBar: {
    padding: "6px 12px",
    color: "#9a6b00",
    background: "#fff8e6",
    fontSize: 12,
  },
};

// ---------- DOWNLOAD-FIX：零依赖 ZIP 打包（store 方式，够代码产物用） ----------
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let v = n;
    for (let k = 0; k < 8; k += 1) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    t[n] = v >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoreZip(entries: Array<{ path: string; data: Uint8Array }>): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 解压所需版本
    local.setUint16(6, 0x0800, true); // UTF-8 文件名
    local.setUint16(8, 0, true); // store 不压缩
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)] as BlobPart[], { type: "application/zip" });
}

export function CodeCard({ artifact, onPreview, fill = false, onFileChange, onShareToCapability }: CodeCardProps) {
  const files = artifact.files;
  const [activeIdx, setActiveIdx] = useState(() => {
    const idx = files.findIndex((f) => f.path === artifact.entryFile);
    return idx >= 0 ? idx : 0;
  });
  const active = files[activeIdx];
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const lineNosRef = useRef<HTMLDivElement>(null);

  const activeContent = drafts[active.path] ?? active.content;
  const hasUnsaved = Object.keys(drafts).length > 0;

  const lineNos = useMemo(
    () => (active ? activeContent.split("\n").map((_, i) => i + 1).join("\n") : ""),
    [active, activeContent],
  );
  const warnings = useMemo(() => scanCodeRisk(artifact), [artifact]);
  const previewable = isPreviewable(artifact);


  // DOWNLOAD-FIX：纯前端打包，不依赖 CDN（CSP script-src 'self' 会拦外部脚本注入）
  const downloadAll = () => {
    try {
      const enc = new TextEncoder();
      const blob = buildStoreZip(
        files.map((f) => ({ path: f.path, data: enc.encode(drafts[f.path] ?? f.content) })),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = (files[0]?.path.split(/[\\/]/).pop() ?? "code").replace(/\.[^.]+$/, "");
      a.download = baseName + ".zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 延迟回收：立即 revoke 会在部分壳层里掐掉刚发起的下载
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      window.alert("下载失败：" + (err instanceof Error ? err.message : String(err)));
    }
  };

  if (!active) return null;

  return (
    <div style={fill ? { ...styles.card, maxWidth: "none", height: "100%", display: "flex", flexDirection: "column" } : styles.card}>
      {/* 图1式：左侧文件列表 + 右侧行号代码区 */}
      <div
        style={
          fill
            ? { display: "flex", flex: 1, minHeight: 0 }
            : { display: "flex", maxHeight: 320 }
        }
      >
        {/* 左：代码文件列表，点击切换右侧代码 */}
        <div style={styles.tabBar}>
          {files.map((f, i) => (
            <button
              key={f.path}
              style={{ ...styles.tab, ...(i === activeIdx ? styles.tabActive : {}) }}
              onClick={() => setActiveIdx(i)}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.path === artifact.entryFile ? "⭐ " : ""}
                {f.path}
              </span>
            </button>
          ))}
        </div>
        {/* 右：行号代码区（编辑模式用 textarea） */}
        <div style={fill ? { ...styles.codeArea, flex: 1, minHeight: 0, maxHeight: "none" } : { ...styles.codeArea, flex: 1 }}>
          <div ref={lineNosRef} style={{ ...styles.lineNos, overflow: "hidden" }}>{lineNos}</div>
          {editing ? (
            <textarea
              style={{ ...styles.codeBody, background: "transparent", border: "none", outline: "none", resize: "none", fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit", color: "#d7dae0", padding: "10px 12px", flex: 1, overflow: "auto", whiteSpace: "pre", caretColor: "#fff" }}
              value={activeContent}
              onChange={(e) => setDrafts((d) => ({ ...d, [active.path]: e.target.value }))}
              onScroll={(e) => {
                if (lineNosRef.current) lineNosRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              spellCheck={false}
            />
          ) : (
            <div style={styles.codeBody}>{activeContent}</div>
          )}
        </div>
      </div>

      {/* 风险提醒（一期扫描签名，落盘前人工核对） */}
      {warnings.length > 0 && (
        <div style={styles.warnBar}>⚠ {warnings.join("；")}（落盘前请人工核对）</div>
      )}

      {/* 操作栏 */}
      <div style={styles.actionBar}>
        <button
          style={{ ...styles.btn, ...(editing ? { background: "#10b981", borderColor: "#10b981", color: "#fff" } : {}) }}
          onClick={() => {
            if (editing && hasUnsaved) {
              // 保存：逐文件回调
              for (const [p, c] of Object.entries(drafts)) {
                onFileChange?.(p, c);
              }
              setDrafts({});
            }
            setEditing((v) => !v);
          }}
        >
          {editing ? (hasUnsaved ? "✓ 保存" : "✓ 完成") : "✎ 编辑"}
        </button>
        <button style={styles.btn} onClick={downloadAll}>
          下载文件
        </button>
        {onShareToCapability && (
          <button style={styles.btn} onClick={onShareToCapability} title="生成插件并安装到能力中心">
             分享到能力中心
          </button>
        )}
        {previewable && onPreview && (
          <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={onPreview}>
            ▶ 预览效果
          </button>
        )}
      </div>
    </div>
  );
}
