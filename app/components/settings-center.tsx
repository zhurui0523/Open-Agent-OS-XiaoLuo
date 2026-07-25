"use client";

import {
  Check,
  Activity,
  ChevronRight,
  CircleAlert,
  KeyRound,
  Keyboard,
  MousePointer2,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { IntentOSController } from "../hooks/use-intent-os";
import type {
  AccountUser,
  GesturePreset,
  ModelConnection,
  ModelConnectionDraft,
  ModelProtocol,
  ModelUsageSummary,
  NodeKind,
  UserPreferences,
} from "../types";
import { IconButton } from "./icon-button";
import { AdminOperations } from "./admin-operations";
import { PersonalSettings } from "./personal-settings";

type SettingsTab = "account" | "api" | "gesture" | "shortcuts" | "kernel";

const emptyDraft: ModelConnectionDraft = {
  name: "",
  protocol: "openai-compatible",
  baseUrl: "",
  modelName: "",
  modalities: ["text"],
  secretValue: "",
  secretName: "",
  priority: 100,
  fallbackModelId: null,
  maxConcurrency: 2,
  retryLimit: 3,
  circuitFailureThreshold: 5,
  circuitCooldownSeconds: 60,
};

const emptyUsage: ModelUsageSummary = {
  text: { total: 0, success: 0, failure: 0 },
  image: { total: 0, success: 0, failure: 0 },
  video: { total: 0, success: 0, failure: 0 },
  retryCount: 0,
  fallbackCount: 0,
};

const protocols: Array<{ value: ModelProtocol; label: string }> = [
  { value: "openai-compatible", label: "OpenAI 兼容" },
  { value: "anthropic-compatible", label: "Anthropic 兼容" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ark", label: "火山方舟" },
  { value: "async-video", label: "视频生成服务" },
];

const protocolLabels = Object.fromEntries(
  protocols.map((item) => [item.value, item.label]),
) as Partial<Record<ModelProtocol, string>>;

const gesturePresets: Array<{
  id: GesturePreset;
  title: string;
  description: string;
  mapping: string;
}> = [
  {
    id: "figma",
    title: "Figma 模式",
    description: "适合鼠标与触控板混合使用",
    mapping: "滚轮平移，Ctrl / ⌘ + 滚轮缩放",
  },
  {
    id: "trackpad",
    title: "触控板模式",
    description: "双指移动画布，捏合缩放",
    mapping: "双指平移，系统捏合缩放",
  },
  {
    id: "zoom-wheel",
    title: "滚轮缩放",
    description: "更接近传统流程图工具",
    mapping: "滚轮缩放，Shift + 滚轮横移",
  },
];

const shortcuts = [
  ["保存画布", "自动保存"],
  ["撤销", "Ctrl / ⌘ + Z"],
  ["删除节点或连线", "Delete / Backspace"],
  ["创建文本 / 图片 / 视频节点", "1 / 2 / 3"],
  ["临时抓手", "Space + 拖动"],
  ["画布复位", "F 或 0"],
  ["显示 / 隐藏小地图", "H"],
  ["放大 / 缩小", "+ / −"],
  ["关闭菜单或取消连线", "Escape"],
];

function draftFromModel(model: ModelConnection): ModelConnectionDraft {
  const protocol =
    model.protocol === "generic-rest"
      ? "openai-compatible"
      : (model.protocol ?? "openai-compatible");
  return {
    name: model.name,
    protocol,
    baseUrl: model.baseUrl ?? "",
    modelName: model.modelName ?? "",
    modalities: model.modalities,
    credentialRef: model.credentialRef,
    secretRefId: model.secretRefId,
    secretValue: "",
    secretName: `${model.name} API Key`,
    priority: model.priority ?? 100,
    fallbackModelId: model.fallbackModelId ?? null,
    maxConcurrency: model.maxConcurrency ?? 2,
    retryLimit: model.retryLimit ?? 3,
    circuitFailureThreshold: model.circuitFailureThreshold ?? 5,
    circuitCooldownSeconds: model.circuitCooldownSeconds ?? 60,
  };
}

function modelHost(model: ModelConnection) {
  try {
    return new URL(model.baseUrl ?? "").host;
  } catch {
    return model.baseUrl || "尚未配置地址";
  }
}

interface SettingsCenterProps {
  os: IntentOSController;
  user: AccountUser;
  onUserUpdate: (user: AccountUser) => void;
  onOpenAccount: () => void;
  onClose: () => void;
}

export function SettingsCenter({
  os,
  user,
  onUserUpdate,
  onOpenAccount,
  onClose,
}: SettingsCenterProps) {
  const [tab, setTab] = useState<SettingsTab>("account");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelConnectionDraft>(emptyDraft);
  const [preferences, setPreferences] = useState<UserPreferences>(
    os.preferences,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<ModelUsageSummary>(emptyUsage);
  const [usageLoading, setUsageLoading] = useState(false);

  const connectedCount = useMemo(
    () => os.models.filter((model) => model.state === "healthy").length,
    [os.models],
  );

  useEffect(() => {
    if (tab !== "api" || editorOpen || !os.workspaceId) return;
    const controller = new AbortController();
    void fetch(
      `/api/v2/models/stats?workspaceId=${encodeURIComponent(os.workspaceId)}&days=30`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = (await response.json()) as {
          usage?: ModelUsageSummary;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "读取调用统计失败");
        if (payload.usage) setUsage(payload.usage);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "读取调用统计失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setUsageLoading(false);
      });
    return () => controller.abort();
  }, [editorOpen, os.workspaceId, tab]);

  function openCreate() {
    setEditingId(null);
    setDraft({ ...emptyDraft });
    setError("");
    setNotice("");
    setEditorOpen(true);
  }

  function openEdit(model: ModelConnection) {
    setEditingId(model.id);
    setDraft(draftFromModel(model));
    setError("");
    setNotice("");
    setEditorOpen(true);
  }

  function toggleModality(kind: NodeKind) {
    setDraft((current) => {
      const selected = current.modalities.includes(kind)
        ? current.modalities.filter((item) => item !== kind)
        : [...current.modalities, kind];
      return { ...current, modalities: selected };
    });
  }

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!draft.modalities.length) {
      setError("请至少选择一种模型能力。");
      return;
    }
    setBusy(true);
    try {
      if (editingId) {
        await os.updateModel(editingId, draft);
        setNotice("API 连接已更新。");
      } else {
        await os.createModel(draft);
        setNotice("API 连接已添加。");
      }
      setEditorOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeModel(model: ModelConnection) {
    if (!window.confirm(`确定删除“${model.name}”吗？节点将不再能选择它。`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await os.deleteModel(model.id);
      setNotice(`已删除 ${model.name}。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(model: ModelConnection) {
    setBusy(true);
    setError("");
    try {
      const message = await os.testModel(model.id);
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "连接测试失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePreferences(next = preferences) {
    setBusy(true);
    setError("");
    try {
      const saved = await os.updatePreferences(next);
      setPreferences(saved);
      setNotice("操作偏好已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  function selectTab(next: SettingsTab) {
    setTab(next);
    setUsageLoading(next === "api");
    setEditorOpen(false);
    setError("");
    setNotice("");
  }

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">SYSTEM PREFERENCES</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <IconButton label="关闭设置" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>

        <div className="settings-layout">
          <aside className="settings-sidebar" aria-label="设置分类">
            <button
              type="button"
              className={tab === "account" ? "active" : ""}
              onClick={() => selectTab("account")}
            >
              <UserRound size={17} />
              <span>个人中心</span>
              <ChevronRight size={14} />
            </button>
            {user.platformRole === "system_admin" && (
              <button
                type="button"
                className={tab === "kernel" ? "active" : ""}
                onClick={() => selectTab("kernel")}
              >
                <Activity size={17} />
                <span>内核运维</span>
                <ChevronRight size={14} />
              </button>
            )}
            <button
              type="button"
              className={tab === "api" ? "active" : ""}
              onClick={() => selectTab("api")}
            >
              <KeyRound size={17} />
              <span>API Key</span>
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              className={tab === "gesture" ? "active" : ""}
              onClick={() => selectTab("gesture")}
            >
              <MousePointer2 size={17} />
              <span>手势</span>
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              className={tab === "shortcuts" ? "active" : ""}
              onClick={() => selectTab("shortcuts")}
            >
              <Keyboard size={17} />
              <span>快捷键</span>
              <ChevronRight size={14} />
            </button>
            <div className="settings-security-note">
              <ShieldCheck size={16} />
              <span>
                密钥由服务端加密保存，浏览器不会读取或回显已保存的明文。
              </span>
            </div>
          </aside>

          <main className="settings-content">
            {tab !== "account" && error && (
              <div className="settings-alert is-error">
                <CircleAlert size={15} />
                <span>{error}</span>
              </div>
            )}
            {tab !== "account" && notice && (
              <div className="settings-alert is-success">
                <Check size={15} />
                <span>{notice}</span>
              </div>
            )}

            {tab === "account" && (
              <PersonalSettings
                user={user}
                onUserUpdate={onUserUpdate}
                onOpenAccount={onOpenAccount}
              />
            )}
            {tab === "kernel" && <AdminOperations />}

            {tab === "api" && !editorOpen && (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>API Key</h3>
                    <p>
                      已配置 {os.models.length} 个连接，{connectedCount}{" "}
                      个当前健康。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={openCreate}
                  >
                    <Plus size={16} /> 添加 API
                  </button>
                </div>
                <section className="model-usage-section" aria-label="近 30 天调用统计">
                  <div className="model-usage-heading">
                    <strong>近 30 天调用</strong>
                    <span>
                      {usageLoading
                        ? "统计读取中…"
                        : `重试 ${usage.retryCount} 次 · 备用切换 ${usage.fallbackCount} 次`}
                    </span>
                  </div>
                  <div className="model-usage-grid">
                    {(["text", "image", "video", "audio", "document"] as NodeKind[]).map((kind) => {
                      const item = usage[kind];
                      return (
                        <article key={kind} className={`is-${kind}`}>
                          <span>
                            {kind === "text"
                              ? "文本"
                              : kind === "image"
                                ? "图片"
                                : "视频"}
                          </span>
                          <strong>{item.total}</strong>
                          <small>
                            成功 {item.success} · 失败 {item.failure}
                          </small>
                        </article>
                      );
                    })}
                  </div>
                  <p>这里只统计调用次数与成功状态，不计算 Token、金额或第三方账单。</p>
                </section>
                <div className="api-connection-list">
                  {os.models.map((model) => (
                    <article key={model.id} className="api-connection-card">
                      <span className="api-provider-mark">
                        {model.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <div className="api-card-title">
                          <strong>{model.name}</strong>
                          <em className={`is-${model.state}`}>
                            {model.state === "healthy"
                              ? "已连接"
                              : model.state === "checking"
                                ? "检测中"
                                : "待检测"}
                          </em>
                        </div>
                        <p>
                          {model.modelName || "未指定模型"} · {modelHost(model)}
                        </p>
                        <small>
                          {protocolLabels[model.protocol ?? "openai-compatible"] ??
                            "模型接口"}
                          {" · "}
                          {model.secretRefId
                            ? "密钥已加密"
                            : model.credentialRef
                              ? `环境变量 ${model.credentialRef}`
                              : "未保存密钥"}
                        </small>
                        <div className="api-policy-summary">
                          <span>优先级 {model.priority ?? 100}</span>
                          <span>并发 {model.maxConcurrency ?? 2}</span>
                          <span>重试 {model.retryLimit ?? 3}</span>
                          <span>
                            熔断{" "}
                            {model.circuitState === "open"
                              ? "已打开"
                              : model.circuitState === "half_open"
                                ? "恢复检测"
                                : "正常"}
                          </span>
                          {model.fallbackModelId && (
                            <span>
                              备用{" "}
                              {os.models.find(
                                (candidate) =>
                                  candidate.id === model.fallbackModelId,
                              )?.name ?? "已配置"}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="api-card-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => void testConnection(model)}
                        >
                          测试
                        </button>
                        <IconButton
                          label={`编辑 ${model.name}`}
                          disabled={busy || model.protocol === "generic-rest"}
                          onClick={() => openEdit(model)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={`删除 ${model.name}`}
                          danger
                          disabled={busy}
                          onClick={() => void removeModel(model)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    </article>
                  ))}
                  {!os.models.length && (
                    <div className="settings-empty">
                      <KeyRound size={25} />
                      <strong>还没有 API 连接</strong>
                      <span>添加模型服务后，节点即可选择并调用它。</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === "api" && editorOpen && (
              <form className="api-key-editor" onSubmit={saveModel}>
                <div className="settings-section-heading">
                  <div>
                    <span className="eyebrow">
                      {editingId ? "EDIT CONNECTION" : "NEW CONNECTION"}
                    </span>
                    <h3>模型 API</h3>
                    <p>添加标准模型服务地址、模型 ID 与 API Key。</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setEditorOpen(false)}
                  >
                    返回列表
                  </button>
                </div>

                <div className="settings-form-grid">
                  <label>
                    连接名称
                    <input
                      required
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="例如：OpenAI、火山方舟"
                    />
                  </label>
                  <label>
                    API 类型
                    <select
                      value={draft.protocol}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          protocol: event.target.value as ModelProtocol,
                        }))
                      }
                    >
                      {protocols.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-span-two">
                    API 连接地址
                    <input
                      required
                      type="url"
                      value={draft.baseUrl}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          baseUrl: event.target.value,
                        }))
                      }
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                  <label>
                    模型 ID
                    <input
                      required
                      value={draft.modelName}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          modelName: event.target.value,
                        }))
                      }
                      placeholder="gpt-4.1 / doubao-..."
                    />
                  </label>
                  <label>
                    API Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.secretValue ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          secretValue: event.target.value,
                          secretName: `${current.name || "模型"} API Key`,
                        }))
                      }
                      placeholder={
                        editingId ? "留空则保留现有密钥" : "sk-••••••••"
                      }
                    />
                  </label>
                  <label>
                    路由优先级
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={draft.priority ?? 100}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          priority: Number(event.target.value),
                        }))
                      }
                    />
                    <small>数字越小越优先。</small>
                  </label>
                  <label>
                    最大并发
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={draft.maxConcurrency ?? 2}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxConcurrency: Number(event.target.value),
                        }))
                      }
                    />
                    <small>超过后进入技术限流，保护第三方接口。</small>
                  </label>
                  <label>
                    单连接重试次数
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={draft.retryLimit ?? 3}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          retryLimit: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    连续失败熔断阈值
                    <input
                      type="number"
                      min={2}
                      max={20}
                      value={draft.circuitFailureThreshold ?? 5}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          circuitFailureThreshold: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    熔断恢复等待（秒）
                    <input
                      type="number"
                      min={10}
                      max={600}
                      value={draft.circuitCooldownSeconds ?? 60}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          circuitCooldownSeconds: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    备用模型
                    <select
                      value={draft.fallbackModelId ?? ""}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          fallbackModelId: event.target.value || null,
                        }))
                      }
                    >
                      <option value="">自动选择同类型健康模型</option>
                      {os.models
                        .filter(
                          (model) =>
                            model.id !== editingId &&
                            model.modalities.some((kind) =>
                              draft.modalities.includes(kind),
                            ),
                        )
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name} · {model.modelName}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>

                <fieldset className="modality-picker">
                  <legend>模型能力</legend>
                  {(["text", "image", "video", "audio", "document"] as NodeKind[]).map((kind) => (
                    <label key={kind}>
                      <input
                        type="checkbox"
                        checked={draft.modalities.includes(kind)}
                        onChange={() => toggleModality(kind)}
                      />
                      {kind === "text"
                        ? "文本"
                        : kind === "image"
                          ? "图片"
                          : "视频"}
                    </label>
                  ))}
                </fieldset>

                <footer className="settings-form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setEditorOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={busy}
                  >
                    <Save size={15} />
                    {busy ? "保存中…" : "保存连接"}
                  </button>
                </footer>
              </form>
            )}

            {tab === "gesture" && (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>画布手势</h3>
                    <p>选择最符合你设备和操作习惯的画布导航方式。</p>
                  </div>
                </div>
                <div className="gesture-preset-grid">
                  {gesturePresets.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className={
                        preferences.gesturePreset === preset.id ? "active" : ""
                      }
                      onClick={() =>
                        setPreferences((current) => ({
                          ...current,
                          gesturePreset: preset.id,
                        }))
                      }
                    >
                      <span>
                        <MousePointer2 size={18} />
                        {preferences.gesturePreset === preset.id && (
                          <Check size={16} />
                        )}
                      </span>
                      <strong>{preset.title}</strong>
                      <small>{preset.description}</small>
                      <em>{preset.mapping}</em>
                    </button>
                  ))}
                </div>
                <section className="gesture-detail-card">
                  <h4>当前手势映射</h4>
                  <dl>
                    <div>
                      <dt>左键拖动空白区域</dt>
                      <dd>移动画布</dd>
                    </div>
                    <div>
                      <dt>右键</dt>
                      <dd>打开画布菜单</dd>
                    </div>
                    <div>
                      <dt>中键 / Space + 左键</dt>
                      <dd>临时抓手</dd>
                    </div>
                    <div>
                      <dt>Shift + 点击</dt>
                      <dd>追加多选</dd>
                    </div>
                  </dl>
                </section>
                <section className="settings-options-card">
                  <label>
                    <span>
                      <strong>缩放方向反转</strong>
                      <small>反转滚轮或捏合缩放的方向</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={preferences.invertZoom}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          invertZoom: event.target.checked,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>
                      <strong>缩放灵敏度</strong>
                      <small>仅影响画布缩放速度</small>
                    </span>
                    <select
                      value={preferences.zoomSensitivity}
                      onChange={(event) =>
                        setPreferences((current) => ({
                          ...current,
                          zoomSensitivity: event.target
                            .value as UserPreferences["zoomSensitivity"],
                        }))
                      }
                    >
                      <option value="slow">慢</option>
                      <option value="normal">标准</option>
                      <option value="fast">快</option>
                    </select>
                  </label>
                </section>
                <footer className="settings-form-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void savePreferences()}
                  >
                    <Save size={15} /> 保存手势设置
                  </button>
                </footer>
              </>
            )}

            {tab === "shortcuts" && (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>快捷键</h3>
                    <p>快捷键只在画布未输入文字时生效。</p>
                  </div>
                  <label className="shortcut-master-switch">
                    <span>启用</span>
                    <input
                      type="checkbox"
                      checked={preferences.keyboardShortcuts}
                      onChange={(event) => {
                        const next = {
                          ...preferences,
                          keyboardShortcuts: event.target.checked,
                        };
                        setPreferences(next);
                        void savePreferences(next);
                      }}
                    />
                  </label>
                </div>
                <div
                  className={`shortcut-list ${
                    preferences.keyboardShortcuts ? "" : "is-disabled"
                  }`}
                >
                  {shortcuts.map(([label, keys]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <kbd>{keys}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
