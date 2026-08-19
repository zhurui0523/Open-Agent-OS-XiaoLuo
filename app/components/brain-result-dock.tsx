/**
 * 小逻大脑结果面板 —— 画布上的独立浮动窗口。
 * 展示最近一次 write_code 的「结果预览」与「代码」，与对话流解耦：
 * 对话滚动 / 切换不会丢结果，随时可从右下角工具条重新打开。
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import type { CodeArtifact } from "../xiaoluo-brain/lib/brain/types";
import { LocalStorageMemoryStore } from "../xiaoluo-brain/lib/brain/memory-store";
import type { PreviewDocument } from "../xiaoluo-brain/lib/brain/preview";
import { CodeCard } from "../xiaoluo-brain/components/chat/code-card";
import { CodePreview } from "../xiaoluo-brain/components/chat/code-preview";
import { buildPreviewDocument, isPreviewable } from "../xiaoluo-brain/lib/brain/preview";

/** 小逻大脑最近一次的代码产物 / 预览快照 */
export interface BrainResultSnapshot {
  artifact: CodeArtifact | null;
  preview: PreviewDocument | null;
}

interface BrainResultDockProps {
  snapshot: BrainResultSnapshot | null;
  onClose: () => void;
  /** 时间线事件跳转：指定打开的 Tab（nonce 用于连续同 Tab 跳转也能触发） */
  focus?: { tab: DockTab; nonce: number } | null;
}

type DockTab = "preview" | "code" | "memory";

export function BrainResultDock({ snapshot, onClose, focus }: BrainResultDockProps) {
  const [tab, setTab] = useState<DockTab>("preview");

  // Xiaoluo memory: boss can view/delete (same localStorage source as the panel, data stays in sync)
  const memoryStore = useMemo(() => new LocalStorageMemoryStore(), []);
  const [memNonce, setMemNonce] = useState(0);
  const [memoryItems, setMemoryItems] = useState<Array<{ id: string; text: string }>>([]);
  useEffect(() => {
    let live = true;
    if (tab !== "memory") return;
    memoryStore.list().then((items) => {
      if (live) setMemoryItems(items.map((e) => ({ id: e.id, text: e.text })));
    });
    return () => {
      live = false;
    };
  }, [tab, memNonce, memoryStore]);

  // 预览数据：快照优先；历史恢复只剩代码产物时就地组装预览（纯客户端）
  // 保证点"打开预览"永远有预览可看，不会退回代码页
  const previewDoc = useMemo(() => {
    if (snapshot?.preview) return snapshot.preview;
    if (snapshot?.artifact && isPreviewable(snapshot.artifact)) {
      return buildPreviewDocument(snapshot.artifact);
    }
    return null;
  }, [snapshot]);

  // 跳转指令（focus）优先于数据默认值：点"打开预览"必须落在预览页
  useEffect(() => {
    if (focus) {
      setTab(focus.tab);
      return;
    }
    // 无显式跳转指令时不随数据变化重置页签：老板手动选的页签必须保留
  }, [focus]);

  const tabStyle = (active: boolean) => ({
    padding: "4px 12px",
    borderRadius: 999,
    border: "none",
    background: active ? "#eef2ff" : "transparent",
    color: active ? "#4f46e5" : "#6b7280",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    fontSize: 12,
  });

  return (
    <div
      className="brain-result-dock"
      role="dialog"
      aria-label="小逻结果面板"
      style={{
        position: "absolute",
        zIndex: 40,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "1px solid #eef0f4",
          background: "#fafbfc",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            style={tabStyle(tab === "preview")}
            onClick={() => setTab("preview")}
          >
            预览
          </button>
          <button
            type="button"
            style={tabStyle(tab === "code")}
            onClick={() => setTab("code")}
          >
            代码
          </button>
          <button
            type="button"
            title="小逻的记忆"
            style={tabStyle(tab === "memory")}
            onClick={() => setTab(tab === "memory" ? "preview" : "memory")}
          >
            记忆
          </button>
        </div>
        <button
          type="button"
          aria-label="关闭小逻结果面板"
          onClick={onClose}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "#6b7280",
            fontSize: 16,
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      </div>
      {tab === "memory" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, fontSize: 12, color: "#6b7280" }}>
          <div style={{ fontWeight: 600, color: "#374151", marginBottom: 8 }}>小逻的记忆（{memoryItems.length}）</div>
          {memoryItems.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>还没有记忆——聊出偏好或约定时，小逻会用「记住」主动记下。</div>
          ) : (
            memoryItems.map((m) => (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {m.text}</span>
                <button
                  type="button"
                  title="删除这条记忆"
                  onClick={() => memoryStore.remove(m.id).then(() => setMemNonce((v) => v + 1))}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12, flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {tab === "preview" ? (
          previewDoc ? (
            <div style={{ height: "100%" }}>
              <CodePreview preview={previewDoc} fill />
            </div>
          ) : (
            <div style={{ color: "#8a8f98", fontSize: 13 }}>
              暂无可预览的结果。让小逻写一段网页代码后，预览会出现在这里。
            </div>
          )
        ) : snapshot?.artifact ? (
          <div style={{ height: "100%" }}>
            <CodeCard artifact={snapshot.artifact} fill />
          </div>
        ) : (
          <div style={{ color: "#8a8f98", fontSize: 13 }}>
            暂无代码产物。让小逻写代码后，代码会出现在这里。
          </div>
        )}
      </div>
      )}
    </div>
  );
}
