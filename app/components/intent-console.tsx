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
  Pause,
  Pencil,
  Play,
  Quote,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MediaViewer } from "./media-viewer";
import { SelectMenu } from "./select-menu";
import { SchemaFields } from "./schema-fields";
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
import { AudioPlayer } from "./audio-player";
import { IconButton } from "./icon-button";
import { VideoPlayer } from "./video-player";
import { InputAssetPreview, NodePromptEditor } from "./node-card";
import { resolveAssetContentUrl } from "./asset-content-preview";
import {
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../lib/model-input-constraints";
import { XiaoluoBrainPanel } from "./xiaoluo-brain-panel";
import type { BrainPanelHandle } from "./xiaoluo-brain-panel";
import type { BrainResultSnapshot } from "./brain-result-dock";
import type { ChatAdapters } from "../xiaoluo-brain/hooks/use-chat-agent";
import { resolveProfessionalGeneratorRules } from "../lib/professional-generator-rules";


type ComposerMode = "brain" | "quick" | "text" | "image" | "video" | "audio";

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

const ATTACHMENT_UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 附件展示名：系统生成的 UUID 文件名翻译为「图片/视频/音频/文件 · 扩展名」
function attachmentLabel(attachment: ChatAttachment): string {
  const dot = attachment.name.lastIndexOf(".");
  const base = dot > 0 ? attachment.name.slice(0, dot) : attachment.name;
  const ext = dot > 0 ? attachment.name.slice(dot + 1).toUpperCase() : "";
  if (!ATTACHMENT_UUID_NAME.test(base)) return attachment.name;
  const kindLabel =
    attachment.kind === "image"
      ? "图片"
      : attachment.kind === "video"
        ? "视频"
        : attachment.kind === "audio"
          ? "音频"
          : "文件";
  return ext ? kindLabel + " · " + ext : kindLabel;
}

interface IntentConsoleProps {
  messages: ChatMessage[];
  plan: IntentPlan | null;
  isPlanning: boolean;
  isQuickAnswering: boolean;
  runState: RunState;
  planApplied?: boolean;
  onClose: () => void;
  capabilities: Capability[];
  models: ModelConnection[];
  canvasAssets: CanvasAssetReference[];
  nodes: CanvasNode[];
  canvasId?: string;
  /** 小逻大脑 generate_media 直派口（来自 useIntentOs.generateForBrain） */
  onGenerateMedia?: ChatAdapters["generateMedia"];
  /** 小逻大脑最新代码产物/预览上报（画布独立结果面板消费） */
  onBrainResult?: (snapshot: BrainResultSnapshot) => void;
  /** 程序库一键上画布（画布⇄代码）：透传给画布建节点 */
  onPinProgram?: (p: { name: string; entry: string; artifact: NonNullable<BrainResultSnapshot["artifact"]> }) => void;
  /** 时间线事件跳转：打开“小逻结果”面板并定位 Tab */
  onOpenResult?: (tab: "code" | "preview") => void;
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
    kind: Extract<NodeKind, "text" | "image" | "video" | "audio">,
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
  onDeleteConversation?: (id: string) => void | Promise<void>;
  onNewConversation?: () => void;
  activeConversationId?: string;
  conversationHistory?: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  onFetchHistory?: () => void | Promise<void>;
  onRestoreConversation?: (id: string) => void | Promise<void>;
  onRenameConversation?: (id: string, title: string) => void | Promise<void>;
}

export function IntentConsole({
  messages,
  plan,
  isPlanning,
  isQuickAnswering,
  runState,
  planApplied = false,
  onClose,
  capabilities,
  models,
  canvasAssets,
  nodes,
  canvasId,
  onGenerateMedia,
  onBrainResult,
  onOpenResult,
  onPinProgram,
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
  onDeleteConversation,
  onNewConversation,
  activeConversationId,
  conversationHistory = [],
  onFetchHistory,
  onRestoreConversation,
  onRenameConversation,
}: IntentConsoleProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historySelectingId, setHistorySelectingId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [quotedId, setQuotedId] = useState<string | null>(null);
  // 点击图片附件后的全屏放大预览（与画布素材同一组件：可关闭、滚轮缩放）
  const [viewerImage, setViewerImage] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<{
    id: string;
    role: string;
    content: string;
    attachments?: ChatAttachment[];
    resultNodeId?: string;
  } | null>(null);

  function copyMessage(content: string, id: string) {
    void navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  // 引用消息：输入框下方显示引用条（缩略展示），发送时以引用格式并入正文
  function quoteMessage(message: ChatMessage) {
    setQuotedMessage({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.resultNodeId ? { resultNodeId: message.resultNodeId } : {}),
    });
    setQuotedId(message.id);
    setTimeout(() => setQuotedId(null), 1500);
  }

  // 引用条按类型展示：文本保留文本，图片附件与生成结果显示真实缩略图
  const quotedPreviews: Array<{ key: string; url: string; label: string }> =
    (() => {
      if (!quotedMessage) return [];
      const items: Array<{ key: string; url: string; label: string }> = [];
      for (const attachment of quotedMessage.attachments ?? []) {
        if (attachment.kind === "image") {
          items.push({
            key: attachment.id,
            url: resolveAssetContentUrl(
              attachment.previewUrl ?? attachment.uri,
            ),
            label: attachment.name,
          });
        }
      }
      if (quotedMessage.resultNodeId) {
        const node = nodes.find(
          (item) => item.id === quotedMessage.resultNodeId,
        );
        const kernelOutput = node?.parameters?.kernelOutput as
          | { assetUrl?: string }
          | undefined;
        const assetUrl = kernelOutput?.assetUrl?.trim();
        if (
          node &&
          assetUrl &&
          (node.kind === "image" || node.kind === "video")
        ) {
          items.push({
            key: `result:${node.id}`,
            url: resolveAssetContentUrl(assetUrl),
            label: node.title,
          });
        }
      }
      return items.slice(0, 4);
    })();
  const quotedFiles = (quotedMessage?.attachments ?? []).filter(
    (attachment) => attachment.kind !== "image",
  );

  async function loadConversationHistory() {
    if (!onFetchHistory) return;
    setHistoryError("");
    setHistoryLoading(true);
    try {
      await onFetchHistory();
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "历史记录加载失败，请稍后重试。",
      );
    } finally {
      setHistoryLoading(false);
    }
  }

  function toggleHistory() {
    const opening = !showHistory;
    setShowHistory(opening);
    if (opening) void loadConversationHistory();
  }

  async function selectConversation(id: string) {
    if (id === activeConversationId) {
      setShowHistory(false);
      return;
    }
    if (!onRestoreConversation || historySelectingId) return;
    setHistoryError("");
    setHistorySelectingId(id);
    try {
      await onRestoreConversation(id);
      setShowHistory(false);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "对话切换失败，请稍后重试。",
      );
    } finally {
      setHistorySelectingId("");
    }
  }
  const [composerMode, setComposerMode] =
    useState<ComposerMode>("brain");
  const [preferredCapabilityId, setPreferredCapabilityId] = useState("none");
  const [preferredModelId, setPreferredModelId] = useState("");
  const [modelParameters, setModelParameters] = useState<Record<string, unknown>>({});
  const [showAdvancedComposerOptions, setShowAdvancedComposerOptions] =
    useState(false);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const brainSendRef = useRef<BrainPanelHandle | null>(null);
  const professionalMode =
    composerMode === "text" ||
    composerMode === "image" ||
    composerMode === "video" ||
    composerMode === "audio"
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
  // 选中任意 Skill（含模型驱动型）即免提示词，素材为必填
  const skillMode = Boolean(professionalMode && professionalRules?.capability);
  const composerModelParameterEntries = professionalRules?.model?.parameterSchema
    ? Object.entries(
        professionalRules.model.parameterSchema.properties ?? {},
      ).filter(([, paramSchema]) => {
        const schema = paramSchema as { enum?: string[] };
        return Boolean(schema.enum?.length);
      })
    : [];
  // 非枚举模型参数（如 Suno 的歌曲标题 / 风格标签）：用 SchemaFields 渲染完整交互
  const composerModelExtraSchema = (() => {
    const schema = professionalRules?.model?.parameterSchema;
    if (!schema) return null;
    const properties = Object.fromEntries(
      Object.entries(
        (schema as { properties?: Record<string, unknown> }).properties ?? {},
      ).filter(
        ([, field]) =>
          !Boolean((field as { enum?: string[] }).enum?.length),
      ),
    );
    if (!Object.keys(properties).length) return null;
    return { ...(schema as Record<string, unknown>), properties };
  })();
  const canAddInputAsset =
    inputConstraints.maxTotal > 0 &&
    attachments.length < inputConstraints.maxTotal;
  // 粘贴/选择文件 → 统一走上传链路（剩余名额受当前模型输入约束限制）
  function addFilesAsAttachments(files: File[]) {
    const remaining = Math.max(
      0,
      inputConstraints.maxTotal - attachments.length,
    );
    const picked = files.slice(0, remaining);
    if (!picked.length) return;
    setUploading(true);
    void onUploadAttachments(picked)
      .then((uploaded) =>
        setAttachments((current) =>
          [...current, ...uploaded].slice(0, inputConstraints.maxTotal),
        ),
      )
      .finally(() => setUploading(false));
  }
  // 同一对话的所有消息统一展示：切换分类（小逻/快速问答/各节点）不拆分对话流
  const visibleMessages = messages;

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
    url: resolveAssetContentUrl(attachment.previewUrl ?? attachment.uri),
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
    // 本地模型：通知嵌入式引擎"有活动"，重置空闲自动停止计时
    {
      const activeModel =
        quickAnswerModels.find((model) => model.id === preferredModelId) ??
        professionalRules?.model ??
        null;
      if (activeModel && (activeModel.capabilityTags ?? []).includes("local")) {
        const bridge = (
          window as unknown as {
            xiaoluoDesktop?: { localAi?: (payload: { action: string }) => unknown };
          }
        ).xiaoluoDesktop;
        void bridge?.localAi?.({ action: "notify-activity" });
      }
    }
    // 有引用条时：引用内容按行加前缀并入正文
    const quoteBlock = quotedMessage
      ? quotedMessage.content
          .split("\n")
          .map((line) => (line ? "> " + line : ">"))
          .join("\n") +
        "\n\n"
      : "";
    const outgoing = quoteBlock + draft;
    if (composerMode === "brain") {
      // brain 模式：底部输入条驱动小逻大脑面板发送
      if (!draft.trim()) return;
      // 附件随正文交给大脑面板：面板负责物化进工作区 uploads/ 并注入【附件】段（二进制不塞正文）
      brainSendRef.current?.send(outgoing, attachments);
    } else if (professionalMode) {
      // Skill 模式：提示词可留空，素材为必填
      if (!draft.trim() && !skillMode) return;
      if (skillMode && attachments.length === 0) return;
      if (!generatorReady || !attachmentValidation.valid) return;
      onGenerate(
        outgoing,
        professionalMode,
        preferredCapabilityId,
        professionalRules?.model?.id,
        attachments,
        modelParameters,
      );
    } else {
      if (!draft.trim()) return;
      // 小逻模式：显式选定的大模型随请求下发（未选则由服务端按健康度自动选）
      onSubmit(
        outgoing,
        attachments,
        undefined,
        quickAnswerModels.some((model) => model.id === preferredModelId)
          ? preferredModelId
          : undefined,
      );
    }
    setDraft("");
    setAttachments([]);
    setQuotedMessage(null);
  }

  return (
    <>
      <aside className="intent-console" aria-label="Intent Console">
      <div className="console-header">
        <div className="console-title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="console-logo"
            src="/xiaoluo-mascot.jpg"
            alt="小逻"
            width={33}
            height={33}
            draggable={false}
          />
          <div>
            <strong>小逻</strong>
            <small>智能创作在线</small>
          </div>
        </div>
        <div className="console-header-actions">
          {showHistory && (
            <div
              id="intent-history-panel"
              className="intent-history-panel"
              role="dialog"
              aria-label="最近对话"
            >
              <div className="intent-history-header">
                <span>最近对话</span>
                <button
                  type="button"
                  className="intent-history-close"
                  aria-label="关闭最近对话"
                  onClick={() => setShowHistory(false)}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="intent-history-list" aria-busy={historyLoading}>
                {historyLoading ? (
                  <div className="intent-history-state">
                    <span className="intent-history-loading" aria-hidden="true" />
                    <strong>正在加载最近对话</strong>
                    <small>请稍候…</small>
                  </div>
                ) : historyError ? (
                  <div className="intent-history-state is-error" role="alert">
                    <AlertTriangle size={20} />
                    <strong>最近对话加载失败</strong>
                    <small>{historyError}</small>
                    <button type="button" onClick={() => void loadConversationHistory()}>
                      重新加载
                    </button>
                  </div>
                ) : conversationHistory.length === 0 ? (
                  <div className="intent-history-state">
                    <Clock size={20} />
                    <strong>暂无最近对话</strong>
                    <small>新建的对话会显示在这里。</small>
                  </div>
                ) : (
                  conversationHistory.map((conv) => {
                    const isCurrent = conv.id === activeConversationId;
                    const isSelecting = conv.id === historySelectingId;
                    const isRenaming = conv.id === renamingId;
                    return (
                      <div
                        key={conv.id}
                        className={`intent-history-item${isCurrent ? " is-active" : ""}`}
                        aria-current={isCurrent ? "true" : undefined}
                      >
                        {isRenaming ? (
                          <input
                            className="intent-history-rename-input"
                            value={renameValue}
                            autoFocus
                            aria-label="对话名称"
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                const nextTitle = renameValue.trim();
                                if (nextTitle && onRenameConversation) {
                                  void onRenameConversation(conv.id, nextTitle);
                                }
                                setRenamingId("");
                              } else if (event.key === "Escape") {
                                setRenamingId("");
                              }
                            }}
                            onBlur={() => {
                              const nextTitle = renameValue.trim();
                              if (nextTitle && nextTitle !== conv.title && onRenameConversation) {
                                void onRenameConversation(conv.id, nextTitle);
                              }
                              setRenamingId("");
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="intent-history-item-main"
                            aria-busy={isSelecting}
                            disabled={Boolean(historySelectingId)}
                            onClick={() => void selectConversation(conv.id)}
                          >
                            <span className="intent-history-title">{conv.title}</span>
                          </button>
                        )}
                        <div className="intent-history-item-actions">
                          <button
                            type="button"
                            className="intent-history-action"
                            title="重命名对话"
                            aria-label="重命名对话"
                            onClick={(event) => {
                              event.stopPropagation();
                              setRenamingId(conv.id);
                              setRenameValue(conv.title);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          {onDeleteConversation && (
                            <button
                              type="button"
                              className="intent-history-action is-danger"
                              title="删除对话"
                              aria-label="删除对话"
                              onClick={(event) => {
                                event.stopPropagation();
                                void onDeleteConversation(conv.id);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
          <IconButton label="折叠 Intent Console" onClick={onClose}>
            <PanelRightClose size={17} />
          </IconButton>
        </div>
      </div>

      {composerMode === "brain" && canvasId && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <XiaoluoBrainPanel
            canvasId={canvasId}
            models={models}
            onGenerateMedia={onGenerateMedia}
            onBrainResult={onBrainResult}
            onOpenResult={onOpenResult}
            onPinProgram={onPinProgram}
            selectedModelId={preferredModelId || undefined}
            sendRef={brainSendRef}
          />
        </div>
      )}
      <div
        className="console-messages"
        aria-live="polite"
        style={composerMode === "brain" ? { display: "none" } : undefined}
      >
        {composerMode === "quick" && visibleMessages.length === 0 && (
          <div className="message message-assistant">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="message-avatar"
              src="/xiaoluo-mascot.jpg"
              alt="小逻"
              width={27}
              height={27}
              draggable={false}
            />
            <div className="message-bubble">
              <p>这里是快速问答。我只回答通用文本问题，不读取或修改当前画布。</p>
            </div>
          </div>
        )}
        {visibleMessages.map((message) => (
          <div key={message.id} className={`message message-${message.role}`}>
            {message.role === "assistant" && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="message-avatar"
                  src="/xiaoluo-mascot.jpg"
                  alt="小逻"
                  width={27}
                  height={27}
                  draggable={false}
                />
              </>
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
                  {message.attachments.map((attachment) => {
                    const url = resolveAssetContentUrl(
                      attachment.previewUrl ?? attachment.uri,
                    );
                    const label = attachmentLabel(attachment);
                    if (attachment.kind === "image") {
                      return (
                        <button
                          key={attachment.id}
                          type="button"
                          className="message-attachment-media"
                          title={label}
                          onClick={() => setViewerImage({ url, label })}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={label}
                            width={96}
                            height={96}
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                          />
                        </button>
                      );
                    }
                    if (attachment.kind === "video") {
                      return (
                        <div
                          key={attachment.id}
                          className="message-attachment-media message-attachment-video"
                        >
                          <VideoPlayer src={url} title={label} />
                        </div>
                      );
                    }
                    if (attachment.kind === "audio") {
                      return (
                        <div
                          key={attachment.id}
                          className="message-attachment-media message-attachment-audio"
                        >
                          <AudioPlayer src={url} title={label} />
                        </div>
                      );
                    }
                    return (
                      <span key={attachment.id} title={attachment.name}>
                        <Paperclip size={11} /> {label}
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="message-actions">
                <button
                  className="message-copy-btn"
                  title="引用内容"
                  onClick={() => quoteMessage(message)}
                >
                  {quotedId === message.id ? (
                    <>
                      <Check size={12} />
                      <span>已引用</span>
                    </>
                  ) : (
                    <>
                      <Quote size={12} />
                      <span>引用</span>
                    </>
                  )}
                </button>
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

        {composerMode === "quick" && isQuickAnswering && (
          <div className="planning-state" aria-label="快速问答生成中">
            <span className="planning-orbit" />
            <div>
              <strong>正在回答…</strong>
              <small>{quickAnswerModel?.name ?? "通用文本模型"}</small>
            </div>
          </div>
        )}
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
                    url: resolveAssetContentUrl(
                      attachment.previewUrl ?? attachment.uri,
                    ),
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
            onPasteFiles={addFilesAsAttachments}
            aria-label={
              composerMode === "quick"
                ? "输入快速问答问题"
                : "描述你的创作目标"
            }
            placeholder={
              composerMode === "brain"
                ? "让小逻写代码 / 出预览 / 做任何事…"
                  : skillMode
                    ? "已选 Skill，输入素材后可直接执行（提示词可选）"
                    : "描述你想完成的目标…"
            }
          />
          </div>
          {quotedMessage && (
            <div className="composer-quote-bar">
              <span className="composer-quote-text" title={quotedMessage.content}>
                {quotedMessage.role === "assistant" ? "小逻: " : "我: "}
                {quotedMessage.content.replace(/\s+/g, " ").trim() ||
                  (quotedPreviews.length || quotedFiles.length
                    ? "（媒体消息）"
                    : "")}
              </span>
              {quotedPreviews.map((preview) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={preview.key}
                  className="composer-quote-thumb"
                  src={preview.url}
                  alt={preview.label}
                  title={preview.label}
                  width={30}
                  height={30}
                  draggable={false}
                />
              ))}
              {quotedFiles.map((attachment) => (
                <span
                  key={attachment.id}
                  className="composer-quote-file"
                  title={attachment.name}
                >
                  <Paperclip size={11} />
                </span>
              ))}
              <button
                type="button"
                className="composer-quote-close"
                aria-label="取消引用"
                title="取消引用"
                onClick={() => setQuotedMessage(null)}
              >
                <X size={12} />
              </button>
            </div>
          )}
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
                isPlanning ||
                isQuickAnswering ||
                !generatorReady ||
                !attachmentValidation.valid ||
                (skillMode ? attachments.length === 0 : !draft.trim())
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
              <span>
                {composerMode === "brain"
                  ? "智能创作"
                  : composerMode === "text"
                      ? "文本节点"
                      : composerMode === "image"
                        ? "图片节点"
                        : composerMode === "video"
                          ? "视频节点"
                          : "音频节点"}
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
                  // 音频模式的风格标签为必填参数，默认展开高级选项
                  setShowAdvancedComposerOptions(mode === "audio");
                }}
                options={[
                  { value: "brain", label: "智能创作" },
                  { value: "text", label: "文本节点" },
                  { value: "image", label: "图片节点" },
                  { value: "video", label: "视频节点" },
                  { value: "audio", label: "音频节点" },
                ]}
              />
              <ChevronDown size={13} />
            </label>
            {(composerMode === "brain" || composerMode === "quick") && (
              <label className="composer-skill composer-model">
                <Cpu size={15} />
                <span>{quickAnswerModel?.name ?? "暂无通用文本模型"}</span>
                <SelectMenu
                  ariaLabel="通用文本模型"
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
                          label: (model.capabilityTags ?? []).includes("local")
                            ? "💻 " + model.name
                            : model.name,
                        }),
                      ),
                    ]}
                  />
                  <ChevronDown size={13} />
                </label>
                {(composerModelParameterEntries.length > 0 || composerModelExtraSchema) && (
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
            (composerModelParameterEntries.length > 0 || composerModelExtraSchema) && (
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
                {composerModelExtraSchema && (
                  <SchemaFields
                    title="模型参数"
                    schema={composerModelExtraSchema}
                    uiSchema={professionalRules?.model?.uiSchema ?? {}}
                    value={modelParameters}
                    onChange={setModelParameters}
                  />
                )}
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
            const files = [...(event.target.files ?? [])];
            event.currentTarget.value = "";
            if (!files.length) return;
            addFilesAsAttachments(files);
          }}
        />
        <small className="composer-note">
          {composerMode === "brain"
            ? "智能创作：对话驱动，写代码、出预览、深度思考按需自动切换。"
            : "专业生成会直接创建并运行当前画布节点，不经过 Agent 规划。"}
        </small>
      </div>
      </aside>
            {viewerImage && (
        <MediaViewer
          url={viewerImage.url}
          kind="image"
          title={viewerImage.label}
          onClose={() => setViewerImage(null)}
        />
      )}
    </>
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
