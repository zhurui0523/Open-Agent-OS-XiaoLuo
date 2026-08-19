/**
 * 小逻 v3 —— 预览卡（对话流里"看效果"的地方）
 *
 * 沙箱 iframe 渲染 write_code 的 HTML 类产物：
 *  - srcDoc + sandbox="allow-scripts"（无同源，预览 JS 碰不到主应用）
 *  - 刷新按钮：key 递增重挂载 iframe，等效重新运行
 *  - 高度自适应由宿主容器控制，默认 360px
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import type { PreviewDocument } from "../../lib/brain/preview";

export interface CodePreviewProps {
  preview: PreviewDocument;
  /** 预览区高度（默认 360） */
  height?: number;
  /** 撑满父容器（结果面板全屏模式用），此时忽略 height */
  fill?: boolean;
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #e2e4ea",
    borderRadius: 12,
    background: "#fff",
    overflow: "hidden",
    maxWidth: 560,
    fontSize: 13,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid #eef0f4",
    background: "#fafbfc",
  },
  title: { fontWeight: 600, color: "#333", fontSize: 12 },
  badge: {
    fontSize: 11,
    color: "#7a8194",
    border: "1px solid #e2e4ea",
    borderRadius: 999,
    padding: "2px 8px",
    marginLeft: 8,
  },
  btn: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #d9dce3",
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    color: "#333",
  },
  frame: {
    width: "100%",
    border: "none",
    display: "block",
    background: "#fff",
  },
};

export function CodePreview({ preview, height = 360, fill = false }: CodePreviewProps) {
  /** key 递增 = iframe 重挂载 = 重新运行（等效浏览器刷新） */
  const [runKey, setRunKey] = useState(0);

  return (
    <div
      style={
        fill
          ? { ...styles.card, maxWidth: "none", height: "100%", display: "flex", flexDirection: "column" }
          : styles.card
      }
    >
      <div style={styles.header}>
        <span style={styles.title}>
          {preview.title}
          <span style={styles.badge}>沙箱预览</span>
        </span>
        <button style={styles.btn} onClick={() => setRunKey((k) => k + 1)}>
          ⟳ 重新运行
        </button>
      </div>
      <iframe
        key={runKey}
        title={`小逻预览：${preview.title}`}
        srcDoc={preview.srcDoc}
        sandbox={preview.sandbox}
        style={fill ? { ...styles.frame, flex: 1, minHeight: 0, height: "auto" } : { ...styles.frame, height }}
      />
    </div>
  );
}
