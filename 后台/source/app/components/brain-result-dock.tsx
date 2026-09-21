/**
 * 小逻大脑结果面板 —— 画布上的独立浮动窗口。
 * 展示最近一次 write_code 的「结果预览」与「代码」，与对话流解耦：
 * 对话滚动 / 切换不会丢结果，随时可从右下角工具条重新打开。
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Plug, RefreshCw, Server, Square } from "lucide-react";
import type { CodeArtifact, ServiceRunInfo } from "../xiaoluo-brain/lib/brain/types";
import { LocalStorageMemoryStore } from "../xiaoluo-brain/lib/brain/memory-store";
import type { PreviewDocument } from "../xiaoluo-brain/lib/brain/preview";
import { CodeCard } from "../xiaoluo-brain/components/chat/code-card";
import { BrowserFrame, SandboxFrame, openExternalUrl } from "../xiaoluo-brain/components/chat/code-preview";
import { buildPreviewDocument, isPreviewable } from "../xiaoluo-brain/lib/brain/preview";

/** 小逻大脑最近一次的代码产物 / 预览快照 */
export interface BrainResultSnapshot {
  artifact: CodeArtifact | null;
  preview: PreviewDocument | null;
  /** AUTO-SVC-SYNC：服务自动重启完成计数（浏览器页签据此强制重载） */
  syncNonce?: number;
}

interface BrainResultDockProps {
  snapshot: BrainResultSnapshot | null;
  onClose: () => void;
  /** 时间线事件跳转：指定打开的 Tab（nonce 用于连续同 Tab 跳转也能触发） */
  focus?: { tab: DockTab; nonce: number } | null;
  /** MCP 服务器列表（工作区 mcp.json；与输入条共享勾选） */
  mcpServers?: { name: string; ok: boolean; toolCount: number; error?: string }[];
  pickedMcps?: string[];
  onToggleMcp?: (name: string) => void;
  /** 分享到能力中心回调 */
  onShareToCapability?: () => void;
}

type DockTab = "preview" | "browser" | "code" | "memory" | "mcp" | "services";

export function BrainResultDock({
  snapshot,
  onClose,
  focus,
  mcpServers = [],
  pickedMcps = [],
  onToggleMcp,
  onShareToCapability,
}: BrainResultDockProps) {
  const [tab, setTab] = useState<DockTab>("preview");

  // 用户代码编辑覆盖：本面板同步重建预览；同时发事件回写对话代理产物（EDIT-SYNC）
  const [fileOverrides, setFileOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    setFileOverrides({});
  }, [snapshot?.artifact]);
  const effectiveArtifact = useMemo(() => {
    if (!snapshot?.artifact) return null;
    if (Object.keys(fileOverrides).length === 0) return snapshot.artifact;
    return {
      ...snapshot.artifact,
      files: snapshot.artifact.files.map((f) =>
        fileOverrides[f.path] != null ? { ...f, content: fileOverrides[f.path] } : f,
      ),
    };
  }, [snapshot, fileOverrides]);

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

  // 服务台：小逻起的长驻服务在这里可见/可停（管理权在老板）
  const [services, setServices] = useState<ServiceRunInfo[]>([]);
  const [svcNonce, setSvcNonce] = useState(0);
  const [svcBusy, setSvcBusy] = useState(false);
  async function fetchServices(): Promise<ServiceRunInfo[]> {
    const desktop = (
      window as unknown as {
        xiaoluoDesktop?: {
          manageService?: (payload: {
            action: string;
            id?: string;
          }) => Promise<{ error?: string; services?: ServiceRunInfo[] }>;
        };
      }
    ).xiaoluoDesktop;
    if (desktop?.manageService) {
      const res = await desktop.manageService({ action: "status" });
      if (res.error) throw new Error(res.error);
      return res.services ?? [];
    }
    const resp = await fetch("/api/v2/brain/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      services?: ServiceRunInfo[];
      error?: string;
    };
    if (!resp.ok) throw new Error(data.error ?? "服务查询失败 (" + resp.status + ")");
    return data.services ?? [];
  }
  async function refreshServices() {
    setSvcBusy(true);
    try {
      setServices(await fetchServices());
    } catch {
      /* 查询失败不打断：列表保持旧值 */
    } finally {
      setSvcBusy(false);
    }
  }
  useEffect(() => {
    if (tab !== "services") return;
    void refreshServices();
    const t = window.setInterval(() => void refreshServices(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, svcNonce]);
  async function stopService(id: string) {
    const desktop = (
      window as unknown as {
        xiaoluoDesktop?: {
          manageService?: (payload: {
            action: string;
            id?: string;
          }) => Promise<{ error?: string }>;
        };
      }
    ).xiaoluoDesktop;
    try {
      if (desktop?.manageService) {
        const res = await desktop.manageService({ action: "stop", id });
        if (res.error) throw new Error(res.error);
      } else {
        const resp = await fetch("/api/v2/brain/services", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop", id }),
        });
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        if (!resp.ok) throw new Error(data.error ?? "服务停止失败 (" + resp.status + ")");
      }
    } catch (e) {
      window.alert("停止失败：" + (e instanceof Error ? e.message : String(e)));
    }
    setSvcNonce((v) => v + 1);
  }

  // SPLIT-PREVIEW：预览与浏览器拆开——
  // 预览页签只跑当前代码产物（含用户编辑）的沙箱文档；
  // 浏览器页签只承载网址/本机服务实况。
  const sandboxDoc = useMemo(() => {
    if (effectiveArtifact && isPreviewable(effectiveArtifact)) {
      return buildPreviewDocument(effectiveArtifact);
    }
    return null;
  }, [effectiveArtifact]);
  const browserUrl = snapshot?.preview?.url ?? "";
  const browserPreview = useMemo(
    () =>
      browserUrl
        ? { srcDoc: "", sandbox: "", title: "本地服务 " + browserUrl, url: browserUrl }
        : undefined,
    [browserUrl],
  );

  // 跳转指令（focus）优先于数据默认值：点"打开预览"必须落在预览页
  useEffect(() => {
    if (focus) {
      setTab(focus.tab);
      return;
    }
    // 无显式跳转指令时不随数据变化重置页签：老板手动选的页签必须保留
  }, [focus]);
  // NAV-EVENT：小逻 navigate_browser 派发导航 → 结果面板切到浏览器页签
  useEffect(() => {
    const onNav = () => setTab('browser');
    window.addEventListener('xiaoluo:navigate-browser', onNav);
    return () => window.removeEventListener('xiaoluo:navigate-browser', onNav);
  }, []);

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
            title="代码产物的隔离沙箱运行"
            style={tabStyle(tab === "preview")}
            onClick={() => setTab("preview")}
          >
            预览
          </button>
          <button
            type="button"
            title="内嵌浏览器：本机服务实况 / 手动输入网址"
            style={tabStyle(tab === "browser")}
            onClick={() => setTab("browser")}
          >
            浏览器
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
          <button
            type="button"
            title="引用 MCP 外部工具"
            style={{
              ...tabStyle(tab === "mcp"),
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => setTab(tab === "mcp" ? "preview" : "mcp")}
          >
            <Plug size={11} />
            MCP
          </button>
          <button
            type="button"
            title="服务台：小逻起的长驻服务"
            style={{
              ...tabStyle(tab === "services"),
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onClick={() => setTab(tab === "services" ? "preview" : "services")}
          >
            <Server size={11} />
            服务
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
      ) : tab === "mcp" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, fontSize: 12, color: "#6b7280" }}>
          <div style={{ fontWeight: 600, color: "#374151", marginBottom: 8 }}>
            MCP 外部工具（{mcpServers.length}）
          </div>
          {mcpServers.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>
              工作区还没有配置 MCP 服务器——在 mcp.json 里添加后，这里会列出可引用的外部工具。
            </div>
          ) : (
            mcpServers.map((server) => (
              <button
                key={server.name}
                type="button"
                title={server.ok ? "勾选后随消息引用" : server.error || "连接失败"}
                disabled={!server.ok}
                onClick={() => onToggleMcp?.(server.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  border: 0,
                  borderRadius: 8,
                  background: pickedMcps.includes(server.name) ? "#eef2ff" : "transparent",
                  padding: "6px 8px",
                  fontSize: 12,
                  color: "#111827",
                  cursor: server.ok ? "pointer" : "not-allowed",
                  opacity: server.ok ? 1 : 0.5,
                  textAlign: "left",
                  marginTop: 2,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 14,
                    height: 14,
                    border: "1px solid #c7d2e4",
                    borderRadius: 4,
                    color: "#4f6ef7",
                    flexShrink: 0,
                  }}
                >
                  {pickedMcps.includes(server.name) && <Check size={11} />}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {server.name}
                </span>
                <span style={{ color: "#6b7280", fontSize: 11, whiteSpace: "nowrap" }}>
                  {server.ok ? server.toolCount + " 工具" : "连接失败"}
                </span>
              </button>
            ))
          )}
          <div style={{ color: "#9ca3af", marginTop: 10, lineHeight: 1.6 }}>
            勾选的服务器会以引用形式随消息发送，小逻会优先使用对应的外部工具。
          </div>
        </div>
      ) : tab === "services" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, fontSize: 12, color: "#6b7280" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Server size={13} style={{ color: "#4f46e5", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "#374151", flex: 1 }}>服务台（{services.length}）</span>
            <button
              type="button"
              onClick={() => void refreshServices()}
              disabled={svcBusy}
              title="刷新"
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", display: "inline-flex", alignItems: "center" }}
            >
              <RefreshCw size={12} className={svcBusy ? "spin" : undefined} />
            </button>
          </div>
          {services.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>
              暂无运行中的服务——让小逻部署并启动程序后，服务会出现在这里。
            </div>
          ) : (
            services.map((sv) => {
              const live = sv.status === "running";
              return (
                <div
                  key={sv.id}
                  style={{ borderTop: "1px solid #f3f4f6", padding: "6px 0", display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        flexShrink: 0,
                        background: live ? "#16a34a" : "#9ca3af",
                      }}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#374151", flex: 1 }}>
                      {sv.command}
                    </span>
                    <span style={{ color: "#9ca3af", flexShrink: 0 }}>{live ? "运行中" : sv.status}</span>
                    {sv.url ? (
                      <button
                        type="button"
                        title={sv.url + "（在外部浏览器打开）"}
                        onClick={() => openExternalUrl(sv.url as string)}
                        style={{ border: "none", background: "none", cursor: "pointer", color: "#4f46e5", display: "inline-flex", alignItems: "center", flexShrink: 0, padding: 0 }}
                      >
                        <ExternalLink size={12} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      title="停止服务"
                      onClick={() => void stopService(sv.id)}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", fontSize: 12, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3 }}
                    >
                      <Square size={10} />
                      停止
                    </button>
                  </div>
                  {sv.logTail ? (
                    <div
                      style={{
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: 11,
                        color: "#9ca3af",
                        whiteSpace: "pre-wrap",
                        maxHeight: 72,
                        overflow: "hidden",
                      }}
                    >
                      {sv.logTail}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {tab === "preview" ? (
          sandboxDoc ? (
            <div style={{ height: "100%" }}>
              <SandboxFrame preview={sandboxDoc} fill />
            </div>
          ) : (
            <div
              style={{
                height: "100%",
                display: "grid",
                placeItems: "center",
                color: "#8a8f98",
                fontSize: 13,
                textAlign: "center",
                padding: 24,
              }}
            >
              <div>
                <div style={{ fontSize: 34 }}>🧪</div>
                <div style={{ fontWeight: 700, color: "#333", marginTop: 6 }}>沙箱预览</div>
                <div style={{ marginTop: 4 }}>
                  让小逻写前端代码后，这里会以隔离沙箱直接运行它；浏览器内容请看「浏览器」页签。
                </div>
              </div>
            </div>
          )
        ) : tab === "browser" ? (
          <div style={{ height: "100%" }}>
            <BrowserFrame preview={browserPreview} fill reloadKey={snapshot?.syncNonce ?? 0} />
          </div>
        ) : effectiveArtifact ? (
          <div style={{ height: "100%" }}>
            <CodeCard
              artifact={effectiveArtifact}
              fill
              onFileChange={(path, content) => {
                setFileOverrides((m) => ({ ...m, [path]: content }));
                // EDIT-SYNC：手改回写对话代理产物，下一轮小逻基于最新代码修改
                window.dispatchEvent(
                  new CustomEvent("xiaoluo-artifact-edit", { detail: { files: [{ path, content }] } }),
                );
              }}
              onShareToCapability={onShareToCapability}
            />
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
