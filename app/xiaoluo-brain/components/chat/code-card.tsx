/**
 * 小逻 v3 —— 代码卡（对话流里"查看代码"的地方）
 *
 * 形态：左侧代码文件列表 + 右侧行号代码区 + 操作栏（复制/下载/预览）。
 * 样式自包含（inline style），集成时可按现有 UI 规范替换 className 方案。
 */

import { useMemo, useState } from "react";
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
}

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

export function CodeCard({ artifact, onPreview, fill = false }: CodeCardProps) {
  const files = artifact.files;
  const [activeIdx, setActiveIdx] = useState(() => {
    const idx = files.findIndex((f) => f.path === artifact.entryFile);
    return idx >= 0 ? idx : 0;
  });
  const active = files[activeIdx];

  const lineNos = useMemo(
    () => (active ? active.content.split("\n").map((_, i) => i + 1).join("\n") : ""),
    [active],
  );
  const warnings = useMemo(() => scanCodeRisk(artifact), [artifact]);
  const previewable = isPreviewable(artifact);

  const copyAll = async () => {
    const text = files
      .map((f) => `// ===== ${f.path} =====\n${f.content}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板不可用时静默（UI 层可加 toast 提示） */
    }
  };

  const downloadAll = () => {
    for (const file of files) {
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.path.split(/[\\/]/).pop() ?? file.path;
      a.click();
      URL.revokeObjectURL(url);
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
        {/* 右：行号代码区 */}
        <div style={fill ? { ...styles.codeArea, flex: 1, minHeight: 0, maxHeight: "none" } : { ...styles.codeArea, flex: 1 }}>
          <div style={styles.lineNos}>{lineNos}</div>
          <div style={styles.codeBody}>{active.content}</div>
        </div>
      </div>

      {/* 风险提醒（一期扫描签名，落盘前人工核对） */}
      {warnings.length > 0 && (
        <div style={styles.warnBar}>⚠ {warnings.join("；")}（落盘前请人工核对）</div>
      )}

      {/* 操作栏 */}
      <div style={styles.actionBar}>
        <button style={styles.btn} onClick={copyAll}>
          复制全部
        </button>
        <button style={styles.btn} onClick={downloadAll}>
          下载文件
        </button>
        {previewable && onPreview && (
          <button style={{ ...styles.btn, ...styles.btnPrimary }} onClick={onPreview}>
            ▶ 预览效果
          </button>
        )}
      </div>
    </div>
  );
}
