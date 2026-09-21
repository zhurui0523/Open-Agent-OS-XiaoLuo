"use client";

/**
 * 设置 → 本地 AI：大模型启动器（安装 / 下载 / 启动 / 注册）。
 * 二期：模型库按模态分组（文本/图片/视频）、硬件门禁、双引擎管理面板、
 * 多文件聚合下载进度、超大模型二次确认、许可提示、空闲 TTL 与开机自启。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  MemoryStick,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { SelectMenu } from "./select-menu";

type LocalAiResult = { ok: boolean; data?: unknown; message?: string };
type LocalAiAction = (payload: { action: string; [key: string]: unknown }) => Promise<LocalAiResult>;
type Modality = "text" | "image" | "video";
type EngineKind = "text" | "diffusion";

interface LocalAiModel {
  id: string;
  name: string;
  modality: Modality;
  description: string;
  minTier: string;
  license: string;
  confirmHuge: boolean;
  context: number;
  fileCount: number;
  fileName: string;
  sizeBytes: number;
  installed: boolean;
  downloadedBytes: number;
  downloading: boolean;
  gate: { ok: boolean; reason: string };
  custom?: boolean;
  filePath?: string;
}
interface LocalAiHardware {
  tier: string;
  gpuName: string;
  reason: string;
  totalRamBytes: number;
  freeDiskBytes: number;
  vramBytes?: number;
  capabilities?: { text: boolean; image: boolean; video: boolean };
}
interface LocalAiEngine {
  kind?: EngineKind;
  installed: boolean;
  engineVersion: string;
  status: string;
  modelId: string | null;
  modelName: string | null;
  modality?: string | null;
  port: number;
  binaryKind?: string;
  error: string;
}
interface LocalAiSnapshot {
  engines: { text: LocalAiEngine; diffusion: LocalAiEngine };
  engine?: LocalAiEngine;
  hardware: LocalAiHardware;
  config: {
    storagePath: string;
    defaultModelId: string;
    preferredPort: number;
    diffusionPort?: number;
    idleTtlMinutes: number;
    autostart?: boolean;
  };
  models: LocalAiModel[];
  recommendedModelId: string;
}
interface DownloadEvent {
  modelId?: string;
  status?: string;
  receivedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  error?: string;
  fileIndex?: number;
  fileCount?: number;
  fileName?: string;
}

const tierLabels: Record<string, string> = {
  lite: "轻量档 · 仅文本",
  balanced: "均衡档 · 文本+图片",
  high: "高质量档 · 全模态",
};

const modalityLabels: Record<Modality, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
};

const MODALITIES: Modality[] = ["text", "image", "video"];

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.round(bytes / 1024 ** 2) + " MB";
}

function desktopBridge(): {
  localAi?: LocalAiAction;
  onLocalAiEvent?: (listener: (event: DownloadEvent) => void) => () => void;
} | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { xiaoluoDesktop?: unknown }).xiaoluoDesktop;
  if (!bridge || typeof bridge !== "object") return null;
  return bridge as { localAi?: LocalAiAction; onLocalAiEvent?: (listener: (event: DownloadEvent) => void) => () => void };
}

export function LocalAiSettings({
  workspaceId,
  onModelsChanged,
}: {
  workspaceId: string;
  onModelsChanged?: () => void;
}) {
  const bridge = useMemo(desktopBridge, []);
  const [snapshot, setSnapshot] = useState<LocalAiSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<Record<string, DownloadEvent>>({});
  const [storageDraft, setStorageDraft] = useState("");
  const [startModelId, setStartModelId] = useState("");
  const [tab, setTab] = useState<Modality>("text");
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [customContext, setCustomContext] = useState("8192");

  // DL-RETRY：下载失败/超时的模型集合（按钮显示「重试」）+ 提示自动消失定时器
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const timerSeqRef = useRef(0);
  const stallTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // DL-RETRY-2：最近一次真实进度签名（文件号:字节数），心跳事件不重置看门狗
  const lastSigRef = useRef<Record<string, string>>({});

  /** 提示统一出口：error/notice 5 秒后自动消失，避免通知堆积 */
  function sayError(message: string) {
    setError(message);
    const seq = ++timerSeqRef.current;
    setTimeout(() => {
      if (timerSeqRef.current === seq) setError("");
    }, 5000);
  }
  function sayNotice(message: string) {
    setNotice(message);
    const seq = ++timerSeqRef.current;
    setTimeout(() => {
      if (timerSeqRef.current === seq) setNotice("");
    }, 5000);
  }
  /** 下载超时/失败：清进度、模型转「重试」态，错误提示 5 秒自动消失 */
  function failDownload(modelId: string, message: string) {
    clearTimeout(stallTimersRef.current[modelId]);
    delete stallTimersRef.current[modelId];
    delete lastSigRef.current[modelId];
    setProgress((prev) => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    setFailed((prev) => ({ ...prev, [modelId]: true }));
    sayError(message);
  }
  /** 卡死看门狗：最近一次进度事件超过 30 秒（下载源静默超时）→ 判下载超时 */
  function armStallTimer(modelId: string) {
    clearTimeout(stallTimersRef.current[modelId]);
    stallTimersRef.current[modelId] = setTimeout(() => {
      failDownload(modelId, "下载超时：长时间没有进度，网络可能异常，点「重试」重新下载");
    }, 30000);
  }

  const refresh = useCallback(async () => {
    if (!bridge?.localAi) return;
    const result = await bridge.localAi({ action: "status" });
    if (result.ok && result.data) {
      const data = result.data as LocalAiSnapshot;
      setSnapshot(data);
      setStorageDraft(data.config.storagePath);
      setStartModelId((current) => {
        if (current && data.models.some((m) => m.id === current && m.installed)) return current;
        const installed = data.models.find((m) => m.installed);
        return data.config.defaultModelId || installed?.id || data.recommendedModelId;
      });
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const off = bridge?.onLocalAiEvent?.((event) => {
      // DOWNLOAD_FEEDBACK_V2 终态清理：失败/取消/完成时移除进度记录，按钮回到可点击状态
      if (event.modelId) {
        const id = event.modelId as string;
        if (event.status === "failed" || event.status === "cancelled") {
          clearTimeout(stallTimersRef.current[id]);
          delete stallTimersRef.current[id];
          delete lastSigRef.current[id];
          if (event.status === "failed") {
            sayError(
              "下载失败：" + (event.error || "网络异常，已自动重试 3 次仍失败，请检查网络后点击重试"),
            );
          }
          setProgress((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        } else {
          setProgress((prev) => ({ ...prev, [id]: event }));
          if (event.status === "done") {
            clearTimeout(stallTimersRef.current[id]);
            delete stallTimersRef.current[id];
            delete lastSigRef.current[id];
          } else if (event.status !== "paused") {
            // DL-RETRY-2：字节数/文件号有变化才算真实进度并重置看门狗；纯心跳事件不重置，避免无限续命
            const sig = (event.fileIndex ?? 0) + ":" + (event.receivedBytes ?? 0);
            if (sig !== lastSigRef.current[id]) {
              lastSigRef.current[id] = sig;
              armStallTimer(id);
            } else if (!stallTimersRef.current[id]) {
              // DL-STALL-FIX: 仅当定时器不存在（孤儿场景没人挂过）才补挂，
              // 存在时绝不重挂——重挂会把 30 秒判死倒计时清零，被连续心跳无限续命
              armStallTimer(id);
            }
          }
        }
      }
      void refresh();
    });
    return () => {
      clearInterval(timer);
      off?.();
      for (const t of Object.values(stallTimersRef.current)) clearTimeout(t);
      stallTimersRef.current = {};
    };
  }, [bridge, refresh]);

  // DL-RETRY-2 孤儿看门狗：主进程报下载中但本地无进度事件（面板重建/重开设置页/事件错过）
  // 时同样挂超时判定，避免灰色「下载中…」永远卡死；定时器只挂一次，不随每 3 秒刷新重置
  useEffect(() => {
    if (!snapshot) return;
    for (const model of snapshot.models) {
      // DL-STALL-FIX: 只有模型确实不再下载才清定时器；
      // 有进度记录时定时器由事件流维护（真实进度重置/到期判死），此处不插手，
      // 否则与心跳事件互相抵消，定时器被无限续命，永远转不出「重试」
      if (!model.downloading || model.installed) {
        if (!progress[model.id]) {
          clearTimeout(stallTimersRef.current[model.id]);
          delete stallTimersRef.current[model.id];
        }
        continue;
      }
      if (progress[model.id]) continue;
      if (!failed[model.id] && !stallTimersRef.current[model.id]) armStallTimer(model.id);
    }
  }, [snapshot, progress, failed]);

  /** 引擎状态变化后同步服务端：注册/禁用本地 ModelConnection，并刷新模型列表 */
  const syncServer = useCallback(async () => {
    try {
      const res = await fetch(
        "/api/v2/local-ai?workspaceId=" + encodeURIComponent(workspaceId),
      );
      if (res.ok) onModelsChanged?.();
    } catch {
      /* 服务端同步失败不阻塞本地操作 */
    }
  }, [workspaceId, onModelsChanged]);

  async function act(
    action: string,
    payload: Record<string, unknown> = {},
    successMessage = "",
  ): Promise<boolean> {
    if (!bridge?.localAi) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge.localAi({ action, ...payload });
      if (!result.ok) throw new Error(result.message || "操作失败");
      if (successMessage) sayNotice(successMessage);
      await refresh();
      if (action === "start-model" || action === "stop-engine" || action === "delete-model") {
        await syncServer();
      }
      return true;
    } catch (caught) {
      sayError(caught instanceof Error ? caught.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 超大模型（Kimi-K2 等）：下载前二次确认，给出体积/耗时预估 */
  function confirmDownload(model: LocalAiModel) {
    if (!model.confirmHuge) return true;
    const message =
      model.name + " 体积约 " + formatBytes(model.sizeBytes) +
      "（" + model.fileCount + " 个文件），下载耗时可能长达数小时，" +
      "且需要充足磁盘与内存。确认继续下载吗？";
    return window.confirm(message);
  }

  /** 选择本地模型文件（桌面端原生对话框） */
  async function pickCustomFile() {
    if (!bridge?.localAi) return;
    const result = await bridge.localAi({ action: "pick-model-file" });
    if (result.ok && result.data) {
      const data = result.data as { filePath?: string };
      if (data.filePath) {
        setCustomPath(data.filePath);
        if (!customName.trim()) setCustomName(data.filePath.split(/[\\/]/).pop() || "");
      }
    }
  }

  /** 注册自定义本地模型（仅登记，文件保持在用户原位置） */
  async function submitCustomModel() {
    if (!customPath.trim()) {
      setError("请选择模型文件（.gguf / .bin）");
      return;
    }
    await act(
      "add-custom-model",
      {
        name: customName.trim(),
        filePath: customPath.trim(),
        context: Number(customContext) || 8192,
      },
      "已添加本地模型",
    );
    setCustomOpen(false);
    setCustomName("");
    setCustomPath("");
    setCustomContext("8192");
  }

  if (!bridge?.localAi) {
    return (
      <div className="local-ai-page">
        <div className="settings-section-heading">
          <div>
            <h3>本地 AI</h3>
            <p>在本机安装并启动大模型，直接接入对话框与画布节点。</p>
          </div>
        </div>
        <div className="local-ai-card">
          <div className="local-ai-step-head">
            <Cpu size={16} />
            <span>需要桌面客户端</span>
          </div>
          <p className="local-ai-hint">
            本地大模型启动器依赖小逻桌面客户端（Electron 主进程托管推理引擎）。
            当前处于网页模式，请打开桌面客户端后在设置中访问本页面。
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="local-ai-page">
        <div className="local-ai-card">
          <p className="local-ai-hint">正在读取本地 AI 状态…</p>
        </div>
      </div>
    );
  }

  const { engines, hardware, config, models } = snapshot;
  const textEngine = engines.text;
  const diffusionEngine = engines.diffusion;
  const installedModels = models.filter((m) => m.installed);

  function modelProgress(modelId: string) {
    const event = progress[modelId];
    if (!event) return null;
    return {
      percent:
        event.receivedBytes && event.totalBytes
          ? Math.min(100, Math.round((event.receivedBytes / event.totalBytes) * 100))
          : 0,
      speed: event.speedBps ? formatBytes(event.speedBps) + "/s" : "",
      status: event.status || "downloading",
      fileIndex: event.fileIndex ?? 0,
      fileCount: event.fileCount ?? 1,
      fileName: event.fileName || "",
    };
  }

  function renderModelRow(model: LocalAiModel) {
    const prog = modelProgress(model.id);
    const isDefault = config.defaultModelId === model.id;
    const engine = model.modality === "text" ? textEngine : diffusionEngine;
    const isRunningModel = engine.status === "running" && engine.modelId === model.id;
    const gateOk = model.gate?.ok !== false;
    return (
      <div className="local-ai-model-row" key={model.id}>
        <div className="local-ai-model-info">
          <strong>
            {model.name}
            {isDefault && <span className="local-ai-tier-badge">默认</span>}
            {isRunningModel && <span className="local-ai-tier-badge is-live">运行中</span>}
            {!gateOk && <span className="local-ai-tier-badge is-warn">硬件不满足</span>}
            {model.custom && <span className="local-ai-tier-badge">自定义</span>}
          </strong>
          <span className="local-ai-hint">{model.description}</span>
          <span className="local-ai-hint">
            {formatBytes(model.sizeBytes)}
            {model.fileCount > 1 ? " · " + model.fileCount + " 个文件" : ""}
            {model.context ? " · 上下文 " + model.context : ""}
            {!model.custom ? " · 建议 " + (tierLabels[model.minTier] ?? model.minTier) : ""}
          </span>
          {!gateOk && model.gate?.reason && (
            <span className="local-ai-hint">门禁：{model.gate.reason}</span>
          )}
          {model.license && (
            <span className="local-ai-hint local-ai-license">许可提示：{model.license}</span>
          )}
          {/* DOWNLOAD_FEEDBACK_V2 全阶段状态提示：连接中/下载中/校验中/重试中/已暂停 */}
          {prog &&
            (prog.status === "queued" || (prog.status === "downloading" && !prog.percent)) ? (
            <span className="local-ai-hint">⏳ 正在连接下载源，请稍候…</span>
          ) : prog ? (
            <span className="local-ai-progress-track">
              <span className="local-ai-progress" style={{ width: prog.percent + "%" }} />
              <em>
                {prog.fileCount > 1
                  ? "第 " + prog.fileIndex + "/" + prog.fileCount + " 个文件 · "
                  : ""}
                {prog.percent}%{prog.speed ? " · " + prog.speed : ""}
                {prog.status === "verifying" ? " · 校验中" : ""}
                {prog.status === "retrying" ? " · 重试中（网络异常将自动重试 3 次）" : ""}
                {prog.status === "paused" ? " · 已暂停" : ""}
              </em>
            </span>
          ) : null}
        </div>
        <div className="local-ai-actions">
          {!model.installed && !prog && model.downloading && !model.custom && !failed[model.id] && (
            <button type="button" className="local-ai-btn" disabled>
              <Pause size={13} /> 下载中…
            </button>
          )}
          {!model.installed && !prog && failed[model.id] && !model.custom && (
            <button
              type="button"
              className="local-ai-btn is-primary"
              disabled={busy || !gateOk}
              onClick={() => {
                setFailed((prev) => {
                  const next = { ...prev };
                  delete next[model.id];
                  return next;
                });
                setError("");
                void (async () => {
                  await act("cancel-download", { modelId: model.id });
                  const ok = await act(
                    "download-model",
                    { modelId: model.id },
                    "正在重试下载 " + model.name + "…",
                  );
                  if (ok) armStallTimer(model.id);
                })();
              }}
            >
              <RefreshCw size={13} /> 重试
            </button>
          )}
          {!model.installed && !prog && !model.downloading && !model.custom && !failed[model.id] && (
            <button
              type="button"
              className="local-ai-btn is-primary"
              disabled={busy || !gateOk}
              title={gateOk ? "" : model.gate?.reason || "当前硬件不满足该模型要求"}
              onClick={() => {
                if (!confirmDownload(model)) return;
                // DOWNLOAD_FEEDBACK_V2 立即给出“准备中”反馈，等待主进程首个下载事件接管
                setProgress((prev) => ({
                  ...prev,
                  [model.id]: { modelId: model.id, status: "queued" },
                }));
                void (async () => {
                  const ok = await act(
                    "download-model",
                    { modelId: model.id },
                    "正在下载 " + model.name + "…",
                  );
                  if (!ok) {
                    // act 失败：清掉占位状态，让“下载”按钮重新出现（错误条已由 act 显示）
                    setProgress((prev) => {
                      const next = { ...prev };
                      delete next[model.id];
                      return next;
                    });
                    return;
                  }
                  // 15 秒内没收到任何下载事件 → 判定连接超时，给出明确提示并允许重试
                  setTimeout(() => {
                    setProgress((prev) => {
                      const cur = prev[model.id];
                      if (cur && (cur.status === "queued" || !cur.status)) {
                        failDownload(
                          model.id,
                          model.name + " 下载请求超时：15 秒内未开始接收数据，点「重试」重新下载",
                        );
                      }
                      return prev;
                    });
                  }, 15000);
                })();
              }}
            >
              <Download size={13} /> 下载
            </button>
          )}
          {prog && prog.status !== "done" && (
            <>
              {prog.status === "paused" ? (
                <button
                  type="button"
                  className="local-ai-btn"
                  disabled={busy}
                  onClick={() => void act("resume-download", { modelId: model.id })}
                >
                  <Play size={12} /> 继续
                </button>
              ) : (
                <button
                  type="button"
                  className="local-ai-btn"
                  disabled={busy}
                  onClick={() => void act("pause-download", { modelId: model.id })}
                >
                  <Pause size={12} /> 暂停
                </button>
              )}
              <button
                type="button"
                className="local-ai-btn"
                disabled={busy}
                onClick={() => void act("cancel-download", { modelId: model.id })}
              >
                <Square size={12} /> 取消
              </button>
            </>
          )}
          {model.installed && (
            <>
              <button
                type="button"
                className="local-ai-btn"
                disabled={busy || isRunningModel}
                onClick={() => void act("start-model", { modelId: model.id }, model.name + " 已启动")}
              >
                <Play size={13} /> 启动
              </button>
              {!isDefault && (
                <button
                  type="button"
                  className="local-ai-btn"
                  disabled={busy}
                  onClick={() => void act("set-default", { modelId: model.id }, "已设为默认模型")}
                >
                  <Check size={13} /> 设为默认
                </button>
              )}
              <button
                type="button"
                className="local-ai-btn is-danger"
                disabled={busy || isRunningModel}
                onClick={() => void act("delete-model", { modelId: model.id }, "已删除 " + model.name)}
              >
                <Trash2 size={13} /> 删除
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderModelLibrary() {
    return (
      <>
        <div className="local-ai-tabs" role="tablist" aria-label="模型模态分组">
          {MODALITIES.map((modality) => {
            const count = models.filter((m) => m.modality === modality).length;
            return (
              <button
                key={modality}
                type="button"
                role="tab"
                aria-selected={tab === modality}
                className={"local-ai-tab" + (tab === modality ? " is-active" : "")}
                onClick={() => setTab(modality)}
              >
                {modalityLabels[modality]}（{count}）
              </button>
            );
          })}
        </div>
        {tab === "text" && (
          <div className="local-ai-actions">
            <button
              type="button"
              className="local-ai-btn"
              onClick={() => setCustomOpen((value) => !value)}
            >
              <Plus size={13} /> 添加本地模型
            </button>
            <span className="local-ai-hint">已有 GGUF 文件？可手动注册并启动，无需下载。</span>
          </div>
        )}
        {tab === "text" && customOpen && (
          <div className="local-ai-custom-form">
            <input
              className="local-ai-input"
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder="模型名称（可选，默认取文件名）"
            />
            <span className="local-ai-custom-row">
              <input
                className="local-ai-input"
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
                placeholder="模型文件路径（.gguf / .bin）"
                style={{ flex: 1 }}
              />
              <button type="button" className="local-ai-btn" disabled={busy} onClick={() => void pickCustomFile()}>
                <FolderOpen size={13} /> 浏览…
              </button>
            </span>
            <span className="local-ai-custom-row">
              <input
                className="local-ai-input"
                value={customContext}
                onChange={(event) => setCustomContext(event.target.value.replace(/\D/g, ""))}
                placeholder="上下文长度"
                style={{ width: 160 }}
              />
              <button type="button" className="local-ai-btn is-primary" disabled={busy || !customPath.trim()} onClick={() => void submitCustomModel()}>
                <Check size={13} /> 添加
              </button>
            </span>
          </div>
        )}
        {models.filter((m) => m.modality === tab).map(renderModelRow)}
      </>
    );
  }

  function renderEnginePanel(kind: EngineKind, title: string, engine: LocalAiEngine) {
    const running = engine.status === "running";
    return (
      <div className="local-ai-engine-panel">
        <div className="local-ai-step-head">
          <span
            className={
              "local-ai-status-dot" +
              (running ? " is-running" : engine.status === "crashed" ? " is-crashed" : engine.status === "starting" ? " is-starting" : "")
            }
          />
          <span>
            {title}：
            {running
              ? "运行中（" + (engine.modelName || engine.modelId) + " · 端口 " + engine.port + "）"
              : engine.status === "starting"
                ? "启动中…"
                : engine.status === "crashed"
                  ? "已崩溃"
                  : "已停止"}
          </span>
        </div>
        {engine.error && <p className="local-ai-hint">{engine.error}</p>}
        <div className="local-ai-meta">
          <span>{engine.engineVersion}</span>
        </div>
        {running && (
          <div className="local-ai-actions">
            <button
              type="button"
              className="local-ai-btn"
              disabled={busy}
              onClick={() => void act("stop-engine", { kind }, title + "已停止")}
            >
              <Pause size={13} /> 停止
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---------- 未安装：六步向导 ----------
  if (!textEngine.installed) {
    return (
      <div className="local-ai-page">
        <div className="settings-section-heading">
          <div>
            <h3>本地 AI</h3>
            <p>按步骤在本机安装推理引擎与大模型，完成后自动接入对话框与画布节点。</p>
          </div>
        </div>
        {error && <div className="settings-alert is-error"><span>{error}</span></div>}
        {notice && <div className="settings-alert is-success"><span>{notice}</span></div>}

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">1</span> 检测环境</div>
          <div className="local-ai-meta">
            <span><Cpu size={13} /> {hardware.gpuName || "未检测到独显（CPU 推理）"}</span>
            <span><MemoryStick size={13} /> 内存 {formatBytes(hardware.totalRamBytes)}</span>
          </div>
          <div className="local-ai-meta">
            <span><HardDrive size={13} /> 磁盘可用 {formatBytes(hardware.freeDiskBytes)}</span>
            {typeof hardware.vramBytes === "number" && hardware.vramBytes > 0 && (
              <span>显存 {formatBytes(hardware.vramBytes)}</span>
            )}
          </div>
          <span className="local-ai-tier-badge">{tierLabels[hardware.tier] ?? hardware.tier}</span>
          <p className="local-ai-hint">{hardware.reason}</p>
        </div>

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">2</span> 安装引擎</div>
          <p className="local-ai-hint">
            嵌入式推理引擎随客户端内置（llama.cpp 文本 + stable-diffusion.cpp 图片/视频），无需安装任何第三方工具。
          </p>
          <div className="local-ai-actions">
            <button
              type="button"
              className="local-ai-btn is-primary"
              disabled={busy}
              onClick={() => void act("install-engine", {}, "引擎已就绪")}
            >
              <Power size={13} /> 安装引擎
            </button>
          </div>
        </div>

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">3</span> 选择存储位置</div>
          <input
            className="local-ai-input"
            value={storageDraft}
            onChange={(event) => setStorageDraft(event.target.value)}
            placeholder="模型文件存储目录"
          />
          <div className="local-ai-actions">
            <button
              type="button"
              className="local-ai-btn"
              disabled={busy || !storageDraft.trim()}
              onClick={() => void act("set-storage-path", { path: storageDraft.trim() }, "存储位置已保存")}
            >
              保存位置
            </button>
          </div>
        </div>

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">4</span> 下载大模型</div>
          <p className="local-ai-hint">
            覆盖文本/图片/视频最新开源模型（Kimi K3、Qwen3.8、DeepSeek V4 等）；支持断点续传、多文件编排与完整性校验，也可手动添加本地已下载的模型文件。
          </p>
          {renderModelLibrary()}
        </div>

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">5</span> 校验文件</div>
          <p className="local-ai-hint">下载完成后自动校验文件完整性，失败会自动重下。</p>
        </div>

        <div className="local-ai-card">
          <div className="local-ai-step-head"><span className="local-ai-step-num">6</span> 试运行</div>
          {installedModels.length === 0 ? (
            <p className="local-ai-hint">先完成上一步的模型下载。</p>
          ) : (
            <div className="local-ai-actions">
              <button
                type="button"
                className="local-ai-btn is-primary"
                disabled={busy || textEngine.status === "running" || diffusionEngine.status === "running"}
                onClick={() => void act("start-model", { modelId: startModelId }, "引擎试运行成功")}
              >
                <Play size={13} /> 启动引擎试运行
              </button>
            </div>
          )}
          {(textEngine.status === "running" || diffusionEngine.status === "running") && (
            <p className="local-ai-hint">引擎运行中，安装完成，可在下方管理面板操作。</p>
          )}
        </div>
      </div>
    );
  }

  // ---------- 已安装：管理面板 ----------
  return (
    <div className="local-ai-page">
      <div className="settings-section-heading">
        <div>
          <h3>本地 AI</h3>
          <p>管理本地推理引擎与模型；运行中的模型会自动出现在对话框与画布节点的模型列表。</p>
        </div>
        <button
          type="button"
          className="local-ai-btn"
          onClick={() => void refresh()}
          aria-label="刷新本地 AI 状态"
        >
          <RefreshCw size={13} /> 刷新
        </button>
      </div>
      {error && <div className="settings-alert is-error"><span>{error}</span></div>}
      {notice && <div className="settings-alert is-success"><span>{notice}</span></div>}

      <div className="local-ai-card">
        <div className="local-ai-step-head">引擎状态（双引擎）</div>
        <div className="local-ai-engine-grid">
          {renderEnginePanel("text", "文本引擎（llama.cpp）", textEngine)}
          {renderEnginePanel("diffusion", "扩散引擎（sd.cpp · 图片/视频）", diffusionEngine)}
        </div>
        <div className="local-ai-meta">
          <span>{tierLabels[hardware.tier] ?? hardware.tier}</span>
          <span>{hardware.gpuName || "CPU 推理"}</span>
        </div>
        <div className="local-ai-actions">
          {installedModels.length > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <SelectMenu
                ariaLabel="选择要启动的模型"
                value={startModelId}
                onChange={(next) => setStartModelId(next)}
                disabled={busy}
                options={installedModels.map((m) => ({
                  value: m.id,
                  label: m.name + "（" + modalityLabels[m.modality] + "）",
                }))}
              />
              <button
                type="button"
                className="local-ai-btn is-primary"
                disabled={busy || !startModelId}
                onClick={() => void act("start-model", { modelId: startModelId }, "引擎已启动")}
              >
                <Play size={13} /> 启动
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="local-ai-card">
        <div className="local-ai-step-head">模型库</div>
        {renderModelLibrary()}
      </div>

      <div className="local-ai-card">
        <div className="local-ai-step-head">生命周期</div>
        <div className="local-ai-actions">
          <span className="local-ai-hint">空闲自动停止：</span>
          <SelectMenu
            ariaLabel="空闲自动停止时间"
            value={String(config.idleTtlMinutes ?? 10)}
            onChange={(next) =>
              void act(
                "set-config",
                { idleTtlMinutes: Number(next) },
                Number(next) === 0 ? "已关闭空闲自动停止" : "空闲 " + next + " 分钟自动停止",
              )
            }
            disabled={busy}
            options={[
              { value: "5", label: "5 分钟" },
              { value: "10", label: "10 分钟" },
              { value: "30", label: "30 分钟" },
              { value: "0", label: "关闭" },
            ]}
          />
          <label className="local-ai-hint" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={Boolean(config.autostart)}
              disabled={busy}
              onChange={(event) =>
                void act(
                  "set-config",
                  { autostart: event.target.checked },
                  event.target.checked ? "已开启开机自启" : "已关闭开机自启",
                )
              }
            />
            开机自启客户端（便于空闲唤醒）
          </label>
        </div>
      </div>

      <div className="local-ai-card">
        <div className="local-ai-step-head">存储位置</div>
        <input
          className="local-ai-input"
          value={storageDraft}
          onChange={(event) => setStorageDraft(event.target.value)}
          placeholder="模型文件存储目录"
        />
        <div className="local-ai-actions">
          <button
            type="button"
            className="local-ai-btn"
            disabled={busy || !storageDraft.trim()}
            onClick={() => void act("set-storage-path", { path: storageDraft.trim() }, "存储位置已保存")}
          >
            保存位置
          </button>
        </div>
      </div>
    </div>
  );
}
