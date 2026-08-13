"use client";

import {
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  KeyRound,
  Keyboard,
  LogOut,
  MoonStar,
  MousePointer2,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { IntentOSController } from "../hooks/use-intent-os";
import type {
  AccountUser,
  GesturePreset,
  ModelConnection,
  ModelConnectionDraft,
  ModelProtocol,
  NodeKind,
  UserPreferences,
} from "../types";
import {
  builtInModelParameterSchema,
  DALL_E_3_ENDPOINT,
  DALL_E_3_MODEL,
  GEMINI_IMAGE_ENDPOINT,
  GEMINI_IMAGE_MODEL,
  RUNNINGHUB_MINIMAX_H3_ENDPOINT,
  RUNNINGHUB_MINIMAX_H3_MODEL,
  RUNNINGHUB_NANO_BANANA_2_ENDPOINT,
  RUNNINGHUB_NANO_BANANA_2_MODEL,
  RUNNINGHUB_RH_IMAGE_2_ENDPOINT,
  RUNNINGHUB_RH_IMAGE_2_MODEL,
  RUNNINGHUB_SEEDANCE_ENDPOINT,
  RUNNINGHUB_SEEDANCE_MODEL,
  RUNNINGHUB_SPARKVIDEO_MINI_MULTIMODAL_ENDPOINT,
  RUNNINGHUB_SPARKVIDEO_MINI_MODEL,
  RUNNINGHUB_SPARKVIDEO_MODEL,
  RUNNINGHUB_SPARKVIDEO_MULTIMODAL_ENDPOINT,
  RUNNINGHUB_SUNO_V5_ENDPOINT,
  RUNNINGHUB_SUNO_V5_MODEL,
  defaultProtocolForModelType,
  modelProtocolOptions,
  modelProtocolOptionsForType,
  protocolSupportsModelType,
} from "../lib/model-protocol-options";
import {
  defaultModelInputConstraints,
  MODEL_INPUT_ASSET_KINDS,
  normalizeModelInputConstraints,
} from "../lib/model-input-constraints";
import { useAppDialog } from "./app-dialog";
import { IconButton } from "./icon-button";
import { PersonalSettings } from "./personal-settings";

type SettingsTab =
  | "account"
  | "appearance"
  | "api"
  | "gesture"
  | "shortcuts";

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
  parameterSchema: { type: "object", properties: {} },
  uiSchema: {},
  inputConstraints: defaultModelInputConstraints("text", "openai-compatible"),
  capabilityTags: [],
  accessScope: "personal",
};

const protocolLabels = Object.fromEntries(
  modelProtocolOptions.map((item) => [item.value, item.label]),
) as Partial<Record<ModelProtocol, string>>;

function protocolPreset(
  protocol: ModelProtocol,
  modelType: NodeKind,
): Partial<ModelConnectionDraft> {
  if (modelType === "video") {
    if (protocol === "runninghub-sparkvideo-mini-multimodal") {
      return {
        name: `${RUNNINGHUB_SPARKVIDEO_MINI_MODEL} 多模态`,
        modelName: RUNNINGHUB_SPARKVIDEO_MINI_MODEL,
        baseUrl: RUNNINGHUB_SPARKVIDEO_MINI_MULTIMODAL_ENDPOINT,
      };
    }
    if (protocol === "runninghub-sparkvideo-multimodal") {
      return {
        name: `${RUNNINGHUB_SPARKVIDEO_MODEL} 多模态`,
        modelName: RUNNINGHUB_SPARKVIDEO_MODEL,
        baseUrl: RUNNINGHUB_SPARKVIDEO_MULTIMODAL_ENDPOINT,
      };
    }
    if (protocol === "runninghub-minimax-h3") {
      return {
        name: RUNNINGHUB_MINIMAX_H3_MODEL,
        modelName: RUNNINGHUB_MINIMAX_H3_MODEL,
        baseUrl: RUNNINGHUB_MINIMAX_H3_ENDPOINT,
      };
    }
    if (protocol === "runninghub-seedance") {
      return {
        name: "Seedance-2.5",
        modelName: RUNNINGHUB_SEEDANCE_MODEL,
        baseUrl: RUNNINGHUB_SEEDANCE_ENDPOINT,
      };
    }
    return {};
  }
  if (modelType === "audio") {
    if (protocol === "runninghub-suno-v5") {
      return {
        name: "Suno v5.5",
        modelName: RUNNINGHUB_SUNO_V5_MODEL,
        baseUrl: RUNNINGHUB_SUNO_V5_ENDPOINT,
      };
    }
    return {};
  }
  if (modelType !== "image") return {};
  if (protocol === "runninghub-rh-image-2") {
    return {
      name: "RH-image-2",
      modelName: RUNNINGHUB_RH_IMAGE_2_MODEL,
      baseUrl: RUNNINGHUB_RH_IMAGE_2_ENDPOINT,
    };
  }
  if (protocol === "runninghub-nano-banana-2") {
    return {
      name: "RH-banana-2",
      modelName: RUNNINGHUB_NANO_BANANA_2_MODEL,
      baseUrl: RUNNINGHUB_NANO_BANANA_2_ENDPOINT,
    };
  }
  if (protocol === "dall-e-3") {
    return {
      name: DALL_E_3_MODEL,
      modelName: DALL_E_3_MODEL,
      baseUrl: DALL_E_3_ENDPOINT,
    };
  }
  if (protocol === "gemini") {
    return {
      name: GEMINI_IMAGE_MODEL,
      modelName: GEMINI_IMAGE_MODEL,
      baseUrl: GEMINI_IMAGE_ENDPOINT,
    };
  }
  return {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function ModelBuiltInOptions({
  schema,
  onChange,
}: {
  schema: Record<string, unknown>;
  onChange: (schema: Record<string, unknown>) => void;
}) {
  const properties = record(schema.properties);
  const entries = Object.entries(properties).flatMap(([key, value]) => {
    const property = record(value);
    const values = Array.isArray(property.enum) ? property.enum : [];
    if (!values.length) return [];
    return [{ key, property, values }];
  });

  if (!entries.length) return null;

  return (
    <section className="model-built-in-options">
      <header>
        <strong>模型内置选项</strong>
        <span>选项由当前模型类型与服务商提供，仅可选择默认值。</span>
      </header>
      <div className="model-built-in-options-grid">
        {entries.map(({ key, property, values }) => {
          const selected = property.default ?? values[0];
          return (
            <label key={key}>
              {typeof property.title === "string" ? property.title : key}
              <select
                value={String(selected)}
                onChange={(event) => {
                  const nextDefault =
                    values.find(
                      (value) => String(value) === event.target.value,
                    ) ?? event.target.value;
                  onChange({
                    ...schema,
                    properties: {
                      ...properties,
                      [key]: { ...property, default: nextDefault },
                    },
                  });
                }}
              >
                {values.map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}

const inputAssetLabels = {
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
} as const;

function ModelInputConstraintEditor({
  value,
  modelType,
  protocol,
  onChange,
}: {
  value: ModelConnectionDraft["inputConstraints"];
  modelType: NodeKind;
  protocol: ModelProtocol;
  onChange: (value: NonNullable<ModelConnectionDraft["inputConstraints"]>) => void;
}) {
  const constraints = normalizeModelInputConstraints(value, modelType, protocol);
  return (
    <section className="model-input-constraints">
      <header>
        <strong>输入素材能力</strong>
        <span>同时校验素材总数与各类型上限；填写 0 表示不支持该类型。</span>
      </header>
      <div className="model-input-constraints-grid">
        <label>
          素材总上限
          <input
            type="number"
            min={0}
            max={100}
            value={constraints.maxTotal}
            onChange={(event) =>
              onChange({
                ...constraints,
                maxTotal: Number(event.target.value),
              })
            }
          />
        </label>
        {MODEL_INPUT_ASSET_KINDS.map((assetKind) => (
          <label key={assetKind}>
            {inputAssetLabels[assetKind]}上限
            <input
              type="number"
              min={0}
              max={100}
              value={constraints.maxByType[assetKind]}
              onChange={(event) =>
                onChange({
                  ...constraints,
                  maxByType: {
                    ...constraints.maxByType,
                    [assetKind]: Number(event.target.value),
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <p>
        例如总上限 12、图片 9、视频 3、音频 3：三类素材分别不能超限，合计也不能超过 12。
      </p>
    </section>
  );
}

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
  ["进入 / 退出多选", "Ctrl / ⌘ + M"],
];

function draftFromModel(model: ModelConnection): ModelConnectionDraft {
  const modelType = model.modalities[0] ?? "text";
  const savedProtocol =
    model.protocol === "generic-rest"
      ? "openai-compatible"
      : (model.protocol ?? "openai-compatible");
  const protocol = protocolSupportsModelType(savedProtocol, modelType)
    ? savedProtocol
    : defaultProtocolForModelType(modelType);
  const savedSchema = model.parameterSchema ?? {};
  const savedProperties =
    savedSchema.properties && typeof savedSchema.properties === "object"
      ? savedSchema.properties
      : {};
  const parameterSchema =
    protocol === savedProtocol && Object.keys(savedProperties).length
    ? savedSchema
    : builtInModelParameterSchema(protocol, modelType);
  const normalizedPreset =
    protocol !== savedProtocol ? protocolPreset(protocol, modelType) : {};
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
    fallbackModelId: null,
    maxConcurrency: model.maxConcurrency ?? 2,
    retryLimit: model.retryLimit ?? 3,
    circuitFailureThreshold: model.circuitFailureThreshold ?? 5,
    circuitCooldownSeconds: model.circuitCooldownSeconds ?? 60,
    parameterSchema,
    uiSchema: model.uiSchema ?? {},
    inputConstraints:
      model.inputConstraints ?? defaultModelInputConstraints(modelType, protocol),
    capabilityTags: model.capabilityTags ?? [],
    accessScope: model.accessScope ?? "personal",
    ...normalizedPreset,
  };
}

function modelInputConstraintSummary(model: ModelConnection) {
  const kind = model.modalities[0] ?? "text";
  const constraints = normalizeModelInputConstraints(
    model.inputConstraints,
    kind,
    model.protocol,
  );
  if (!constraints.maxTotal) return "参考素材 0";
  const enabled = MODEL_INPUT_ASSET_KINDS.flatMap((assetKind) =>
    constraints.maxByType[assetKind] > 0
      ? [`${inputAssetLabels[assetKind]} ${constraints.maxByType[assetKind]}`]
      : [],
  );
  return [`素材 ${constraints.maxTotal}`, ...enabled].join(" · ");
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
  onOpenAdmin: () => void;
  onLogout: () => void;
  onClose: () => void;
}

export function SettingsCenter({
  os,
  user,
  onUserUpdate,
  onOpenAccount,
  onOpenAdmin,
  onLogout,
  onClose,
}: SettingsCenterProps) {
  const dialog = useAppDialog();
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
  const [modelFeedback, setModelFeedback] = useState<{
    modelId: string;
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const connectedCount = useMemo(
    () =>
      os.models.filter(
        (model) => model.enabled !== false && model.state === "healthy",
      ).length,
    [os.models],
  );
  const selectedModelType = draft.modalities[0] ?? "text";
  const compatibleProtocols = useMemo(
    () => modelProtocolOptionsForType(selectedModelType),
    [selectedModelType],
  );
  const canManageModels = Boolean(user.id);

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

  async function saveModel(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!draft.modalities.length) {
      setError("请至少选择一种模型能力。");
      return;
    }
    if (!compatibleProtocols.length) {
      setError("当前模型类型暂无可用服务商，请等待添加对应模型。");
      return;
    }
    setBusy(true);
    try {
      const modelDraft = { ...draft, fallbackModelId: null };
      if (editingId) {
        await os.updateModel(editingId, modelDraft);
        setNotice("API 连接已更新。");
      } else {
        await os.createModel(modelDraft);
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
    if (!(await dialog.confirm(
      `删除“${model.name}”后，节点将不再能选择这个模型。`,
      {
        title: "删除模型连接",
        confirmText: "删除模型",
        tone: "danger",
      },
    ))) {
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
    setNotice("");
    setModelFeedback(null);
    try {
      const result = await os.testModel(model.id);
      setModelFeedback({
        modelId: model.id,
        message: result.message || (result.ok ? "连接成功" : "连接失败"),
        tone: result.ok ? "success" : "error",
      });
    } catch (caught) {
      setModelFeedback({
        modelId: model.id,
        message: caught instanceof Error ? caught.message : "连接失败",
        tone: "error",
      });
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
            <button
              type="button"
              className={tab === "appearance" ? "active" : ""}
              onClick={() => selectTab("appearance")}
            >
              <Sun size={17} />
              <span>界面风格</span>
              <ChevronRight size={14} />
            </button>
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
            {user.platformRole === "system_admin" && (
              <button
                type="button"
                className="settings-admin-entry"
                onClick={onOpenAdmin}
              >
                <ShieldCheck size={17} />
                <span>后台管理</span>
                <ChevronRight size={14} />
              </button>
            )}
            <button
              type="button"
              className={
                user.platformRole === "system_admin"
                  ? "settings-account-entry"
                  : "settings-account-entry settings-account-entry-first"
              }
              onClick={onOpenAccount}
            >
              <Building2 size={17} />
              <span>账号与企业</span>
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              className="settings-logout-entry"
              style={{ marginTop: 12, color: "#dc2626" }}
              onClick={onLogout}
            >
              <LogOut size={17} />
              <span>退出登录</span>
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
              />
            )}
            {tab === "appearance" && (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>界面风格</h3>
                    <p>
                      在白天与黑夜两套完整风格之间切换，画布、导航、页面、弹窗和表单会同步变化。
                    </p>
                  </div>
                </div>
                <div className="canvas-background-grid">
                  <button
                    type="button"
                    className={
                      preferences.canvasBackground === "day" ? "active" : ""
                    }
                    aria-pressed={preferences.canvasBackground === "day"}
                    disabled={busy}
                    onClick={() => {
                      const next = {
                        ...preferences,
                        canvasBackground: "day" as const,
                      };
                      setPreferences(next);
                      void savePreferences(next);
                    }}
                  >
                    <span className="canvas-background-preview is-day">
                      <i />
                      <i />
                    </span>
                    <span className="canvas-background-label">
                      <span>
                        <Sun size={17} />
                        <strong>白天</strong>
                      </span>
                      {preferences.canvasBackground === "day" && (
                        <Check size={17} />
                      )}
                    </span>
                    <small>明亮清晰的完整浅色界面</small>
                  </button>
                  <button
                    type="button"
                    className={
                      preferences.canvasBackground === "night" ? "active" : ""
                    }
                    aria-pressed={preferences.canvasBackground === "night"}
                    disabled={busy}
                    onClick={() => {
                      const next = {
                        ...preferences,
                        canvasBackground: "night" as const,
                      };
                      setPreferences(next);
                      void savePreferences(next);
                    }}
                  >
                    <span className="canvas-background-preview is-night">
                      <i />
                      <i />
                    </span>
                    <span className="canvas-background-label">
                      <span>
                        <MoonStar size={17} />
                        <strong>黑夜</strong>
                      </span>
                      {preferences.canvasBackground === "night" && (
                        <Check size={17} />
                      )}
                    </span>
                    <small>低亮沉浸的完整深色界面</small>
                  </button>
                </div>
              </>
            )}
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
                    disabled={!canManageModels}
                    title="添加 API"
                    onClick={openCreate}
                  >
                    <Plus size={16} /> 添加 API
                  </button>
                </div>
                <div className="api-connection-list">
                  {os.models.map((model) => (
                    <article
                      key={model.id}
                      className={`api-connection-card ${
                        model.enabled === false ? "is-disabled" : ""
                      }`}
                    >
                      <div className="api-card-content">
                        <div className="api-card-title">
                          <strong>{model.name}</strong>
                          <span
                            className={`api-status-light ${
                              model.state === "healthy"
                                ? "is-healthy"
                                : "is-unhealthy"
                            }`}
                            role="status"
                            aria-label={
                              model.state === "healthy"
                                ? "连接正常"
                                : model.state === "checking"
                                  ? "正在检测连接"
                                  : "连接异常或尚未通过检测"
                            }
                            title={
                              model.state === "healthy"
                                ? "连接正常"
                                : model.state === "checking"
                                  ? "正在检测连接"
                                  : "连接异常或尚未通过检测"
                            }
                          />
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
                          {" · "}
                          {model.accessScope === "workspace"
                            ? "企业共享模型"
                            : "仅个人模型"}
                        </small>
                        <div className="api-policy-summary">
                          <span>重试 {model.retryLimit ?? 3}</span>
                          <span>
                            熔断{" "}
                            {model.circuitState === "open"
                              ? "已打开"
                              : model.circuitState === "half_open"
                                ? "恢复检测"
                                : "正常"}
                          </span>
                          <span>{modelInputConstraintSummary(model)}</span>
                        </div>
                      </div>
                      <div className="api-card-top-actions">
                        <button
                          type="button"
                          className={`switch-button api-card-switch ${
                            model.enabled !== false ? "is-on" : ""
                          }`}
                          aria-pressed={model.enabled !== false}
                          disabled={busy || !model.canManage}
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            setNotice("");
                            setModelFeedback(null);
                            try {
                              await os.setModelEnabled(
                                model.id,
                                model.enabled === false,
                              );
                              setModelFeedback({
                                modelId: model.id,
                                message: `${model.name} 已${
                                  model.enabled === false ? "启用" : "停用"
                                }。`,
                                tone: "success",
                              });
                            } catch (caught) {
                              setModelFeedback({
                                modelId: model.id,
                                message: caught instanceof Error
                                  ? caught.message
                                  : "更新模型状态失败",
                                tone: "error",
                              });
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <i />
                          {model.enabled === false ? "已停用" : "已启用"}
                        </button>
                        <IconButton
                          label={`编辑 ${model.name}`}
                          disabled={
                            busy ||
                            !model.canManage ||
                            model.protocol === "generic-rest"
                          }
                          onClick={() => openEdit(model)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          label={`删除 ${model.name}`}
                          danger
                          disabled={busy || !model.canManage}
                          onClick={() => void removeModel(model)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                      {modelFeedback?.modelId === model.id && (
                        <div
                          className={`api-card-feedback is-${modelFeedback.tone}`}
                          role="status"
                        >
                          {modelFeedback.tone === "success" ? (
                            <Check size={13} />
                          ) : (
                            <CircleAlert size={13} />
                          )}
                          <span>{modelFeedback.message}</span>
                        </div>
                      )}
                      <div className="api-card-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            busy ||
                            model.enabled === false ||
                            !model.canManage
                          }
                          onClick={() => void testConnection(model)}
                        >
                          测试
                        </button>
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

                {!!os.modelProviders.filter(
                  (provider) => provider.protocol !== "generic-rest",
                ).length && (
                  <label className="provider-template-picker">
                    从已安装的模型 Provider 开始
                    <select
                      defaultValue=""
                      onChange={(event) => {
                        const provider = os.modelProviders.find(
                          (item) => item.id === event.target.value,
                        );
                        if (!provider) return;
                        setDraft((current) => ({
                          ...current,
                          name: current.name || provider.title,
                          protocol: provider.protocol,
                          baseUrl: provider.baseUrl ?? current.baseUrl,
                          modalities: provider.modalities,
                          parameterSchema:
                            provider.parameterSchema ??
                            builtInModelParameterSchema(
                              provider.protocol,
                              provider.modalities[0] ?? "text",
                            ),
                            uiSchema: provider.uiSchema ?? {},
                            inputConstraints:
                              provider.inputConstraints ??
                              defaultModelInputConstraints(
                                provider.modalities[0] ?? "text",
                                provider.protocol,
                              ),
                          capabilityTags: provider.capabilityTags ?? [],
                        }));
                      }}
                    >
                      <option value="">选择 Provider 模板（可选）</option>
                      {os.modelProviders
                        .filter(
                          (provider) =>
                            provider.protocol !== "generic-rest",
                        )
                        .map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.title} · v{provider.packageVersion}
                          </option>
                        ))}
                    </select>
                  </label>
                )}

                <div className="settings-form-grid">
                  <div className="settings-field">
                    <span>模型类型</span>
                    <select
                      value={draft.modalities[0] ?? "text"}
                      onChange={(event) =>
                        setDraft((current) => {
                          const kind = event.target.value as NodeKind;
                          const protocol = protocolSupportsModelType(
                            current.protocol,
                            kind,
                          )
                            ? current.protocol
                            : defaultProtocolForModelType(kind);
                          const hasProvider =
                            modelProtocolOptionsForType(kind).length > 0;
                          return {
                            ...current,
                            ...(hasProvider
                              ? protocolPreset(protocol, kind)
                              : { name: "", modelName: "", baseUrl: "" }),
                            protocol,
                            modalities: [kind],
                            parameterSchema: hasProvider
                              ? builtInModelParameterSchema(protocol, kind)
                              : { type: "object", properties: {} },
                            uiSchema: {},
                            inputConstraints: defaultModelInputConstraints(
                              kind,
                              protocol,
                            ),
                          };
                        })
                      }
                    >
                      <option value="text">文本 (Text)</option>
                      <option value="image">图片 (Image)</option>
                      <option value="video">视频 (Video)</option>
                      <option value="audio">音乐 (Audio)</option>
                    </select>
                  </div>
                  <label>
                    调用协议 / 服务商
                    <select
                      value={
                        compatibleProtocols.some(
                          (item) => item.value === draft.protocol,
                        )
                          ? draft.protocol
                          : ""
                      }
                      disabled={!compatibleProtocols.length}
                      onChange={(event) =>
                        setDraft((current) => {
                          const protocol = event.target.value as ModelProtocol;
                          return {
                            ...current,
                            ...protocolPreset(protocol, current.modalities[0] ?? "text"),
                            protocol,
                            parameterSchema: builtInModelParameterSchema(
                              protocol,
                              current.modalities[0] ?? "text",
                            ),
                            uiSchema: {},
                            inputConstraints: defaultModelInputConstraints(
                              current.modalities[0] ?? "text",
                              protocol,
                            ),
                          };
                        })
                      }
                    >
                      {!compatibleProtocols.length && (
                        <option value="">暂无可用模型</option>
                      )}
                      {compatibleProtocols.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    模型名称 (MODEL)
                    <input
                      required
                      value={draft.name}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      placeholder="例如：gemini-3.5-flash"
                    />
                  </label>
                  <label className="settings-span-two">
                    接口地址 (API ENDPOINT)
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
                      placeholder="https://api.example.com/v1/chat/completions"
                    />
                    <small>
                      请填写完整业务接口地址；系统将原样调用，不自动追加路径。
                    </small>
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
                    密钥 (API KEY)
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
                </div>

                {selectedModelType !== "text" && (
                  <ModelBuiltInOptions
                    key={`${editingId ?? "new"}-${selectedModelType}-${draft.protocol}`}
                    schema={draft.parameterSchema ?? {}}
                    onChange={(parameterSchema) =>
                      setDraft((current) => ({
                        ...current,
                        parameterSchema,
                      }))
                    }
                  />
                )}

                <ModelInputConstraintEditor
                  value={draft.inputConstraints}
                  modelType={selectedModelType}
                  protocol={draft.protocol}
                  onChange={(inputConstraints) =>
                    setDraft((current) => ({ ...current, inputConstraints }))
                  }
                />

                <div className="settings-form-grid settings-access-scope-row">
                  <label>
                    使用权限
                    <select
                      value={draft.accessScope ?? "personal"}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          accessScope: event.target.value as
                            | "personal"
                            | "workspace",
                        }))
                      }
                    >
                      <option value="personal">仅个人</option>
                      <option value="workspace">所在企业</option>
                    </select>
                  </label>
                </div>

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
                    disabled={busy || !compatibleProtocols.length}
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
