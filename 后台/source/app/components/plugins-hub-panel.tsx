/**
 * 插件台 —— 画布上独立的一屏，不再和 代码 / 浏览器 / 记忆 / MCP / 服务 挤在同一排页签里。
 * 入口在底部浮条；这里负责列出带界面的插件、把固定后的插件页签摆在标题右边，
 * 点页签就在本屏就地运行那块插件面板，另外还能一键装示例面板插件。
 */
"use client";

import { useState } from "react";
import { Check, Puzzle } from "lucide-react";
import type { PluginAssetContext, PluginTextContext } from "../types";
import type { DockPanelDescriptor } from "../lib/dock-panel-registry";
import { toggleDockPanelPin } from "../lib/dock-panel-registry";
import { PluginRuntimeFrame } from "./plugin-runtime-frame";
import { PluginCapabilitiesPanel } from "./plugin-capabilities-panel";

interface PluginsHubPanelProps {
  /** 候选：所有可渲染的插件面板，与画布右键「添加插件」同一谓词 */
  panels: DockPanelDescriptor[];
  pinnedTabIds: Set<string>;
  /** 本屏正在运行哪块面板，null = 回到清单。状态放在画布层，画布右键固定也能直接驱动它 */
  runningTabId: string | null;
  onRunningTabIdChange: (tabId: string | null) => void;
  onInstallSample?: () => Promise<string>;
  onClose: () => void;
  /** 就地运行面板要用到的工作区与引用上下文 */
  workspaceId?: string;
  assetContexts?: PluginAssetContext[];
  textContexts?: PluginTextContext[];
}

export function PluginsHubPanel({
  panels,
  pinnedTabIds,
  runningTabId,
  onRunningTabIdChange,
  onInstallSample,
  onClose,
  workspaceId = "",
  assetContexts = [],
  textContexts = [],
}: PluginsHubPanelProps) {
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleNotice, setSampleNotice] = useState("");

  async function installSample() {
    if (!onInstallSample) return;
    setSampleBusy(true);
    setSampleNotice("");
    try {
      setSampleNotice(`${await onInstallSample()} 已安装，现在可以直接打开。`);
    } catch (reason) {
      setSampleNotice(reason instanceof Error ? reason.message : "示例插件安装失败");
    } finally {
      setSampleBusy(false);
    }
  }

  /** 在本屏运行一块面板：还没固定的先固定，这样标题那一排才有它的页签 */
  function runPanel(panel: DockPanelDescriptor) {
    if (!pinnedTabIds.has(panel.tabId)) toggleDockPanelPin(panel.tabId);
    onRunningTabIdChange(panel.tabId);
  }

  // 固定后的插件页签归这里管，结果面板顶部只留 代码/浏览器/记忆/MCP/服务
  const pinnedPanels = panels.filter((panel) => pinnedTabIds.has(panel.tabId));
  const runningPanel = pinnedPanels.find((panel) => panel.tabId === runningTabId) ?? null;

  return (
    <div
      className="plugins-hub-panel"
      role="dialog"
      aria-label="插件台"
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
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "#374151",
          }}
        >
          <Puzzle size={14} style={{ color: "#4f46e5" }} />
          插件台（{panels.length}）
        </span>
        {pinnedPanels.length > 0 ? (
          <div
            aria-label="已固定插件页签"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flex: 1,
              minWidth: 0,
              overflowX: "auto",
              scrollbarWidth: "none",
            }}
          >
            {pinnedPanels.map((panel) => {
              const running = panel.tabId === runningTabId;
              return (
                <button
                  key={panel.tabId}
                  type="button"
                  title={`${panel.packageName} 插件面板`}
                  aria-pressed={running}
                  onClick={() => onRunningTabIdChange(running ? null : panel.tabId)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    flexShrink: 0,
                    border: `1px solid ${running ? "#c7d2fe" : "#e5e7eb"}`,
                    borderRadius: 999,
                    background: running ? "#eef2ff" : "#fff",
                    color: running ? "#4f46e5" : "#4b5563",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "3px 10px",
                  }}
                >
                  <Puzzle size={11} style={{ color: "#4f46e5" }} />
                  {panel.title}
                </button>
              );
            })}
          </div>
        ) : null}
        <button
          type="button"
          aria-label="关闭插件台"
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

      {runningPanel ? (
        // 页签选中后整屏交给这块面板，插件台和结果面板互斥，不会同时挂两份 iframe
        <PluginRuntimeFrame
          title={runningPanel.title}
          url={runningPanel.runtimeUrl}
          workspaceId={workspaceId}
          packageId={runningPanel.packageId}
          packageKey={runningPanel.packageKey}
          assetContexts={assetContexts}
          textContexts={textContexts}
          className="plugin-runtime-content hub-plugin-runtime"
        />
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, fontSize: 12, color: "#6b7280" }}>
        {panels.length === 0 ? (
          <div style={{ color: "#9ca3af", lineHeight: 1.6 }}>
            <div>还没有带界面的插件。装好一个 sandbox-ui 插件后，它的面板会列在这里，点开就能用。</div>
            {onInstallSample ? (
              <button
                type="button"
                disabled={sampleBusy}
                onClick={() => void installSample()}
                style={{
                  marginTop: 8,
                  padding: "4px 12px",
                  borderRadius: 999,
                  border: "1px solid #c7d2fe",
                  background: "#eef2ff",
                  color: "#4f46e5",
                  fontSize: 12,
                  cursor: sampleBusy ? "default" : "pointer",
                }}
              >
                {sampleBusy ? "正在安装示例插件…" : "安装示例面板插件"}
              </button>
            ) : null}
            {sampleNotice ? (
              <div style={{ marginTop: 6, color: "#4b5563" }}>{sampleNotice}</div>
            ) : null}
          </div>
        ) : (
          panels.map((panel) => {
            const pinned = pinnedTabIds.has(panel.tabId);
            return (
              <div
                key={panel.tabId}
                style={{
                  borderTop: "1px solid #f3f4f6",
                  padding: "8px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      color: "#374151",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {panel.title}
                  </span>
                  <span style={{ color: "#9ca3af", fontSize: 11 }}>{panel.packageName}</span>
                </span>
                <button
                  type="button"
                  onClick={() => runPanel(panel)}
                  style={{
                    border: "none",
                    borderRadius: 999,
                    background: "#eef2ff",
                    color: "#4f46e5",
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "3px 10px",
                  }}
                >
                  打开
                </button>
                <button
                  type="button"
                  title={pinned ? "取消固定，页签会从这一排移除" : "固定成独立页签，显示在标题右边"}
                  onClick={() => toggleDockPanelPin(panel.tabId)}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 999,
                    background: "transparent",
                    color: pinned ? "#4f46e5" : "#6b7280",
                    cursor: "pointer",
                    fontSize: 12,
                    flexShrink: 0,
                    padding: "2px 9px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  {pinned ? <Check size={11} /> : null}
                  {pinned ? "已固定" : "固定"}
                </button>
              </div>
            );
          })
        )}
        <div style={{ color: "#9ca3af", marginTop: 10, lineHeight: 1.6 }}>
          固定后的插件页签会出现在这一排，点它就在本屏运行那块面板，再点一次回到清单。
        </div>
        <PluginCapabilitiesPanel />
      </div>
      )}
    </div>
  );
}
