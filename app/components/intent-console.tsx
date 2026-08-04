"use client";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleStop,
  Cpu,
  ListChecks,
  MessageSquareText,
  PanelRightClose,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import type {
  CanvasAssetReference,
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

const XIAOLUO_INPUT_CONSTRAINTS: ModelInputConstraints = {
  maxTotal: 8,
  maxByType: { image: 8, video: 8, audio: 8, document: 8 },
};

function attachmentInputKind(attachment: ChatAttachment): ModelInputAssetKind {
  return attachment.kind === "image" ||
    attachment.kind === "video" ||
    attachment.kind === "audio"
    ? attachment.kind
    : "document";
}

interface IntentConsoleProps {
  messages: ChatMessage[];
  plan: IntentPlan | null;
  isPlanning: boolean;
  runState: RunState;
  onClose: () => void;
  capabilities: Capability[];
  models: ModelConnection[];
  canvasAssets: CanvasAssetReference[];
  onSubmit: (
    value: string,
    attachments?: ChatAttachment[],
    preferredCapabilityId?: string,
    preferredModelId?: string,
  ) => void;
  onGenerate: (
    value: string,
    kind: Extract<NodeKind, "text" | "image" | "video">,
    capabilityId?: string,
    modelId?: string,
    attachments?: ChatAttachment[],
  ) => void;
  onUploadAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onConfirmPlan: () => void | Promise<void>;
  onUpdatePlan: (plan: IntentPlan) => void | Promise<void>;
  onRejectPlan: () => void | Promise<void>;
  onStart: () => void;
  onPause: () => void;
  onCancel: () => void;
}

export function IntentConsole({
  messages,
  plan,
  isPlanning,
  runState,
  onClose,
  capabilities,
  models,
  canvasAssets,
  onSubmit,
  onGenerate,
  onUploadAttachments,
  onConfirmPlan,
  onUpdatePlan,
  onRejectPlan,
  onStart,
  onPause,
  onCancel,
}: IntentConsoleProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [planDraft, setPlanDraft] = useState<IntentPlan | null>(null);
  const [composerMode, setComposerMode] = useState<
    "xiaoluo" | "text" | "image" | "video"
  >("xiaoluo");
  const [preferredCapabilityId, setPreferredCapabilityId] = useState("none");
  const [preferredModelId, setPreferredModelId] = useState("");
  const attachmentRef = useRef<HTMLInputElement>(null);
  const professionalMode = composerMode === "xiaoluo" ? null : composerMode;
  const professionalRules = professionalMode
    ? resolveProfessionalGeneratorRules({
        capabilities,
        models,
        kind: professionalMode,
        requestedCapabilityId: preferredCapabilityId,
        requestedModelId: preferredModelId || undefined,
      })
    : null;
  const inputConstraints = professionalMode
    ? normalizeModelInputConstraints(
        professionalRules?.model?.inputConstraints,
        professionalMode,
        professionalRules?.model?.protocol,
      )
    : XIAOLUO_INPUT_CONSTRAINTS;
  const attachmentValidation = validateModelInputAssets(
    inputConstraints,
    attachments.map((attachment) => ({
      kind: attachmentInputKind(attachment),
    })),
  );
  const generatorReady = professionalMode
    ? Boolean(professionalRules?.model || professionalRules?.usesSkillRuntime)
    : true;
  const canAddInputAsset =
    inputConstraints.maxTotal > 0 &&
    attachments.length < inputConstraints.maxTotal;

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
    if (composerMode !== "xiaoluo") {
      if (!generatorReady || !attachmentValidation.valid) return;
      onGenerate(
        draft,
        composerMode,
        preferredCapabilityId,
        professionalRules?.model?.id,
        attachments,
      );
    } else {
      onSubmit(draft, attachments);
    }
    setDraft("");
    setAttachments([]);
  }

  return (
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
              {composerMode === "xiaoluo" ? "小逻大脑在线" : "专业生成器"}
            </small>
          </div>
        </div>
        <div className="console-header-actions">
          <IconButton label="折叠 Intent Console" onClick={onClose}>
            <PanelRightClose size={17} />
          </IconButton>
        </div>
      </div>

      <div className="console-messages" aria-live="polite">
        {messages.map((message) => (
          <div key={message.id} className={`message message-${message.role}`}>
            {message.role === "assistant" && (
              <span className="message-avatar">
                <Sparkles size={14} />
              </span>
            )}
            <div className="message-bubble">
              <p>{message.content}</p>
              {!!message.attachments?.length && (
                <div className="message-attachments">
                  {message.attachments.map((attachment) => (
                    <span key={attachment.id}>
                      <Paperclip size={11} /> {attachment.name}
                    </span>
                  ))}
                </div>
              )}
              <time>{message.time}</time>
            </div>
          </div>
        ))}

        {isPlanning && (
          <div className="planning-state">
            <span className="planning-orbit" />
            <div>
              <strong>正在理解意图并检查能力…</strong>
              <small>生成目标、任务依赖与成本估计</small>
            </div>
          </div>
        )}

        {plan && (
          <section className="plan-card" aria-label="待确认计划">
            <div className="plan-heading">
              <span>
                <ListChecks size={17} /> 执行计划
              </span>
              <span className="plan-badge">待确认</span>
            </div>
            {editingPlan && planDraft ? (
              <input
                className="plan-edit-goal"
                aria-label="计划目标"
                value={planDraft.goal}
                onChange={(event) =>
                  setPlanDraft({ ...planDraft, goal: event.target.value })
                }
              />
            ) : (
              <h3>{plan.goal}</h3>
            )}
            <div className="plan-tasks">
              {(editingPlan && planDraft ? planDraft : plan).tasks.map((task, index) => (
                <div key={task.id} className="plan-task">
                  <span>{index + 1}</span>
                  <div>
                    {editingPlan && planDraft ? (
                      <>
                        <input
                          aria-label={`任务 ${index + 1} 标题`}
                          value={task.title}
                          onChange={(event) =>
                            setPlanDraft({
                              ...planDraft,
                              tasks: planDraft.tasks.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, title: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                        <input
                          aria-label={`任务 ${index + 1} 能力`}
                          value={task.capability}
                          onChange={(event) =>
                            setPlanDraft({
                              ...planDraft,
                              tasks: planDraft.tasks.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, capability: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                        <select
                          aria-label={`任务 ${index + 1} 模态`}
                          value={task.kind}
                          onChange={(event) =>
                            setPlanDraft({
                              ...planDraft,
                              tasks: planDraft.tasks.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, kind: event.target.value as typeof item.kind }
                                  : item,
                              ),
                            })
                          }
                        >
                          <option value="text">文本</option>
                          <option value="image">图片</option>
                          <option value="video">视频</option>
                          <option value="audio">音频</option>
                          <option value="document">文档</option>
                        </select>
                        <label className="plan-dependency-editor">
                          <small>依赖（可多选）</small>
                          <select
                            multiple
                            aria-label={`任务 ${index + 1} 依赖`}
                            value={task.dependsOn}
                            onChange={(event) => {
                              const dependsOn = [...event.target.selectedOptions].map(
                                (option) => option.value,
                              );
                              setPlanDraft({
                                ...planDraft,
                                tasks: planDraft.tasks.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, dependsOn } : item,
                                ),
                              });
                            }}
                          >
                            {planDraft.tasks
                              .filter((candidate) => candidate.id !== task.id)
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.title}
                                </option>
                              ))}
                          </select>
                        </label>
                      </>
                    ) : (
                      <>
                        <b>{task.title}</b>
                        <small>
                          {task.capability} · {task.kind} · {task.duration}
                        </small>
                        <small>
                          依赖：{task.dependsOn.length ? task.dependsOn.join("、") : "无（起点）"}
                        </small>
                      </>
                    )}
                  </div>
                  {editingPlan && planDraft && planDraft.tasks.length > 1 && (
                    <button
                      type="button"
                      aria-label={`删除任务 ${index + 1}`}
                      onClick={() =>
                        setPlanDraft({
                          ...planDraft,
                          tasks: planDraft.tasks
                            .filter((_, itemIndex) => itemIndex !== index)
                            .map((item) => ({
                              ...item,
                              dependsOn: item.dependsOn.filter((id) => id !== task.id),
                            })),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
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
              {editingPlan && planDraft ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!planDraft.goal.trim() || !planDraft.tasks.length}
                  onClick={() => {
                    void onUpdatePlan(planDraft);
                    setEditingPlan(false);
                  }}
                >
                  保存调整
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setPlanDraft({
                      ...plan,
                      tasks: plan.tasks.map((task) => ({ ...task })),
                    });
                    setEditingPlan(true);
                  }}
                >
                  调整计划
                </button>
              )}
              <button type="button" className="primary-button" onClick={onConfirmPlan}>
                <Check size={15} /> 确认并写入画布
              </button>
            </div>
          </section>
        )}

        {runState === "ready" && (
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

        {(runState === "running" ||
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

        {(runState === "succeeded" ||
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
        {suggestions.map((suggestion) => (
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
            assets={mentionAssets}
            attachedSourceIds={attachedSourceIds}
            onChange={setDraft}
            onAttach={attachCanvasAsset}
            onSubmitShortcut={submit}
            aria-label="描述你的创作目标"
            placeholder="描述你想完成的目标…"
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
              <label className="composer-skill">
                <Sparkles size={15} />
                <span>
                  {composerMode === "xiaoluo"
                    ? "小逻"
                    : composerMode === "text"
                      ? "文本生成"
                      : composerMode === "image"
                        ? "图片生成"
                        : "视频生成"}
                </span>
                <select
                  aria-label="工作模式"
                  value={composerMode}
                  onChange={(event) => {
                    setComposerMode(
                      event.target.value as "xiaoluo" | "text" | "image" | "video",
                    );
                    setPreferredCapabilityId("none");
                    setPreferredModelId("");
                  }}
                >
                  <option value="xiaoluo">小逻</option>
                  <option value="text">文本生成</option>
                  <option value="image">图片生成</option>
                  <option value="video">视频生成</option>
                </select>
                <ChevronDown size={13} />
              </label>
              {composerMode !== "xiaoluo" && (
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
                    <select
                      aria-label="生成 Skill"
                      value={preferredCapabilityId}
                      onChange={(event) => {
                        setPreferredCapabilityId(event.target.value);
                        setPreferredModelId("");
                      }}
                    >
                      <option value="none">无</option>
                      {professionalRules?.compatibleCapabilities.map(
                        (capability) => (
                          <option key={capability.id} value={capability.id}>
                            {capability.title}
                          </option>
                        ),
                      )}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                  <label className="composer-skill composer-model">
                    <Cpu size={15} />
                    <span>
                      {professionalRules?.usesSkillRuntime
                        ? "Skill 内置执行服务"
                        : professionalRules?.model?.name ?? "暂无可用模型"}
                    </span>
                    <select
                      aria-label="生成模型"
                      value={professionalRules?.model?.id ?? ""}
                      disabled={professionalRules?.usesSkillRuntime}
                      onChange={(event) => setPreferredModelId(event.target.value)}
                    >
                      {professionalRules?.usesSkillRuntime ? (
                        <option value="">Skill 内置执行服务</option>
                      ) : !professionalRules?.compatibleModels.length ? (
                        <option value="">暂无可用模型</option>
                      ) : null}
                      {professionalRules?.compatibleModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                </>
              )}
            </div>
            <span>⌘ Enter 发送</span>
            <button
              type="button"
              className="send-button"
              aria-label="发送意图"
              disabled={
                !draft.trim() ||
                isPlanning ||
                !generatorReady ||
                !attachmentValidation.valid
              }
              onClick={submit}
            >
              <Send size={17} />
            </button>
          </div>
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
            : "专业生成会直接创建并运行当前画布节点，不经过 Agent 规划。"}
        </small>
      </div>
    </aside>
  );
}
