"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  Clock,
  Copy,
  Cpu,
  ListChecks,
  MessageSquareText,
  PanelRightClose,
  Paperclip,
  Plus,
  Pause,
  Play,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SelectMenu } from "./select-menu";
import type {
  CanvasAssetReference,
  CanvasNode,
  ChatAttachment,
  ChatMessage,
  Capability,
  IntentPlan,
  ModelConnection,
  ModelInputAssetKind,
  ModelInputConstraints,
  NodeKind,
  RunState,
} from "../types";
import { IconButton } from "./icon-button";
import { InputAssetPreview, NodePromptEditor } from "./node-card";
import {
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../lib/model-input-constraints";
import { resolveProfessionalGeneratorRules } from "../lib/professional-generator-rules";

const suggestions = [
  "把当前脚本扩展成 30 秒品牌短片",
  "为这个角色建立统一视觉 DNA",
  "检查画布中可能失败的依赖",
];

const quickAnswerSuggestions = [
  "解释一个我不熟悉的概念",
  "帮我梳理这段文字的核心观点",
  "回答一个通用知识问题",
];

type ComposerMode = "xiaoluo" | "quick" | "text" | "image" | "video";

const XIAOLUO_INPUT_CONSTRAINTS: ModelInputConstraints = {
  maxTotal: 8,
  maxByType: { image: 8, video: 8, audio: 8, document: 8 },
};

const QUICK_ANSWER_INPUT_CONSTRAINTS: ModelInputConstraints = {
  maxTotal: 0,
  maxByType: { image: 0, video: 0, audio: 0, document: 0 },
};

function attachmentInputKind(attachment: ChatAttachment): ModelInputAssetKind {
  return attachment.kind === "image" ||
    attachment.kind === "video" ||
    attachment.kind === "audio"
    ? attachment.kind
    : "document";
}

function cloneIntentPlan(plan: IntentPlan): IntentPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
      parameters: task.parameters ? { ...task.parameters } : undefined,
    })),
  };
}

interface IntentConsoleProps {
  messages: ChatMessage[];
  plan: IntentPlan | null;
  isPlanning: boolean;
  isQuickAnswering: boolean;
  runState: RunState;
  onClose: () => void;
  capabilities: Capability[];
  models: ModelConnection[];
  canvasAssets: CanvasAssetReference[];
  nodes: CanvasNode[];
  onFocusNode?: (nodeId: string) => void;
  onSubmit: (
    value: string,
    attachments?: ChatAttachment[],
    preferredCapabilityId?: string,
    preferredModelId?: string,
  ) => void;
  onQuickAnswer: (value: string, preferredModelId: string) => void;
  onGenerate: (
    value: string,
    kind: Extract<NodeKind, "text" | "image" | "video">,
    capabilityId?: string,
    modelId?: string,
    attachments?: ChatAttachment[],
    modelParameters?: Record<string, unknown>,
  ) => void;
  onUploadAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onConfirmPlan: () => void | Promise<void>;
  onUpdatePlan: (plan: IntentPlan) => void | Promise<void>;
  onRejectPlan: () => void | Promise<void>;
  onStart: () => void;
  onPause: () => void;
  onCancel: () => void;
  onClearMessages?: () => void;
  onNewConversation?: () => void;
  conversationHistory?: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  onFetchHistory?: () => void;
  onRestoreConversation?: (id: string) => void;
}

export function IntentConsole({
  messages,
  plan,
  isPlanning,
  isQuickAnswering,
  runState,
  onClose,
  capabilities,
  models,
  canvasAssets,
  nodes,
  onFocusNode,
  onSubmit,
  onQuickAnswer,
  onGenerate,
  onUploadAttachments,
  onConfirmPlan,
  onUpdatePlan,
  onRejectPlan,
  onStart,
  onPause,
  onCancel,
  onClearMessages,
  onNewConversation,
  conversationHistory = [],
  onFetchHistory,
  onRestoreConversation,
}: IntentConsoleProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyMessage(content: string, id: string) {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }
  const [planDraft, setPlanDraft] = useState<IntentPlan | null>(null);
  const [composerMode, setComposerMode] =
    useState<ComposerMode>("xiaoluo");
  const [preferredCapabilityId, setPreferredCapabilityId] = useState("none");
  const [preferredModelId, setPreferredModelId] = useState("");
  const [modelParameters, setModelParameters] = useState<Record<string, unknown>>({});
  const [showAdvancedComposerOptions, setShowAdvancedComposerOptions] =
    useState(false);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const professionalMode =
    composerMode === "text" ||
    composerMode === "image" ||
    composerMode === "video"
      ? composerMode
      : null;
  const quickAnswerModels = [...models]
    .filter(
      (model) => model.enabled !== false && model.modalities.includes("text"),
    )
    .sort((left, right) => {
      const health =
        Number(right.state === "healthy") - Number(left.state === "healthy");
      return health || left.priority - right.priority;
    });
  const quickAnswerModel =
    quickAnswerModels.find((model) => model.id === preferredModelId) ??
    quickAnswerModels[0];
  const professionalRules = professionalMode
    ? resolveProfessionalGeneratorRules({
        capabilities,
        models,
        kind: professionalMode,
        requestedCapabilityId: preferredCapabilityId,
        requestedModelId: preferredModelId || undefined,
      })
    : null;
  const inputConstraints =
    composerMode === "quick"
      ? QUICK_ANSWER_INPUT_CONSTRAINTS
      : professionalMode
        ? normalizeModelInputConstraints(
            professionalRules?.model?.inputConstraints,
            professionalMode,
            professionalRules?.model?.protocol,
            professionalRules?.model?.modelName ?? professionalRules?.model?.id,
          )
        : XIAOLUO_INPUT_CONSTRAINTS;
  const attachmentValidation = validateModelInputAssets(
    inputConstraints,
    attachments.map((attachment) => ({
      kind: attachmentInputKind(attachment),
    })),
  );
  const generatorReady =
    composerMode === "quick"
      ? Boolean(quickAnswerModel)
      : professionalMode
        ? Boolean(professionalRules?.model || professionalRules?.usesSkillRuntime)
        : true;
  const composerModelParameterEntries = professionalRules?.model?.parameterSchema
    ? Object.entries(
        professionalRules.model.parameterSchema.properties ?? {},
      ).filter(([, paramSchema]) => {
        const schema = paramSchema as { enum?: string[] };
        return Boolean(schema.enum?.length);
      })
    : [];
  const canAddInputAsset =
    inputConstraints.maxTotal > 0 &&
    attachments.length < inputConstraints.maxTotal;
  const visibleMessages = messages.filter((message) =>
    composerMode === "quick"
      ? message.mode === "quick_answer"
      : message.mode !== "quick_answer",
  );

  const attachmentAssets: CanvasAssetReference[] = attachments.map((attachment) => ({
    sourceNodeId: attachment.sourceNodeId ?? `attachment:${attachment.id}`,
    assetId: attachment.id,
    title: attachment.name,
    kind:
      attachment.kind === "image" ||
      attachment.kind === "video" ||
      attachment.kind === "audio"
        ? attachment.kind
        : "document",
    url: attachment.previewUrl ?? attachment.uri,
    mimeType: attachment.mimeType,
    status: "succeeded" as const,
  }));
  const mentionAssets = [
    ...attachmentAssets,
    ...canvasAssets.filter(
      (asset) =>
        !attachmentAssets.some(
          (attachment) => attachment.sourceNodeId === asset.sourceNodeId,
        ),
    ),
  ];
  const attachedSourceIds = new Set(
    attachmentAssets.map((asset) => asset.sourceNodeId),
  );

  function attachCanvasAsset(sourceNodeId: string) {
    const asset = canvasAssets.find(
      (candidate) => candidate.sourceNodeId === sourceNodeId,
    );
    if (!asset?.assetId || !asset.url) return;
    const assetId = asset.assetId;
    const assetUrl = asset.url;
    setAttachments((current) => {
      if (
        current.some(
          (attachment) =>
            attachment.id === assetId ||
            attachment.sourceNodeId === sourceNodeId,
        ) ||
        current.length >= inputConstraints.maxTotal
      ) {
        return current;
      }
      return [
        ...current,
        {
          id: assetId,
          uri: assetUrl,
          name: asset.title,
          kind: asset.kind,
          mimeType:
            asset.mimeType ??
            (asset.kind === "image"
              ? "image/*"
              : asset.kind === "video"
                ? "video/*"
                : asset.kind === "audio"
                  ? "audio/*"
                  : "application/octet-stream"),
          previewUrl: assetUrl,
          sourceNodeId,
        },
      ];
    });
  }

  function submit() {
    if (!draft.trim()) return;
    if (composerMode === "quick") {
      if (!quickAnswerModel) return;
      onQuickAnswer(draft, quickAnswerModel.id);
    } else if (professionalMode) {
      if (!generatorReady || !attachmentValidation.valid) return;
      onGenerate(
        draft,
        professionalMode,
        preferredCapabilityId,
        professionalRules?.model?.id,
        attachments,
        modelParameters,
      );
    } else {
      onSubmit(draft, attachments);
    }
    setDraft("");
    setAttachments([]);
  }

  return (
    <>
      <aside className="intent-console" aria-label="Intent Console">
      <div className="console-header">
        <div className="console-title">
          <span className="console-logo">
            <Sparkles size={17} />
          </span>
          <div>
            <strong>小逻</strong>
            <small>
              <i className="online-dot" />
              {composerMode === "xiaoluo"
                ? "小逻大脑在线"
                : composerMode === "quick"
                  ? "通用文本问答"
                  : "专业生成器"}
            </small>
          </div>
        </div>
        <div className="console-header-actions">
          {onClearMessages && (
            <IconButton label="清空对话" onClick={onClearMessages}>
              <Trash2 size={17} />
            </IconButton>
          )}
          {onNewConversation && (
            <IconButton label="新建对话" onClick={onNewConversation}>
              <Plus size={17} />
            </IconButton>
          )}
          <IconButton
            label="历史对话"
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory && onFetchHistory) onFetchHistory();
            }}
          >
            <Clock size={17} />
          </IconButton>
          <IconButton label="折叠 Intent Console" onClick={onClose}>
            <PanelRightClose size={17} />
          </IconButton>
        </div>
      </div>

      <div className="console-messages" aria-live="polite">
        {composerMode === "quick" && visibleMessages.length === 0 && (
          <div className="message message-assistant">
            <span className="message-avatar">
              <Sparkles size={14} />
            </span>
            <div className="message-bubble">
              <p>这里是快速问答。我只回答通用文本问题，不读取或修改当前画布。</p>
            </div>
          </div>
        )}
        {visibleMessages.map((message) => (
          <div key={message.id} className={`message message-${message.role}`}>
            {message.role === "assistant" && (
              <span className="message-avatar">
                <Sparkles size={14} />
              </span>
            )}
            <div className="message-bubble">
              <p>{message.content}</p>
              {message.resultNodeId && (
                <MessageResultPreview
                  node={nodes.find(
                    (item) => item.id === message.resultNodeId,
                  )}
                  kind={message.resultKind}
                  onFocus={onFocusNode}
                />
              )}
              {!!message.attachments?.length && (
                <div className="message-attachments">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id}>
                      <Paperclip size={11} /> {attachment.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="message-actions">
                <button
                  className="message-copy-btn"
                  title="复制内容"
                  onClick={() => copyMessage(message.content, message.id)}
                >
                  {copiedId === message.id ? (
                    <>
                      <Check size={12} />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <time>{message.time}</time>
            </div>
          </div>
        ))}

        {composerMode === "xiaoluo" && isPlanning && (
          <div className="planning-state">
            <span className="planning-orbit" />
            <div>
              <strong>正在理解意图并检查能力…</strong>
              <small>生成目标、任务依赖与成本估计</small>
            </div>
          </div>
        )}

        {composerMode === "quick" && isQuickAnswering && (
          <div className="planning-state" aria-label="快速问答生成中">
            <span className="planning-orbit" />
            <div>
              <strong>正在回答…</strong>
              <small>{quickAnswerModel?.name ?? "通用文本模型"}</small>
            </div>
          </div>
        )}

        {composerMode === "xiaoluo" && plan && (
          <section className="plan-card" aria-label="待确认计划">
            <div className="plan-heading">
              <span>
                <ListChecks size={17} /> 执行计划
              </span>
              <span className="plan-badge">待确认</span>
            </div>
            <h3>{plan.goal}</h3>
            <div className="plan-tasks">
              {plan.tasks.map((task, index) => (
                <div key={task.id} className="plan-task">
                  <span>{index + 1}</span>
                  <div>
                    <b>{task.title}</b>
                    <small>
                      {task.capability} · {KIND_LABEL[task.kind] ?? task.kind} · {task.duration}
                    </small>
                    <small>
                      依赖：{task.dependsOn.length ? task.dependsOn.join("、") : "无（起点）"}
                    </small>
                  </div>
                </div>
              ))}
            </div>
            {plan.warning && (
              <p className="plan-warning">
                <AlertTriangle size={14} /> {plan.warning}
              </p>
            )}
            <div className="plan-summary">
              <span>{plan.estimate}</span>
              <button
                type="button"
                className="danger-text-button"
                onClick={() => void onRejectPlan()}
              >
                取消计划
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setPlanDraft(cloneIntentPlan(plan));
                  setEditingPlan(true);
                }}
              >
                调整计划
              </button>
              <button type="button" className="primary-button" onClick={onConfirmPlan}>
                <Check size={15} /> 确认并写入画布
              </button>
            </div>
          </section>
        )}

        {composerMode === "xiaoluo" && runState === "ready" && (
          <div className="run-ready-card">
            <span className="run-ready-icon">
              <Check size={18} />
            </span>
            <div>
              <strong>计划已写入画布</strong>
              <small>你可以先编辑任意节点，也可以直接运行。</small>
            </div>
            <button type="button" className="primary-button" onClick={onStart}>
              <Play size={15} /> 运行
            </button>
          </div>
        )}

        {composerMode === "xiaoluo" &&
          (runState === "running" ||
            runState === "waiting" ||
            runState === "paused") && (
          <div className="run-control-card">
            <div>
              <span className={`run-pulse ${runState === "paused" ? "is-paused" : ""}`} />
              <div>
                <strong>
                  {runState === "waiting"
                    ? "等待第三方模型结果"
                    : runState === "running"
                      ? "工作流执行中"
                      : "工作流已暂停"}
                </strong>
                <small>
                  {runState === "waiting"
                    ? "异步任务完成后会自动继续执行下游节点"
                    : "运行状态来自当前 Run 投影"}
                </small>
              </div>
            </div>
            <div>
              {runState === "running" || runState === "waiting" ? (
                <button type="button" className="secondary-button" onClick={onPause}>
                  <Pause size={14} /> 暂停
                </button>
              ) : (
                <button type="button" className="secondary-button" onClick={onStart}>
                  <RotateCcw size={14} /> 恢复
                </button>
              )}
              <button type="button" className="danger-text-button" onClick={onCancel}>
                <CircleStop size={14} /> 取消
              </button>
            </div>
          </div>
        )}

        {composerMode === "xiaoluo" &&
          (runState === "succeeded" ||
            runState === "failed" ||
            runState === "canceled") && (
          <div className={`run-ready-card run-result-${runState}`}>
            <span className="run-ready-icon">
              {runState === "succeeded" ? (
                <Check size={18} />
              ) : runState === "failed" ? (
                <AlertTriangle size={18} />
              ) : (
                <CircleStop size={18} />
              )}
            </span>
            <div>
              <strong>
                {runState === "succeeded"
                  ? "AI 微内核执行完成"
                  : runState === "failed"
                    ? "工作流执行失败"
                    : "工作流已取消"}
              </strong>
              <small>
                {runState === "succeeded"
                  ? "节点结果已按连线完成传递并记录"
                  : "可检查失败节点后重新运行"}
              </small>
            </div>
            <button type="button" className="secondary-button" onClick={onStart}>
              <RotateCcw size={14} /> 重新运行
            </button>
          </div>
        )}
      </div>

      <div className="suggestion-row" aria-label="意图建议">
        {(composerMode === "quick" ? quickAnswerSuggestions : suggestions).map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => setDraft(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <div className="composer-wrap">
        {(!!attachments.length || Boolean(professionalMode)) && (
          <section
            className={`composer-input-assets ${attachmentValidation.valid ? "" : "has-error"}`}
            aria-label="输入素材"
          >
            <div className="composer-input-assets-heading">
              <strong>输入素材</strong>
              <span>
                {attachmentValidation.total} / {inputConstraints.maxTotal}
              </span>
            </div>
            {inputConstraints.maxTotal <= 0 ? (
              <p className="composer-input-assets-empty">
                当前模型未开放参考素材
              </p>
            ) : (
            <div className="composer-input-asset-grid">
            {attachments.map((attachment) => (
              <div
                className="composer-input-asset-card"
                key={attachment.id}
                title={attachment.name}
              >
                <InputAssetPreview
                  asset={{
                    sourceNodeId:
                      attachment.sourceNodeId ?? `attachment:${attachment.id}`,
                    assetId: attachment.id,
                    title: attachment.name,
                    kind:
                      attachment.kind === "image" ||
                      attachment.kind === "video" ||
                      attachment.kind === "audio"
                        ? attachment.kind
                        : "document",
                    url: attachment.previewUrl ?? attachment.uri,
                    mimeType: attachment.mimeType,
                    status: "succeeded",
                  }}
                />
                <button
                  type="button"
                  aria-label={`移除附件 ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
              {canAddInputAsset && (
                <button
                  type="button"
                  className="composer-input-asset-add"
                  aria-label={uploading ? "正在上传附件" : "添加输入素材"}
                  disabled={uploading}
                  onClick={() => attachmentRef.current?.click()}
                >
                  <span aria-hidden="true">＋</span>
                </button>
              )}
            </div>
            )}
            {!attachmentValidation.valid && (
              <div className="composer-input-assets-errors" role="alert">
                {attachmentValidation.errors.map((error) => (
                  <span key={error}>{error}</span>
                ))}
              </div>
            )}
          </section>
        )}
        <div className="composer">
          <div className="intent-composer-editor">
            <NodePromptEditor
            value={draft}
            assets={composerMode === "quick" ? [] : mentionAssets}
            attachedSourceIds={
              composerMode === "quick" ? new Set<string>() : attachedSourceIds
            }
            onChange={setDraft}
            onAttach={attachCanvasAsset}
            onSubmitShortcut={submit}
            aria-label={
              composerMode === "quick"
                ? "输入快速问答问题"
                : "描述你的创作目标"
            }
            placeholder={
              composerMode === "quick"
                ? "输入问题，直接获得回答…"
                : "描述你想完成的目标…"
            }
          />
          </div>
          <div className="composer-footer">
            <div>
              <IconButton
                label={
                  uploading
                    ? "正在上传附件"
                    : canAddInputAsset
                      ? "添加附件"
                      : "当前模型不再接受更多输入素材"
                }
                disabled={uploading || !canAddInputAsset}
                onClick={() => attachmentRef.current?.click()}
              >
                <Paperclip size={17} />
              </IconButton>
            </div>
            <span>⌘ Enter 发送</span>
            <button
              type="button"
              className="send-button"
              aria-label="发送意图"
              disabled={
                !draft.trim() ||
                isPlanning ||
                isQuickAnswering ||
                !generatorReady ||
                !attachmentValidation.valid
              }
              onClick={submit}
            >
              <Send size={17} />
            </button>
          </div>
        </div>
        <div className="composer-options" aria-label="生成选项">
          <div className="composer-options-primary">
            <label className="composer-skill">
              <Sparkles size={15} />
              <span>
                {composerMode === "xiaoluo"
                  ? "小逻"
                  : composerMode === "quick"
                    ? "快速问答"
                  : composerMode === "text"
                    ? "文本生成"
                    : composerMode === "image"
                      ? "图片生成"
                      : "视频生成"}
              </span>
              <SelectMenu
                ariaLabel="工作模式"
                value={composerMode}
                onChange={(nextMode) => {
                  const mode = nextMode as ComposerMode;
                  setComposerMode(mode);
                  if (mode === "quick") setAttachments([]);
                  setPreferredCapabilityId("none");
                  setPreferredModelId("");
                  setModelParameters({});
                  setShowAdvancedComposerOptions(false);
                }}
                options={[
                  { value: "xiaoluo", label: "小逻" },
                  { value: "quick", label: "快速问答" },
                  { value: "text", label: "文本生成" },
                  { value: "image", label: "图片生成" },
                  { value: "video", label: "视频生成" },
                ]}
              />
              <ChevronDown size={13} />
            </label>
            {composerMode === "quick" && (
              <label className="composer-skill composer-model">
                <Cpu size={15} />
                <span>{quickAnswerModel?.name ?? "暂无通用文本模型"}</span>
                <SelectMenu
                  ariaLabel="快速问答模型"
                  value={quickAnswerModel?.id ?? ""}
                  onChange={setPreferredModelId}
                  options={
                    quickAnswerModels.length
                      ? quickAnswerModels.map((model) => ({
                          value: model.id,
                          label: model.name,
                        }))
                      : [{ value: "", label: "暂无通用文本模型" }]
                  }
                />
                <ChevronDown size={13} />
              </label>
            )}
            {professionalMode && (
              <>
                <label className="composer-skill composer-kind">
                  <MessageSquareText size={15} />
                  <span>
                    {preferredCapabilityId === "none"
                      ? "无"
                      : capabilities.find(
                          (capability) => capability.id === preferredCapabilityId,
                        )?.title ?? "无"}
                  </span>
                  <SelectMenu
                    ariaLabel="生成 Skill"
                    value={preferredCapabilityId}
                    onChange={(nextCapabilityId) => {
                      setPreferredCapabilityId(nextCapabilityId);
                      setPreferredModelId("");
                      setModelParameters({});
                      setShowAdvancedComposerOptions(false);
                    }}
                    options={[
                      { value: "none", label: "无" },
                      ...(professionalRules?.compatibleCapabilities ?? []).map(
                        (capability) => ({
                          value: capability.id,
                          label: capability.title,
                        }),
                      ),
                    ]}
                  />
                  <ChevronDown size={13} />
                </label>
                <label className="composer-skill composer-model">
                  <Cpu size={15} />
                  <span>
                    {professionalRules?.usesSkillRuntime
                      ? "Skill 内置执行服务"
                      : professionalRules?.model?.name ?? "暂无可用模型"}
                  </span>
                  <SelectMenu
                    ariaLabel="生成模型"
                    value={professionalRules?.model?.id ?? ""}
                    disabled={professionalRules?.usesSkillRuntime}
                    onChange={(nextModelId) => {
                      setPreferredModelId(nextModelId);
                      setShowAdvancedComposerOptions(false);
                    }}
                    options={[
                      ...(professionalRules?.usesSkillRuntime
                        ? [{ value: "", label: "Skill 内置执行服务" }]
                        : !professionalRules?.compatibleModels.length
                          ? [{ value: "", label: "暂无可用模型" }]
                          : []),
                      ...(professionalRules?.compatibleModels ?? []).map(
                        (model) => ({
                          value: model.id,
                          label: model.name,
                        }),
                      ),
                    ]}
                  />
                  <ChevronDown size={13} />
                </label>
                {composerModelParameterEntries.length > 0 && (
                  <button
                    type="button"
                    className="composer-more-options"
                    aria-expanded={showAdvancedComposerOptions}
                    onClick={() =>
                      setShowAdvancedComposerOptions((current) => !current)
                    }
                  >
                    <SlidersHorizontal size={14} />
                    <span>更多设置</span>
                    <ChevronDown
                      size={13}
                      className={showAdvancedComposerOptions ? "is-open" : ""}
                    />
                  </button>
                )}
              </>
            )}
          </div>
          {professionalMode &&
            showAdvancedComposerOptions &&
            composerModelParameterEntries.length > 0 && (
              <div className="composer-options-advanced">
                {composerModelParameterEntries.map(([paramKey, paramSchema]) => {
                  const ps = paramSchema as {
                    type?: string;
                    title?: string;
                    enum?: string[];
                    default?: string;
                  };
                  const paramValue = String(
                    modelParameters[paramKey] ?? ps.default ?? ps.enum?.[0] ?? "",
                  );
                  return (
                    <label
                      key={paramKey}
                      className="composer-skill composer-model-param"
                    >
                      <span className="composer-option-label">
                        {ps.title ?? paramKey}
                      </span>
                      <span title={ps.title ?? paramKey}>{paramValue}</span>
                      <SelectMenu
                        ariaLabel={ps.title ?? paramKey}
                        value={paramValue}
                        onChange={(nextParamValue) =>
                          setModelParameters((prev) => ({
                            ...prev,
                            [paramKey]: nextParamValue,
                          }))
                        }
                        options={(ps.enum ?? []).map((option) => ({
                          value: String(option),
                          label: String(option),
                        }))}
                      />
                      <ChevronDown size={13} />
                    </label>
                  );
                })}
              </div>
            )}
        </div>
        <input
          ref={attachmentRef}
          className="canvas-file-input"
          type="file"
          multiple
          disabled={uploading || !canAddInputAsset}
          onChange={(event) => {
            const remaining = Math.max(
              0,
              inputConstraints.maxTotal - attachments.length,
            );
            const files = [...(event.target.files ?? [])].slice(0, remaining);
            event.currentTarget.value = "";
            if (!files.length) return;
            setUploading(true);
            void onUploadAttachments(files)
              .then((uploaded) =>
                setAttachments((current) =>
                  [...current, ...uploaded].slice(0, inputConstraints.maxTotal),
                ),
              )
              .finally(() => setUploading(false));
          }}
        />
        <small className="composer-note">
          {composerMode === "xiaoluo"
            ? "小逻会先生成可检查计划，不会未经确认直接执行。"
            : composerMode === "quick"
              ? "快速问答只调用通用文本模型，不读取或修改当前画布。"
              : "专业生成会直接创建并运行当前画布节点，不经过 Agent 规划。"}
        </small>
      </div>
      </aside>
      {editingPlan && planDraft && typeof document !== "undefined"
        ? createPortal(
            <IntentPlanEditorDialog
              draft={planDraft}
              onChange={setPlanDraft}
              onClose={() => {
                setEditingPlan(false);
                setPlanDraft(null);
              }}
              onSave={() => {
                void onUpdatePlan(planDraft);
                setEditingPlan(false);
                setPlanDraft(null);
              }}
            />,
            document.body,
          )
        : null}
      {showHistory && conversationHistory.length > 0 && (
        <div className="intent-history-panel">
          <div className="intent-history-header">
            <span>历史对话</span>
            <button
              className="intent-history-close"
              onClick={() => setShowHistory(false)}
            >
              <X size={14} />
            </button>
          </div>
          <div className="intent-history-list">
            {conversationHistory.map((conv) => (
              <div
                key={conv.id}
                className={`intent-history-item${conv.status === "active" ? " is-active" : ""}`}
                onClick={() => {
                  if (conv.status === "archived" && onRestoreConversation) {
                    onRestoreConversation(conv.id);
                    setShowHistory(false);
                  }
                }}
              >
                <div className="intent-history-title">{conv.title}</div>
                <div className="intent-history-meta">
                  <span className={`intent-history-badge ${conv.status}`}>
                    {conv.status === "active" ? "进行中" : "已归档"}
                  </span>
                  <span className="intent-history-date">
                    {new Date(conv.updatedAt).toLocaleDateString("zh-CN")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function IntentPlanEditorDialog({
  draft,
  onChange,
  onClose,
  onSave,
}: {
  draft: IntentPlan;
  onChange: (next: IntentPlan) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const updateTask = (
    index: number,
    patch: Partial<IntentPlan["tasks"][number]>,
  ) => {
    onChange({
      ...draft,
      tasks: draft.tasks.map((task, taskIndex) =>
        taskIndex === index ? { ...task, ...patch } : task,
      ),
    });
  };

  const removeTask = (index: number) => {
    const removedId = draft.tasks[index]?.id;
    if (!removedId) return;
    onChange({
      ...draft,
      tasks: draft.tasks
        .filter((_, taskIndex) => taskIndex !== index)
        .map((task) => ({
          ...task,
          dependsOn: task.dependsOn.filter((id) => id !== removedId),
        })),
    });
  };

  const canSave =
    Boolean(draft.goal.trim()) &&
    draft.tasks.length > 0 &&
    draft.tasks.every(
      (task) => task.title.trim() && task.capability.trim() && task.duration.trim(),
    );

  return (
    <div
      className="intent-plan-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="intent-plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="intent-plan-dialog-title"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="intent-plan-dialog-header">
          <div>
            <span className="intent-plan-dialog-kicker">PLAN EDITOR</span>
            <h2 id="intent-plan-dialog-title">调整执行计划</h2>
            <p>在写入画布前检查目标、任务类型、执行能力、时长与依赖关系。</p>
          </div>
          <button type="button" aria-label="关闭计划编辑" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="intent-plan-dialog-body">
          <div className="intent-plan-dialog-overview">
            <span>{draft.tasks.length} 个任务</span>
            <span>{draft.estimate}</span>
            {draft.warning && (
              <span className="is-warning">
                <AlertTriangle size={14} /> {draft.warning}
              </span>
            )}
          </div>

          <label className="intent-plan-dialog-field is-goal">
            <span>计划目标</span>
            <textarea
              autoFocus
              aria-label="计划目标"
              value={draft.goal}
              onChange={(event) => onChange({ ...draft, goal: event.target.value })}
            />
          </label>

          <div className="intent-plan-dialog-tasks-heading">
            <div>
              <h3>任务步骤</h3>
              <p>调整每个步骤的内容与依赖顺序。</p>
            </div>
            <span>{draft.tasks.length} 项</span>
          </div>

          <div className="intent-plan-dialog-task-list">
            {draft.tasks.map((task, index) => (
              <article className="intent-plan-dialog-task" key={task.id}>
                <div className="intent-plan-dialog-task-header">
                  <span className="intent-plan-dialog-task-number">{index + 1}</span>
                  <strong>{task.title || `任务 ${index + 1}`}</strong>
                  {draft.tasks.length > 1 && (
                    <button
                      type="button"
                      aria-label={`删除任务 ${index + 1}`}
                      onClick={() => removeTask(index)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>

                <div className="intent-plan-dialog-task-grid">
                  <label className="intent-plan-dialog-field">
                    <span>任务名称</span>
                    <input
                      value={task.title}
                      onChange={(event) => updateTask(index, { title: event.target.value })}
                    />
                  </label>
                  <label className="intent-plan-dialog-field">
                    <span>执行能力</span>
                    <input
                      value={task.capability}
                      onChange={(event) =>
                        updateTask(index, { capability: event.target.value })
                      }
                    />
                  </label>
                  <label className="intent-plan-dialog-field">
                    <span>内容类型</span>
                    <SelectMenu
                      ariaLabel={`任务 ${index + 1} 内容类型`}
                      value={task.kind}
                      onChange={(kind) => updateTask(index, { kind: kind as NodeKind })}
                      options={[
                        { value: "text", label: "文本" },
                        { value: "image", label: "图片" },
                        { value: "video", label: "视频" },
                        { value: "audio", label: "音频" },
                        { value: "document", label: "文档" },
                      ]}
                    />
                  </label>
                  <label className="intent-plan-dialog-field">
                    <span>预计时长</span>
                    <input
                      value={task.duration}
                      placeholder="例如：5 分钟"
                      onChange={(event) =>
                        updateTask(index, { duration: event.target.value })
                      }
                    />
                  </label>
                  <fieldset className="intent-plan-dialog-dependencies">
                    <legend>依赖任务（可多选）</legend>
                    <div className="intent-plan-dialog-dependency-options">
                      {draft.tasks.filter((candidate) => candidate.id !== task.id).length ? (
                        draft.tasks
                          .filter((candidate) => candidate.id !== task.id)
                          .map((candidate) => (
                            <label key={candidate.id}>
                              <input
                                type="checkbox"
                                checked={task.dependsOn.includes(candidate.id)}
                                onChange={(event) => {
                                  const dependsOn = event.target.checked
                                    ? [...task.dependsOn, candidate.id]
                                    : task.dependsOn.filter((id) => id !== candidate.id);
                                  updateTask(index, { dependsOn });
                                }}
                              />
                              <span>{candidate.title}</span>
                            </label>
                          ))
                      ) : (
                        <small>当前只有一个任务，无需设置依赖。</small>
                      )}
                    </div>
                  </fieldset>
                </div>
              </article>
            ))}
          </div>
        </div>

        <footer className="intent-plan-dialog-footer">
          <span>保存后可继续确认并写入画布。</span>
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!canSave}
            onClick={onSave}
          >
            <Check size={16} /> 保存调整
          </button>
        </footer>
      </section>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  audio: "音频",
  document: "文档",
};

function MessageResultPreview({
  node,
  kind,
  onFocus,
}: {
  node: CanvasNode | undefined;
  kind?: NodeKind;
  onFocus?: (nodeId: string) => void;
}) {
  if (!node) return null;
  const kernelOutput = node.parameters?.kernelOutput as
    | { text?: string; assetUrl?: string; result?: string }
    | undefined;
  const assetUrl = kernelOutput?.assetUrl?.trim() || undefined;
  const textResult =
    node.result?.trim() ||
    kernelOutput?.text?.trim() ||
    kernelOutput?.result?.trim() ||
    "";
  const mediaKind = kind ?? node.kind;
  const kindLabel = KIND_LABEL[mediaKind] ?? "内容";
  const busy = ["draft", "queued", "waiting", "running", "paused"].includes(
    node.status,
  );
  const failed = ["failed", "canceled", "skipped"].includes(node.status);
  const locate = () => onFocus?.(node.id);

  if (busy) {
    return (
      <div className="message-result-card message-result-loading" role="status">
        <span className="message-result-spinner" aria-hidden="true" />
        <span>正在生成{kindLabel}结果…</span>
</div>
    );
  }
  if (failed) {
    return (
      <button
        type="button"
        className="message-result-card message-result-failed"
        onClick={locate}
        aria-label="定位到画布中的失败结果"
      >
        <AlertTriangle size={14} />
        <span>{node.result?.trim() || `生成失败：${kindLabel}节点未返回结果`}</span>
        <small>定位到画布</small>
      </button>
    );
  }
  if (mediaKind === "image" && assetUrl) {
    return (
      <button
        type="button"
        className="message-result-card"
        onClick={locate}
        aria-label="定位到画布中的图片结果"
        title="点击定位到画布结果"
      >
        <img src={assetUrl} alt={`结果缩略图：${node.title}`} loading="lazy" decoding="async" />
        <small>点击定位到画布</small>
      </button>
    );
  }
  if (mediaKind === "video" && assetUrl) {
    return (
      <button
        type="button"
        className="message-result-card"
        onClick={locate}
        aria-label="定位到画布中的视频结果"
        title="点击定位到画布结果"
      >
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={`${assetUrl}#t=0.1`} muted preload="metadata" aria-hidden="true" />
        <small>点击定位到画布</small>
      </button>
    );
  }
  if (textResult) {
    return (
      <button
        type="button"
        className="message-result-card message-result-text"
        onClick={locate}
        aria-label="定位到画布中的文本结果"
        title="点击定位到画布结果"
      >
        <p>
          {textResult.length > 140
            ? `${textResult.slice(0, 140)}…`
            : textResult}
        </p>
        <small>点击定位到画布</small>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="message-result-card message-result-text"
      onClick={locate}
      aria-label="定位到画布中的结果节点"
      title="点击定位到画布结果"
    >
      <p>生成完成</p>
      <small>点击定位到画布</small>
    </button>
  );
}
