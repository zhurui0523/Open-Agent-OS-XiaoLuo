"use client";

import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Cpu,
  Download,
  FileText,
  FileOutput,
  GitBranch,
  GripVertical,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Video,
  X,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { MediaViewer } from "./media-viewer";
import type {
  CanvasAssetReference,
  CanvasNode,
  Capability,
  KernelNodeOutput,
  InstalledPackage,
  MediaPluginType,
  ModelInputAssetKind,
  ModelInputConstraints,
  ModelConnection,
  NodeInputAssetReference,
  NodeStatus,
  PortDataType,
  PluginAssetContext,
  PluginTextContext,
} from "../types";
import { SUPPORTED_FILE_ACCEPT } from "../lib/file-formats";
import { portColor, portsForNode } from "../lib/node-ports";
import { roleForNode } from "../lib/node-role";
import {
  customWidthForNode,
  mediaFitWidthForNode,
  executionSizeForKind,
  heightForNode,
  MAX_NODE_HEIGHT,
  MAX_NODE_WIDTH,
  minHeightForNode,
  minWidthForNode,
  TEXT_RESULT_NODE_HEIGHT,
  TEXT_RESULT_NODE_WIDTH,
} from "../lib/node-layout";
import {
  modelMatchesCapability,
  nodeCapabilitySnapshot,
  preferredModel,
  snapshotCapability,
} from "../lib/capability-sync";
import { IconButton } from "./icon-button";
import { AssetContentPreview } from "./asset-content-preview";
import { AudioPlayer } from "./audio-player";
import { AssetPluginMenu } from "./asset-plugin-menu";
import { VideoPlayer } from "./video-player";
import { SelectMenu } from "./select-menu";
import { SchemaFields } from "./schema-fields";
import { SchemaOutput } from "./schema-output";
import type { PluginRuntimeMode } from "./plugin-runtime-dialog";
import {
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../lib/model-input-constraints";
import { launchPluginRuntime } from "../lib/plugin-runtime-client";
import { pluginAssetContextsFromReferences } from "../lib/plugin-reference-context";
import { syncPluginReferenceFrame } from "../lib/plugin-reference-bridge";

const statusMeta: Record<
  NodeStatus,
  { label: string; icon: typeof Check }
> = {
  draft: { label: "草稿", icon: FileText },
  waiting: { label: "待确认", icon: AlertCircle },
  queued: { label: "排队中", icon: Clock3 },
  running: { label: "执行中", icon: Play },
  paused: { label: "已暂停", icon: Pause },
  succeeded: { label: "已完成", icon: Check },
  failed: { label: "失败", icon: AlertCircle },
  canceled: { label: "已取消", icon: XCircle },
  skipped: { label: "已跳过", icon: GitBranch },
};

const kindMeta = {
  text: { label: "文本", icon: FileText },
  image: { label: "图像", icon: ImageIcon },
  video: { label: "视频", icon: Video },
  audio: { label: "音频", icon: AudioLines },
  document: { label: "文档", icon: FileOutput },
};

const resultPlaceholderLabels: Record<CanvasNode["kind"], string> = {
  text: "文本占位卡片",
  image: "图片占位卡片",
  video: "视频占位卡片",
  audio: "音频占位卡片",
  document: "文档占位卡片",
};

const defaultNodePrompts = new Set([
  "选择已安装的 Skill 与模型，并描述这个节点需要完成的任务。",
  "在这里描述这个节点需要完成的任务。",
]);

const NODE_DRAG_THRESHOLD_PX = 8;

function isDefaultNodePrompt(prompt: string) {
  return defaultNodePrompts.has(prompt.trim());
}

function inlineTextResult(node: CanvasNode) {
  const kernelOutput = node.parameters?.kernelOutput as
    | KernelNodeOutput
    | undefined;

  if (kernelOutput?.text?.trim()) return kernelOutput.text;
  if (node.result?.trim()) return node.result;
  if (kernelOutput?.data === undefined || kernelOutput.data === null) return "";
  if (typeof kernelOutput.data === "string") return kernelOutput.data;

  try {
    return JSON.stringify(kernelOutput.data, null, 2);
  } catch {
    return String(kernelOutput.data);
  }
}

function textDownloadName(title: string) {
  const safeTitle = title
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[.\s]+$/g, "");
  return `${safeTitle || "文本结果"}.txt`;
}

interface NodeCardProps {
  node: CanvasNode;
  canvasId: string;
  workspaceId: string;
  selected: boolean;
  multiSelected: boolean;
  zoom: number;
  panMode: boolean;
  capabilities: Capability[];
  models: ModelConnection[];
  canvasAssets: CanvasAssetReference[];
  inputAssets: NodeInputAssetReference[];
  inputTextContexts: PluginTextContext[];
  mediaPlugins: InstalledPackage[];
  pluginRuntimeUrl?: string | null;
  onSelect: (additive?: boolean) => void;
  onMoveStart: () => void;
  onMovePreview: (x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onUpdate: (patch: Partial<CanvasNode>) => void;
  onSizeChange: (nodeId: string, height: number) => void;
  onConnectionStart: (
    portId: string,
    dataType: PortDataType,
    clientX: number,
    clientY: number,
  ) => void;
  onAttachInputAsset: (sourceNodeId: string) => void;
  onRemoveInputAsset: (edgeId: string) => void;
  onUploadInputAssets: (files: File[]) => Promise<void>;
  connectionDataType?: PortDataType;
  onRun: () => void;
  onRerunBranch: () => void;
  onDelete: () => void;
  onOpenPlugin: (mode?: PluginRuntimeMode) => void;
  onOpenMediaPlugin: (plugin: InstalledPackage) => void;
}

const inputAssetMeta: Record<
  ModelInputAssetKind,
  { icon: typeof ImageIcon }
> = {
  image: { icon: ImageIcon },
  video: { icon: Video },
  audio: { icon: AudioLines },
  document: { icon: FileOutput },
};

export function InputAssetPreview({ asset }: { asset: CanvasAssetReference }) {
  const AssetIcon = inputAssetMeta[asset.kind].icon;
  return (
    <div className="node-input-asset-preview" aria-hidden="true">
      {asset.kind === "image" && asset.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.url} alt="" draggable={false} loading="lazy" decoding="async" />
      ) : asset.kind === "video" && asset.url ? (
        <video src={`${asset.url}#t=0.1`} muted playsInline preload="metadata" />
      ) : (
        <AssetIcon size={17} />
      )}
    </div>
  );
}

interface ActiveAssetMention {
  start: number;
  end: number;
  query: string;
}

type PromptSegment =
  | { type: "text"; value: string }
  | {
      type: "asset";
      asset: CanvasAssetReference;
      token: string;
    };

function segmentPrompt(
  value: string,
  assets: CanvasAssetReference[],
): PromptSegment[] {
  const tokens = assets
    .filter((asset) => asset.title.trim())
    .map((asset) => ({ asset, token: `@${asset.title}` }))
    .sort((left, right) => right.token.length - left.token.length);
  const segments: PromptSegment[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    let nextMatch:
      | { index: number; asset: CanvasAssetReference; token: string }
      | undefined;

    for (const candidate of tokens) {
      const index = value.indexOf(candidate.token, cursor);
      if (
        index >= 0 &&
        (!nextMatch ||
          index < nextMatch.index ||
          (index === nextMatch.index &&
            candidate.token.length > nextMatch.token.length))
      ) {
        nextMatch = { index, ...candidate };
      }
    }

    if (!nextMatch) {
      segments.push({ type: "text", value: value.slice(cursor) });
      break;
    }
    if (nextMatch.index > cursor) {
      segments.push({
        type: "text",
        value: value.slice(cursor, nextMatch.index),
      });
    }
    segments.push({
      type: "asset",
      asset: nextMatch.asset,
      token: nextMatch.token,
    });
    cursor = nextMatch.index + nextMatch.token.length;
  }

  return segments.length ? segments : [{ type: "text", value: "" }];
}

function appendPromptAssetPreview(
  container: HTMLElement,
  asset: CanvasAssetReference,
) {
  const preview = document.createElement("span");
  preview.className = "node-input-asset-preview";
  preview.setAttribute("aria-hidden", "true");

  if (asset.kind === "image" && asset.url) {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = "";
    image.draggable = false;
    preview.append(image);
  } else if (asset.kind === "video" && asset.url) {
    const video = document.createElement("video");
    video.src = asset.url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    preview.append(video);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "node-prompt-asset-fallback";
    fallback.textContent =
      asset.kind === "audio" ? "A" : asset.kind === "document" ? "D" : "M";
    preview.append(fallback);
  }
  container.append(preview);
}

function renderPromptEditorContent(
  editor: HTMLElement,
  value: string,
  assets: CanvasAssetReference[],
) {
  const fragment = document.createDocumentFragment();
  for (const segment of segmentPrompt(value, assets)) {
    if (segment.type === "text") {
      fragment.append(document.createTextNode(segment.value));
      continue;
    }

    const mention = document.createElement("span");
    mention.className = "node-prompt-mention";
    mention.contentEditable = "false";
    mention.dataset.assetMentionToken = segment.token;
    mention.title = segment.asset.title;
    appendPromptAssetPreview(mention, segment.asset);

    const prefix = document.createElement("span");
    prefix.className = "node-prompt-mention-prefix";
    prefix.setAttribute("aria-hidden", "true");
    prefix.textContent = "@";
    mention.append(prefix);

    const title = document.createElement("span");
    title.textContent = segment.asset.title;
    mention.append(title);
    fragment.append(mention);
  }
  editor.replaceChildren(fragment);
}

function promptValueFromDom(root: ParentNode): string {
  let value = "";
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3) {
      value += node.textContent ?? "";
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const mentionToken = node.dataset.assetMentionToken;
    if (mentionToken) {
      value += mentionToken;
      continue;
    }
    if (node.tagName === "BR") {
      value += "\n";
      continue;
    }
    if (
      (node.tagName === "DIV" || node.tagName === "P") &&
      value &&
      !value.endsWith("\n")
    ) {
      value += "\n";
    }
    value += promptValueFromDom(node);
  }
  return value;
}

function promptCaretOffset(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return promptValueFromDom(editor).length;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.endContainer)) {
    return promptValueFromDom(editor).length;
  }
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.endContainer, range.endOffset);
  const fragment = document.createElement("div");
  fragment.append(prefix.cloneContents());
  return promptValueFromDom(fragment).length;
}

function setPromptCaretOffset(editor: HTMLElement, requestedOffset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const offset = Math.max(0, requestedOffset);
  let consumed = 0;
  let placed = false;

  function visit(parent: ParentNode) {
    for (const node of Array.from(parent.childNodes)) {
      if (placed) return;
      if (node.nodeType === 3) {
        const length = node.textContent?.length ?? 0;
        if (offset <= consumed + length) {
          range.setStart(node, Math.max(0, offset - consumed));
          placed = true;
          return;
        }
        consumed += length;
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      const mentionToken = node.dataset.assetMentionToken;
      if (mentionToken) {
        consumed += mentionToken.length;
        if (offset <= consumed) {
          range.setStartAfter(node);
          placed = true;
          return;
        }
        continue;
      }
      if (node.tagName === "BR") {
        consumed += 1;
        if (offset <= consumed) {
          range.setStartAfter(node);
          placed = true;
          return;
        }
        continue;
      }
      visit(node);
    }
  }

  visit(editor);
  if (!placed) range.setStart(editor, editor.childNodes.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPromptText(editor: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function activeAssetMention(value: string, caret: number) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match) return null;
  const start = beforeCaret.lastIndexOf("@");
  return {
    start,
    end: caret,
    query: match[1] ?? "",
  } satisfies ActiveAssetMention;
}

function activeSlashSkill(value: string, caret: number) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/u);
  if (!match) return null;
  const start = beforeCaret.lastIndexOf("/");
  return {
    start,
    end: caret,
    query: match[1] ?? "",
  };
}

export function NodePromptEditor({
  value,
  assets,
  attachedSourceIds,
  onChange,
  onAttach,
  onExpand,
  onSubmitShortcut,
  onPasteFiles,
  slashSkills,
  ariaLabel = "节点任务描述",
  placeholder,
  autoFocus = false,
}: {
  value: string;
  assets: CanvasAssetReference[];
  attachedSourceIds: Set<string>;
  onChange: (value: string) => void;
  onAttach: (sourceNodeId: string) => void;
  onExpand?: () => void;
  onSubmitShortcut?: () => void;
  /** 粘贴文件（图片/视频/音频/任意文件）→ 转交宿主以附件上传 */
  onPasteFiles?: (files: File[]) => void;
  /** 斜杠技能引用：编辑器内输入 / 弹出技能补全菜单（对话 brain 模式由宿主注入技能目录） */
  slashSkills?: { name: string; description: string }[];
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [mention, setMention] = useState<ActiveAssetMention | null>(null);
  const [slash, setSlash] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const query = mention?.query.trim().toLocaleLowerCase() ?? "";
  const queryMatches = (asset: CanvasAssetReference) =>
    asset.title.toLocaleLowerCase().includes(query);
  const matchingAttachedAssets = assets.filter(
    (asset) => attachedSourceIds.has(asset.sourceNodeId) && queryMatches(asset),
  );
  const matchingCanvasAssets = assets.filter(
    (asset) => !attachedSourceIds.has(asset.sourceNodeId) && queryMatches(asset),
  );
  const matchingAssets = [
    ...matchingAttachedAssets,
    ...matchingCanvasAssets,
  ];
  const slashQuery = slash?.query.trim().toLocaleLowerCase() ?? "";
  const matchingSkills = (slashSkills ?? []).filter(
    (skill) =>
      !slashQuery ||
      skill.name.toLocaleLowerCase().includes(slashQuery) ||
      skill.description.toLocaleLowerCase().includes(slashQuery),
  );
  useLayoutEffect(() => {
    const editor = editorRef.current;
    const pendingCaret = pendingCaretRef.current;
    if (editor && promptValueFromDom(editor) !== value) {
      renderPromptEditorContent(editor, value, assets);
    }
    if (
      editor &&
      pendingCaret !== null &&
      document.activeElement === editor
    ) {
      setPromptCaretOffset(editor, pendingCaret);
    }
    pendingCaretRef.current = null;
  }, [assets, value]);

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  function refreshMention(nextValue: string, caret: number) {
    setMention(activeAssetMention(nextValue, caret));
    setActiveIndex(0);
    setSlash(slashSkills?.length ? activeSlashSkill(nextValue, caret) : null);
    setSlashIndex(0);
  }

  function chooseAsset(asset: CanvasAssetReference) {
    if (!mention) return;
    const inserted = `@${asset.title} `;
    const nextValue =
      value.slice(0, mention.start) + inserted + value.slice(mention.end);
    const nextCaret = mention.start + inserted.length;
    pendingCaretRef.current = nextCaret;
    onChange(nextValue);
    if (!attachedSourceIds.has(asset.sourceNodeId)) {
      onAttach(asset.sourceNodeId);
    }
    setMention(null);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      if (editorRef.current) setPromptCaretOffset(editorRef.current, nextCaret);
    });
  }

  function chooseSkill(skill: { name: string; description: string }) {
    if (!slash) return;
    const inserted = `/${skill.name} `;
    const nextValue =
      value.slice(0, slash.start) + inserted + value.slice(slash.end);
    const nextCaret = slash.start + inserted.length;
    pendingCaretRef.current = nextCaret;
    onChange(nextValue);
    setSlash(null);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      if (editorRef.current) setPromptCaretOffset(editorRef.current, nextCaret);
    });
  }

  function syncEditorValue(editor: HTMLDivElement) {
    const nextValue = promptValueFromDom(editor);
    const nextCaret = promptCaretOffset(editor);
    pendingCaretRef.current = nextCaret;
    onChange(nextValue);
    refreshMention(nextValue, nextCaret);
  }

  return (
    <div className="node-prompt-editor">
      <div
        ref={editorRef}
        className="node-prompt-input node-prompt-rich-input"
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        data-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        onFocus={(event) => {
          if (isDefaultNodePrompt(value)) {
            pendingCaretRef.current = 0;
            onChange("");
            refreshMention("", 0);
            return;
          }
          refreshMention(value, promptCaretOffset(event.currentTarget));
        }}
        onInput={(event) => syncEditorValue(event.currentTarget)}
        onClick={(event) => {
          const caret = promptCaretOffset(event.currentTarget);
          refreshMention(promptValueFromDom(event.currentTarget), caret);
        }}
        onDoubleClick={(event) => {
          if (!onExpand) return;
          event.preventDefault();
          event.stopPropagation();
          setMention(null);
          onExpand();
        }}
        onPaste={(event) => {
          // 粘贴文件（图片/视频/音频/任意文件）→ 以附件形式上传，不作为文本插入
          const pastedFiles = Array.from(event.clipboardData?.files ?? []);
          if (pastedFiles.length && onPasteFiles) {
            event.preventDefault();
            onPasteFiles(pastedFiles);
            return;
          }
          event.preventDefault();
          insertPromptText(
            event.currentTarget,
            event.clipboardData.getData("text/plain"),
          );
          syncEditorValue(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            onSubmitShortcut
          ) {
            event.preventDefault();
            onSubmitShortcut();
            return;
          }
          if (mention) {
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
            if (
              matchingAssets.length &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((current) =>
                (current + direction + matchingAssets.length) %
                matchingAssets.length,
              );
              return;
            }
            if (matchingAssets.length && event.key === "Enter") {
              event.preventDefault();
              chooseAsset(matchingAssets[activeIndex] ?? matchingAssets[0]);
              return;
            }
          }
          if (slash) {
            if (event.key === "Escape") {
              event.preventDefault();
              setSlash(null);
              return;
            }
            if (
              matchingSkills.length &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setSlashIndex((current) =>
                (current + direction + matchingSkills.length) %
                matchingSkills.length,
              );
              return;
            }
            if (
              matchingSkills.length &&
              (event.key === "Enter" || event.key === "Tab")
            ) {
              event.preventDefault();
              chooseSkill(matchingSkills[slashIndex] ?? matchingSkills[0]);
              return;
            }
          }
          if (event.key === "Enter") {
            event.preventDefault();
            insertPromptText(event.currentTarget, "\n");
            syncEditorValue(event.currentTarget);
          }
        }}
        onBlur={() => {
          setMention(null);
          setSlash(null);
        }}
      >
      </div>

      {mention && (
        <div className="node-asset-mention-menu" role="listbox" aria-label="引用画布素材">
          {matchingAssets.length ? (
            <>
              <section className="node-asset-mention-group" aria-label="已连接素材">
                <strong>已连接素材</strong>
                {matchingAttachedAssets.length ? (
                  matchingAttachedAssets.map((asset, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={index === activeIndex ? "is-active" : ""}
                      key={asset.sourceNodeId}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={() => chooseAsset(asset)}
                    >
                      <InputAssetPreview asset={asset} />
                      <span>{asset.title}</span>
                    </button>
                  ))
                ) : (
                  <p>暂无已连接素材</p>
                )}
              </section>

              <section className="node-asset-mention-group" aria-label="画布素材">
                <strong>画布素材</strong>
                {matchingCanvasAssets.length ? (
                  matchingCanvasAssets.map((asset, index) => {
                    const optionIndex = matchingAttachedAssets.length + index;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={optionIndex === activeIndex}
                        className={optionIndex === activeIndex ? "is-active" : ""}
                        key={asset.sourceNodeId}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={() => chooseAsset(asset)}
                      >
                        <InputAssetPreview asset={asset} />
                        <span>{asset.title}</span>
                      </button>
                    );
                  })
                ) : (
                  <p>暂无其他画布素材</p>
                )}
              </section>
            </>
          ) : (
            <p>暂无匹配素材</p>
          )}
        </div>
      )}

      {slash && (
        <div className="node-asset-mention-menu" role="listbox" aria-label="引用技能">
          <section className="node-asset-mention-group" aria-label="工作区技能">
            <strong>技能（回车选用）</strong>
            {matchingSkills.length ? (
              matchingSkills.slice(0, 8).map((skill, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === slashIndex}
                  className={index === slashIndex ? "is-active" : ""}
                  key={skill.name}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => chooseSkill(skill)}
                >
                  <span>{skill.name}</span>
                  <small style={{ color: "#9ca3af", marginLeft: 6 }}>
                    {skill.description}
                  </small>
                </button>
              ))
            ) : (
              <p>暂无匹配技能</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function PromptEditorDialog({
  nodeTitle,
  value,
  assets,
  attachedSourceIds,
  onAttach,
  onCancel,
  onSave,
}: {
  nodeTitle: string;
  value: string;
  assets: CanvasAssetReference[];
  attachedSourceIds: Set<string>;
  onAttach: (sourceNodeId: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    const canvasStage = document.querySelector<HTMLElement>(".canvas-stage");
    if (!canvasStage) return;
    const wasInert = canvasStage.hasAttribute("inert");
    canvasStage.setAttribute("inert", "");
    return () => {
      if (!wasInert) canvasStage.removeAttribute("inert");
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        onSave(draft);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [draft, onCancel, onSave]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="prompt-editor-backdrop"
      role="presentation"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="prompt-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`编辑${nodeTitle}内容`}
      >
        <header>
          <div>
            <small>节点任务描述</small>
            <h2>{nodeTitle}</h2>
          </div>
          <button type="button" aria-label="关闭内容编辑器" onClick={onCancel}>
            <X size={20} />
          </button>
        </header>

        <NodePromptEditor
          value={draft}
          assets={assets}
          attachedSourceIds={attachedSourceIds}
          ariaLabel="放大编辑节点内容"
          autoFocus
          onChange={setDraft}
          onAttach={onAttach}
          onExpand={() => {}}
        />

        <footer>
          <span>{draft.length.toLocaleString()} 个字符</span>
          <div>
            <button type="button" className="secondary-button" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => onSave(draft)}
            >
              保存内容
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function NodeInputAssets({
  assets,
  constraints,
  onRemove,
  onUpload,
}: {
  assets: NodeInputAssetReference[];
  constraints: ModelInputConstraints;
  onRemove: (edgeId: string) => void;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const validation = validateModelInputAssets(constraints, assets);
  const visibleAssets = expanded ? assets : assets.slice(0, 12);
  const hiddenCount = Math.max(0, assets.length - visibleAssets.length);
  const canUpload = constraints.maxTotal > 0 && assets.length < constraints.maxTotal;

  return (
    <section
      className={`node-input-assets ${validation.valid ? "" : "has-error"}`}
      aria-label="输入素材"
    >
      <div className="node-input-assets-heading">
        <strong>输入素材</strong>
        <span>
          {validation.total} / {constraints.maxTotal}
        </span>
      </div>

      {constraints.maxTotal <= 0 ? (
        <p className="node-input-assets-empty">
          当前模型未开放参考素材
        </p>
      ) : (
        <div className="node-input-asset-grid">
          {visibleAssets.map((asset) => {
            return (
              <article
                key={asset.edgeId}
                className="node-input-asset-card"
                data-kind={asset.kind}
                aria-label={asset.title}
              >
                <InputAssetPreview asset={asset} />
                <button
                  type="button"
                  aria-label={`移除${asset.title}`}
                  title="断开这个素材"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(asset.edgeId);
                  }}
                >
                  <X size={13} />
                </button>
              </article>
            );
          })}

          <label
            className={`node-input-asset-upload ${canUpload ? "" : "is-disabled"}`}
            aria-label={canUpload ? "上传并连接素材" : "输入素材数量已达上限"}
            title={canUpload ? "上传并连接素材" : "输入素材数量已达上限"}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {uploading ? <LoaderCircle size={18} className="spin" /> : <Plus size={20} />}
            <input
              type="file"
              multiple
              accept={SUPPORTED_FILE_ACCEPT}
              disabled={!canUpload || uploading}
              onChange={(event) => {
                const input = event.currentTarget;
                const files = Array.from(input.files ?? []);
                input.value = "";
                if (!files.length) return;
                setUploading(true);
                void onUpload(files).finally(() => setUploading(false));
              }}
            />
          </label>
        </div>
      )}

      {(hiddenCount > 0 || expanded) && assets.length > 12 && (
        <button
          type="button"
          className="node-input-assets-expand"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "收起素材" : `展开其余 ${hiddenCount} 个`}
        </button>
      )}

      {!validation.valid && (
        <div className="node-input-assets-errors" role="alert">
          {validation.errors.map((error) => (
            <span key={error}>{error}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function audioTagString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// 尽力从模型参数或内核输出数据中提取音乐节点的风格标签（tags），
// 供音频播放器信息头展示胶囊；不存在时返回 undefined
function findAudioTags(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  const direct = audioTagString(record.tags);
  if (direct) return direct;
  for (const key of ["value", "data", "parameters", "modelParameters"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findAudioTags(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findAudioTags(nested, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

interface NodeWorkbenchProps {
  node: CanvasNode;
}

function NodeWorkbench({ node }: NodeWorkbenchProps) {
  const parameters = node.parameters ?? {};
  const kernelOutput =
    parameters.kernelOutput &&
    typeof parameters.kernelOutput === "object"
      ? (parameters.kernelOutput as KernelNodeOutput)
      : null;
  const assetContentUrl =
    typeof parameters.assetContentUrl === "string"
      ? parameters.assetContentUrl
      : undefined;
  const mediaUrl = kernelOutput?.assetUrl ?? assetContentUrl;
  const assetFileName =
    typeof parameters.fileName === "string"
      ? parameters.fileName
      : node.title;
  const assetMimeType =
    typeof parameters.mimeType === "string"
      ? parameters.mimeType
      : "application/octet-stream";
  const assetDownloadUrl =
    typeof parameters.assetDownloadUrl === "string"
      ? parameters.assetDownloadUrl
      : undefined;
  const isAssetReference =
    parameters.source === "asset-kernel" && Boolean(assetContentUrl);
  const audioTags =
    node.kind === "audio"
      ? findAudioTags(parameters.modelParameters) ??
        findAudioTags(kernelOutput?.data)
      : undefined;

  return (
    <section className={`node-workbench workbench-${node.kind}`}>
      <div className={`workbench-preview schema-driven-preview preview-${node.kind}`}>
        {node.kind === "text" && isAssetReference && mediaUrl && (
          <AssetContentPreview
            name={assetFileName}
            kind="text"
            mimeType={assetMimeType}
            contentUrl={mediaUrl}
            downloadUrl={assetDownloadUrl}
          />
        )}
        {node.kind === "text" && !isAssetReference && (
          <p>{kernelOutput?.text ?? node.result ?? "暂无输出"}</p>
        )}
        {node.kind === "image" && mediaUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt={`${node.title} 生成结果`}
            draggable={false}
            loading="lazy"
            decoding="async"
          />
        )}
        {node.kind === "video" && mediaUrl && (
          // #t=0.1 让浏览器加载第一帧作为缩略图，避免预览一片漆黑
          <VideoPlayer src={`${mediaUrl}#t=0.1`} title={node.title} />
        )}
        {node.kind === "audio" && mediaUrl && (
          <AudioPlayer src={mediaUrl} title={node.title} tags={audioTags} />
        )}
        {node.kind === "document" && isAssetReference && mediaUrl && (
          <AssetContentPreview
            name={assetFileName}
            kind="document"
            mimeType={assetMimeType}
            contentUrl={mediaUrl}
            downloadUrl={assetDownloadUrl}
          />
        )}
        {node.kind === "document" && !isAssetReference && (
          <><FileOutput size={22} /><span>{mediaUrl ? "文档已生成" : "暂无输出"}</span></>
        )}
        {!mediaUrl && !["text", "document"].includes(node.kind) && (
          <div className="media-preview-art" aria-label="暂无输出"><span /><span /><span /></div>
        )}
      </div>
    </section>
  );
}

export function NodeCard({
  node,
  canvasId,
  workspaceId,
  selected,
  multiSelected,
  zoom,
  panMode,
  capabilities,
  models,
  canvasAssets = [],
  inputAssets = [],
  inputTextContexts = [],
  mediaPlugins = [],
  pluginRuntimeUrl: currentPluginRuntimeUrl,
  onSelect,
  onMoveStart,
  onMovePreview,
  onMove,
  onUpdate,
  onSizeChange,
  onConnectionStart,
  onAttachInputAsset,
  onRemoveInputAsset,
  onUploadInputAssets,
  connectionDataType,
  onRun,
  onRerunBranch,
  onDelete,
  onOpenPlugin,
  onOpenMediaPlugin,
}: NodeCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const pluginPreviewFrameRef = useRef<HTMLIFrameElement>(null);
  const pluginPreviewHostRef = useRef<HTMLDivElement>(null);
  const pluginAssetContextsRef = useRef<PluginAssetContext[]>([]);
  const pluginTextContextsRef = useRef<PluginTextContext[]>([]);
  const pluginAssetContexts = useMemo(
    () => pluginAssetContextsFromReferences(canvasId, inputAssets),
    [canvasId, inputAssets],
  );
  const notifyPluginPreviewHost = useCallback(
    (frame: HTMLIFrameElement | null) => {
      syncPluginReferenceFrame(
        frame,
        pluginAssetContextsRef.current,
        pluginTextContextsRef.current,
      );
    },
    [],
  );
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
    checkpointed: boolean;
    captured: boolean;
    captureTarget: HTMLElement | null;
  } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const latestMove = useRef<{ x: number; y: number } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const pendingResize = useRef<{ width: number; height: number } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const finishNodeDrag = useCallback(
    (pointerId?: number) => {
      const current = drag.current;
      if (!current || (pointerId !== undefined && current.pointerId !== pointerId)) {
        return;
      }
      dragCleanup.current?.();
      dragCleanup.current = null;
      if (moveFrame.current !== null) {
        cancelAnimationFrame(moveFrame.current);
        moveFrame.current = null;
      }
      const finalMove = latestMove.current;
      pendingMove.current = null;
      latestMove.current = null;
      if (finalMove) {
        const card = cardRef.current;
        if (card) {
          card.style.transform = "";
          card.style.left = `${finalMove.x}px`;
          card.style.top = `${finalMove.y}px`;
          card.classList.remove("is-dragging");
        }
        onMove(finalMove.x, finalMove.y);
      } else {
        cardRef.current?.classList.remove("is-dragging");
      }
      if (
        current.captureTarget?.hasPointerCapture(current.pointerId)
      ) {
        try {
          current.captureTarget.releasePointerCapture(current.pointerId);
        } catch {
          // The browser may already have released capture after blur/cancel.
        }
      }
      drag.current = null;
    },
    [onMove],
  );
  const copyFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [downloadState, setDownloadState] = useState<
    "idle" | "downloaded" | "failed"
  >("idle");
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const status = statusMeta[node.status];
  const failureNotice =
    node.status === "failed" || node.status === "skipped"
      ? (node.result ?? "").replace(/^执行失败：/, "").trim()
      : "";
  const ResultPlaceholderIcon = kindMeta[node.kind].icon;
  const StatusIcon = status.icon;
  const role = roleForNode(node);
  const modalityCapabilities = capabilities.filter(
    (capability) =>
      capability.enabled &&
      capability.category === "SKILL" &&
      capability.modality === node.kind,
  );
  const packageCapabilities = modalityCapabilities.filter(
    (capability) => capability.packageId,
  );
  const activeCapability =
    role === "execution"
      ? capabilities.find(
          (capability) =>
            capability.id === node.capabilityId &&
            capability.category === "SKILL",
        )
      : undefined;
  const hasNoCapability = node.capabilityId === "none";
  const compatibleCapabilities = packageCapabilities.length
    ? [
        ...(activeCapability &&
        !packageCapabilities.some((item) => item.id === activeCapability.id)
          ? [activeCapability]
          : []),
        ...packageCapabilities,
      ]
    : modalityCapabilities;
  const capabilityContract = hasNoCapability
    ? null
    : role === "plugin"
      ? nodeCapabilitySnapshot(node)
      : activeCapability ?? nodeCapabilitySnapshot(node);
  const compatibleModels = models.filter((model) =>
    modelMatchesCapability(model, capabilityContract, node.kind),
  );
  const selectedModel =
    compatibleModels.find((model) => model.id === node.modelId) ??
    preferredModel(models, capabilityContract, node.kind);
  const selectedModelId =
    capabilityContract?.executionMode === "remote"
      ? "skill-runtime"
      : (selectedModel?.id ?? "unconfigured");
  const inputConstraints = normalizeModelInputConstraints(
    selectedModel?.inputConstraints,
    node.kind,
    selectedModel?.protocol,
  );
  const inputAssetValidation = validateModelInputAssets(
    inputConstraints,
    inputAssets,
  );
  const outputSchema = capabilityContract?.outputSchema;
  const kernelOutput = node.parameters?.kernelOutput as
    | KernelNodeOutput
    | undefined;
  const hasResultOutput =
    Boolean(node.result?.trim()) ||
    Boolean(kernelOutput?.assetUrl) ||
    Boolean(kernelOutput?.text?.trim()) ||
    kernelOutput?.data !== undefined;
  const hasMediaAssetOutput =
    Boolean(kernelOutput?.assetUrl) ||
    (typeof node.parameters?.assetContentUrl === "string" &&
      Boolean(node.parameters.assetContentUrl.trim()));
  const mediaSourceUrl =
    (typeof kernelOutput?.assetUrl === "string" && kernelOutput.assetUrl) ||
    (typeof node.parameters?.assetContentUrl === "string" &&
      node.parameters.assetContentUrl) ||
    "";
  const mediaDownloadName = (() => {
    const fallbackLabel =
      node.kind === "video"
        ? "视频"
        : node.kind === "audio"
          ? "音频"
          : "图片";
    const fallbackExtension =
      node.kind === "video" ? "mp4" : node.kind === "audio" ? "mp3" : "png";
    const base = (node.title || fallbackLabel).replace(/[\\/:*?"<>|]/g, "_").trim() || fallbackLabel;
    const extension = (mediaSourceUrl.split(".").pop() ?? "").split("?")[0];
    return /^[a-z0-9]{1,10}$/i.test(extension)
      ? `${base}.${extension.toLowerCase()}`
      : `${base}.${fallbackExtension}`;
  })();
  const isEmptyResultPlaceholder = role === "result" && !hasResultOutput;
  const isSizedTextResult =
    role === "result" && node.kind === "text" && hasResultOutput;
  const hasTextResultActions =
    selected && role === "result" && node.kind === "text" && hasResultOutput;
  const hasMediaActions =
    selected && (node.kind === "image" || node.kind === "video") && hasMediaAssetOutput;
  const hasAudioActions =
    selected && node.kind === "audio" && hasMediaAssetOutput;
  const isExecutionNode = role === "execution";
  const hasResultTextSurface =
    role === "result" &&
    hasResultOutput &&
    (node.kind === "text" ||
      ((node.kind === "image" || node.kind === "video") &&
        Boolean(node.result?.trim()) &&
        !hasMediaAssetOutput));
  const hideSucceededResultStatus =
    role === "result" &&
    node.status === "succeeded" &&
    (node.kind === "text" ||
      node.kind === "image" ||
      node.kind === "video" ||
      node.kind === "audio");
  const isGeneratingResultPlaceholder =
    isEmptyResultPlaceholder &&
    (node.status === "queued" ||
      node.status === "running" ||
      (node.status === "waiting" &&
        typeof node.parameters?.kernelRunId === "string"));
  const inputPorts = portsForNode(node, "input");
  const outputPorts = portsForNode(node, "output");
  const [pluginPreview, setPluginPreview] = useState<{
    source: string;
    url: string;
  } | null>(null);
  const [pluginLaunching, setPluginLaunching] = useState(false);
  const [pluginLaunchError, setPluginLaunchError] = useState<string | null>(
    null,
  );
  const [pluginLaunchRevision, setPluginLaunchRevision] = useState(0);
  const pluginPackageId =
    typeof node.parameters?.packageId === "string"
      ? node.parameters.packageId
      : null;
  const pluginPackageKey =
    typeof node.parameters?.packageKey === "string"
      ? node.parameters.packageKey
      : null;
  const pluginRuntimeUrl =
    role === "plugin"
      ? currentPluginRuntimeUrl ??
        (typeof node.parameters?.runtimeUrl === "string"
          ? node.parameters.runtimeUrl
          : "")
      : "";
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setPluginPreview((current) =>
        current?.source === pluginRuntimeUrl ? current : null,
      );
      setPluginLaunchError(null);
    });

    if (!pluginRuntimeUrl) {
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setPluginLaunching(false);
        if (role === "plugin") {
          setPluginLaunchError("插件运行地址不可用，请重新安装或更新插件。");
        }
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const target = new URL(pluginRuntimeUrl, window.location.origin);
    if (!target.pathname.startsWith("/api/v2/packages/runtime/static/")) {
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setPluginPreview({ source: pluginRuntimeUrl, url: target.href });
          setPluginLaunching(false);
        }
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    void Promise.resolve().then(() => {
      if (!cancelled) setPluginLaunching(true);
    });
    void launchPluginRuntime(
      {
        url: target.href,
        workspaceId,
        packageId: pluginPackageId,
        packageKey: pluginPackageKey,
        packageName: node.title,
      },
      { signal: controller.signal },
    )
      .then((previewUrl) => {
        if (!cancelled) {
          setPluginPreview({ source: pluginRuntimeUrl, url: previewUrl });
          setPluginLaunchError(null);
        }
      })
      .catch((error) => {
        if (!cancelled && !controller.signal.aborted) {
          setPluginLaunchError(
            error instanceof Error ? error.message : "无法加载插件预览",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPluginLaunching(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    node.title,
    pluginPackageId,
    pluginPackageKey,
    pluginLaunchRevision,
    pluginRuntimeUrl,
    role,
    workspaceId,
  ]);

  useEffect(() => {
    const host = pluginPreviewHostRef.current;
    if (role !== "plugin" || !host) return;

    let frame: HTMLIFrameElement | null = null;
    const previewUrl =
      pluginPreview?.source === pluginRuntimeUrl ? pluginPreview.url : null;
    if (!frame && previewUrl) {
      const existing = pluginPreviewFrameRef.current;
      if (existing?.dataset.runtimeUrl === previewUrl) {
        frame = existing;
      } else {
        existing?.remove();
        const created = document.createElement("iframe");
        created.dataset.runtimeUrl = previewUrl;
        created.src = previewUrl;
        created.title = `${node.title} 画布插件`;
        created.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms allow-downloads",
        );
        created.setAttribute("referrerPolicy", "no-referrer");
        created.setAttribute(
          "allow",
          "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
        );
        created.tabIndex = 0;
        created.addEventListener("load", () => {
          notifyPluginPreviewHost(created);
        });
        frame = created;
      }
    }
    if (!frame) return;

    pluginPreviewFrameRef.current = frame;
    frame.style.cssText =
      "display:block;width:100%;height:100%;border:0;background:#fff;pointer-events:auto;";
    host.appendChild(frame);
    notifyPluginPreviewHost(frame);
    // 缩放跟随容器宽度：拖动调整卡片大小时，预览内容同步放大/缩小
    return () => {
      if (frame.parentNode === host) {
        frame.remove();
      }
      if (pluginPreviewFrameRef.current === frame) {
        pluginPreviewFrameRef.current = null;
      }
    };
  }, [
    node.title,
    notifyPluginPreviewHost,
    pluginPreview,
    pluginRuntimeUrl,
    role,
  ]);

  useEffect(() => {
    if (role !== "plugin") return;
    pluginAssetContextsRef.current = pluginAssetContexts;
    pluginTextContextsRef.current = inputTextContexts;
    notifyPluginPreviewHost(pluginPreviewFrameRef.current);
  }, [inputTextContexts, notifyPluginPreviewHost, pluginAssetContexts, role]);

  useEffect(() => {
    if (role !== "plugin") return;
    function handleMessage(event: MessageEvent) {
      if (event.source !== pluginPreviewFrameRef.current?.contentWindow) return;
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type === "xiaoluo:runtime-grant-expired") {
        setPluginPreview(null);
        setPluginLaunchRevision((current) => current + 1);
        return;
      }
      if (event.data.type === "xiaoluo:capability-request") {
        pluginPreviewFrameRef.current?.contentWindow?.postMessage(
          {
            type: "xiaoluo:capability-response",
            requestId: event.data.requestId,
            ok: false,
            error: "该插件能力尚未获得宿主授权。",
          },
          "*",
        );
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [role]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const reportSize = () => onSizeChange(node.id, card.offsetHeight);
    reportSize();
    const observer = new ResizeObserver(reportSize);
    observer.observe(card);
    return () => observer.disconnect();
  }, [node.id, onSizeChange]);

  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
      if (copyFeedbackTimer.current !== null) {
        clearTimeout(copyFeedbackTimer.current);
      }
      if (downloadFeedbackTimer.current !== null) {
        clearTimeout(downloadFeedbackTimer.current);
      }
      dragCleanup.current?.();
      dragCleanup.current = null;
      drag.current = null;
      pendingMove.current = null;
      latestMove.current = null;
      if (cardRef.current) {
        cardRef.current.style.transform = "";
        cardRef.current.classList.remove("is-dragging");
      }
      resizeCleanup.current?.();
    },
    [],
  );

  function resetResultActionFeedback(
    action: "copy" | "download",
    delay = 1600,
  ) {
    const timer = action === "copy" ? copyFeedbackTimer : downloadFeedbackTimer;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (action === "copy") setCopyState("idle");
      else setDownloadState("idle");
      timer.current = null;
    }, delay);
  }

  async function readTextResult() {
    const inlineResult = inlineTextResult(node);
    if (inlineResult) return inlineResult;

    const sourceUrl =
      typeof node.parameters?.assetContentUrl === "string"
        ? node.parameters.assetContentUrl
        : typeof kernelOutput?.assetUrl === "string"
          ? kernelOutput.assetUrl
          : "";
    if (!sourceUrl) return "";

    const response = await fetch(sourceUrl, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`读取文本结果失败（${response.status}）`);
    }
    return response.text();
  }

  function updateTextResult(content: string) {
    const nextKernelOutput: KernelNodeOutput = kernelOutput
      ? { ...kernelOutput, type: "text", text: content }
      : {
          type: "text",
          text: content,
          executor: "user-edit",
        };
    onUpdate({
      result: content,
      parameters: {
        ...node.parameters,
        kernelOutput: nextKernelOutput,
      },
    });
  }

  async function copyTextResult() {
    try {
      const content = await readTextResult();
      if (!content) throw new Error("没有可复制的文本内容");

      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(content);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("复制失败");
      }

      setCopyState("copied");
      resetResultActionFeedback("copy");
    } catch {
      setCopyState("failed");
      resetResultActionFeedback("copy", 2200);
    }
  }

  async function downloadTextResult() {
    try {
      const content = await readTextResult();
      if (!content) throw new Error("没有可下载的文本内容");

      const objectUrl = URL.createObjectURL(
        new Blob([content], { type: "text/plain;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = textDownloadName(node.title);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);

      setDownloadState("downloaded");
      resetResultActionFeedback("download");
    } catch {
      setDownloadState("failed");
      resetResultActionFeedback("download", 2200);
    }
  }

  async function copyMediaLink(url: string) {
    try {
      if (!url) throw new Error("没有可复制的链接");

      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(url);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("复制失败");
      }

      setCopyState("copied");
      resetResultActionFeedback("copy");
    } catch {
      setCopyState("failed");
      resetResultActionFeedback("copy", 2200);
    }
  }

  async function downloadMediaAsset(
    sourceUrl: string,
    downloadUrl?: string,
  ) {
    try {
      if (!sourceUrl) throw new Error("没有可下载的媒体");
      try {
        const response = await fetch(downloadUrl ?? sourceUrl, {
          credentials: "include",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = mediaDownloadName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      } catch {
        window.open(sourceUrl, "_blank", "noopener");
      }
      setDownloadState("downloaded");
      resetResultActionFeedback("download");
    } catch {
      setDownloadState("failed");
      resetResultActionFeedback("download", 2200);
    }
  }

  const customWidth = customWidthForNode(node);
  const mediaFitWidth = mediaFitWidthForNode(node);
  const customHeight = heightForNode(node);
  // 执行节点按类型使用独立最小尺寸：高度随内容自适应，选项再多也完整显示
  const executionSize = executionSizeForKind(node.kind);
  const nodeSizeStyle: CSSProperties = {
    width:
      customWidth ??
      mediaFitWidth ??
      (isExecutionNode
        ? executionSize.width
        : isSizedTextResult
          ? TEXT_RESULT_NODE_WIDTH
          : undefined),
    height: customHeight ?? (isSizedTextResult ? TEXT_RESULT_NODE_HEIGHT : undefined),
  };
  // 仅在需要时写入 minHeight，避免 undefined 覆盖结果占位卡片的 minHeight
  if (isExecutionNode && customHeight === undefined) {
    nodeSizeStyle.minHeight = executionSize.height;
  }
  const isUserSized = customWidth !== undefined || customHeight !== undefined;

  // 卡片固定宽度时 contain 会让竖图左右留白，连线球只贴卡片不贴内容。
  // 图片加载后按 contain 实测显示宽度回写 parameters.mediaFitWidth：
  // 卡片宽度与连线端点共用同一来源，连线球即贴住内容边缘。
  // ref 读最新值：依赖只留稳定基本量，避免 回写 parameters → 重订阅 → 观察即回调 的死循环
  const mediaFitStateRef = useRef({ node, onUpdate });
  mediaFitStateRef.current = { node, onUpdate };
  useEffect(() => {
    if (!(role === "result" || role === "material") || node.kind !== "image" || !mediaSourceUrl) return;
    if (customWidth !== undefined) return; // 手动调整过尺寸：尊重用户
    const card = cardRef.current;
    const img = card?.querySelector(".preview-image > img, .material-direct-preview > img");
    if (!(img instanceof HTMLImageElement)) return;
    const box = img.parentElement;
    if (!box) return;
    const commit = () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      const boxW = box.clientWidth || card?.clientWidth || 0;
      const boxH = box.clientHeight || card?.clientHeight || 0;
      if (!boxW || !boxH) return; // 离屏 content-visibility 跳过渲染：等下次尺寸回调
      const target = Math.round(Math.min(boxW, (boxH * img.naturalWidth) / img.naturalHeight));
      const latest = mediaFitStateRef.current;
      const current = mediaFitWidthForNode(latest.node);
      if (current !== undefined && Math.abs(current - target) < 2) return;
      latest.onUpdate({ parameters: { ...(latest.node.parameters ?? {}), mediaFitWidth: target } });
    };
    const observer = new ResizeObserver(() => commit());
    observer.observe(box);
    const onLoad = () => commit();
    img.addEventListener("load", onLoad);
    if (img.complete && img.naturalWidth) commit();
    return () => {
      observer.disconnect();
      img.removeEventListener("load", onLoad);
    };
  }, [role, node.kind, mediaSourceUrl, customWidth]);

  function commitResize() {
    if (!pendingResize.current) return;
    const next = pendingResize.current;
    pendingResize.current = null;
    onUpdate({
      parameters: {
        ...node.parameters,
        layoutWidth: next.width,
        layoutHeight: next.height,
      },
    });
  }

  function beginResize(event: React.PointerEvent<HTMLButtonElement>) {
    const card = cardRef.current;
    if (panMode || event.button !== 0 || !card) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(false);
    onMoveStart();
    resizeCleanup.current?.();
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: card.offsetWidth,
      startHeight: card.offsetHeight,
    };

    const applyResize = (clientX: number, clientY: number) => {
      const current = resize.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const scale = Math.max(zoom / 100, 0.01);
      const nextWidth = Math.round(
        Math.min(
          MAX_NODE_WIDTH,
          Math.max(
            minWidthForNode(node),
            current.startWidth + (clientX - current.startX) / scale,
          ),
        ),
      );
      // 插件卡片锁定预览画面比例（920:612），高度跟随宽度，内容等比填满
      const nextHeight =
        role === "plugin"
          ? Math.round(nextWidth * (612 / 920))
          : Math.round(
              Math.min(
                MAX_NODE_HEIGHT,
                Math.max(
                  minHeightForNode(node),
                  current.startHeight + (clientY - current.startY) / scale,
                ),
              ),
            );
      const next = { width: nextWidth, height: nextHeight };
      pendingResize.current = next;
      card.style.width = `${next.width}px`;
      card.style.height = `${next.height}px`;
    };

    const handleResizeMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      if (
        pointerEvent.pointerType !== "touch" &&
        (pointerEvent.buttons & 1) === 0
      ) {
        cancelResize();
        return;
      }
      pointerEvent.preventDefault();
      applyResize(pointerEvent.clientX, pointerEvent.clientY);
    };

    function cleanup() {
      window.removeEventListener("pointermove", handleResizeMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.body.classList.remove("is-resizing-node");
      resizeCleanup.current = null;
    }

    function cancelResize() {
      cleanup();
      resize.current = null;
      commitResize();
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") cancelResize();
    }

    function finishResize(pointerEvent: PointerEvent) {
      if (pointerEvent.pointerId !== event.pointerId) return;
      pointerEvent.preventDefault();
      applyResize(pointerEvent.clientX, pointerEvent.clientY);
      cleanup();
      resize.current = null;
      commitResize();
    }

    document.body.classList.add("is-resizing-node");
    resizeCleanup.current = cancelResize;
    window.addEventListener("pointermove", handleResizeMove, { passive: false });
    window.addEventListener("pointerup", finishResize, { passive: false });
    window.addEventListener("pointercancel", finishResize, { passive: false });
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!cardRef.current) return;
    const horizontal =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const vertical =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!horizontal && !vertical) return;

    event.preventDefault();
    event.stopPropagation();
    onSelect(false);
    onMoveStart();
    const step = event.shiftKey ? 100 : 20;
    const keyNextWidth = Math.round(
      Math.min(
        MAX_NODE_WIDTH,
        Math.max(
          minWidthForNode(node),
          cardRef.current.offsetWidth + horizontal * step,
        ),
      ),
    );
    pendingResize.current = {
      width: keyNextWidth,
      // 插件卡片锁定预览画面比例（920:612），高度跟随宽度
      height:
        role === "plugin"
          ? Math.round(keyNextWidth * (612 / 920))
          : Math.round(
              Math.min(
                MAX_NODE_HEIGHT,
                Math.max(
                  minHeightForNode(node),
                  cardRef.current.offsetHeight + vertical * step,
                ),
              ),
            ),
    };
    commitResize();
  }

  function renderResizeHandle() {
    return (
      <button
        type="button"
        className="node-resize-handle"
        aria-label="调整节点大小"
        title="拖动调整节点大小；方向键微调"
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      />
    );
  }

  function handlePointerDown(event: React.PointerEvent<HTMLElement>) {
    if (panMode || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "button, input, textarea, select, audio, a, [contenteditable='true']"
      )
    ) {
      // 提示词输入框内优先进行文字选中/复制，不触发卡片拖拽
      return;
    }
    const video = target.closest("video");
    if (video) {
      const rect = video.getBoundingClientRect();
      const controlHeight = Math.min(48, rect.height * 0.3);
      if (event.clientY >= rect.bottom - controlHeight) return;
    }
    finishNodeDrag();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
      checkpointed: false,
      captured: false,
      captureTarget: null,
    };
    onSelect(event.shiftKey || event.metaKey || event.ctrlKey);

    const finishFromWindow = (pointerEvent: PointerEvent) => {
      finishNodeDrag(pointerEvent.pointerId);
    };
    const finishAfterFocusLoss = () => finishNodeDrag();
    const finishAfterVisibilityLoss = () => {
      if (document.visibilityState !== "visible") finishNodeDrag();
    };
    const cleanup = () => {
      window.removeEventListener("pointerup", finishFromWindow, true);
      window.removeEventListener("pointercancel", finishFromWindow, true);
      window.removeEventListener("blur", finishAfterFocusLoss);
      document.removeEventListener(
        "visibilitychange",
        finishAfterVisibilityLoss,
      );
      if (dragCleanup.current === cleanup) dragCleanup.current = null;
    };
    dragCleanup.current = cleanup;
    window.addEventListener("pointerup", finishFromWindow, true);
    window.addEventListener("pointercancel", finishFromWindow, true);
    window.addEventListener("blur", finishAfterFocusLoss);
    document.addEventListener("visibilitychange", finishAfterVisibilityLoss);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - drag.current.startX,
      event.clientY - drag.current.startY,
    );
    if (distance < NODE_DRAG_THRESHOLD_PX) return;
    if (!drag.current.captured) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current.captured = true;
      drag.current.captureTarget = event.currentTarget;
    }
    if (!drag.current.checkpointed) {
      drag.current.checkpointed = true;
      onMoveStart();
      cardRef.current?.classList.add("is-dragging");
    }
    const scale = zoom / 100;
    const nextMove = {
      x: drag.current.nodeX + (event.clientX - drag.current.startX) / scale,
      y: drag.current.nodeY + (event.clientY - drag.current.startY) / scale,
    };
    pendingMove.current = nextMove;
    latestMove.current = nextMove;
    if (moveFrame.current === null) {
      moveFrame.current = requestAnimationFrame(() => {
        const next = pendingMove.current;
        const current = drag.current;
        const card = cardRef.current;
        if (next && current && card) {
          card.style.transform = `translate3d(${next.x - current.nodeX}px, ${next.y - current.nodeY}px, 0)`;
          onMovePreview(next.x, next.y);
        }
        pendingMove.current = null;
        moveFrame.current = null;
      });
    }
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    finishNodeDrag(event.pointerId);
  }

  if (role === "material") {
    const parameters = node.parameters ?? {};
    const assetContentUrl =
      typeof parameters.assetContentUrl === "string"
        ? parameters.assetContentUrl
        : undefined;
    const mediaUrl = kernelOutput?.assetUrl ?? assetContentUrl;
    const assetFileName =
      typeof parameters.fileName === "string"
        ? parameters.fileName
        : node.title;
    const assetMimeType =
      typeof parameters.mimeType === "string"
        ? parameters.mimeType
        : "application/octet-stream";
    const assetDownloadUrl =
      typeof parameters.assetDownloadUrl === "string"
        ? parameters.assetDownloadUrl
        : undefined;
    const MaterialIcon = kindMeta[node.kind].icon;

    return (
      <article
        ref={cardRef}
        data-node-id={node.id}
        className={`canvas-node material-direct-node material-kind-${node.kind} ${isUserSized ? "is-user-sized" : ""} ${selected ? "is-selected" : ""} ${multiSelected ? "is-multi-selected" : ""}`}
        style={{ left: node.x, top: node.y, zIndex: node.layer ?? 0, ...nodeSizeStyle }}
        title={assetFileName}
        aria-label={`${kindMeta[node.kind].label}素材：${assetFileName}`}
      >
        <div
          className="material-direct-preview"
          style={{ position: "relative" }}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          {mediaUrl ? (
            <>
              <AssetContentPreview
                name={assetFileName}
                kind={node.kind}
                mimeType={assetMimeType}
                contentUrl={mediaUrl}
                downloadUrl={assetDownloadUrl}
              />
              {node.kind === "video" && (
                <span
                  className="material-video-drag-surface"
                  style={{
                    position: "absolute",
                    inset: "0 0 32% 0",
                    zIndex: 1,
                    cursor: "grab",
                  }}
                  aria-hidden="true"
                />
              )}
            </>
          ) : (
            <div className="material-missing-preview" role="status">
              <MaterialIcon size={24} aria-hidden="true" />
              <span>尚未载入{kindMeta[node.kind].label}素材</span>
            </div>
          )}
        </div>

        {selected && mediaUrl && (node.kind === "image" || node.kind === "video" || node.kind === "audio") && (
          <nav
            className="result-action-nav"
            aria-label={node.kind === "video" ? "视频功能导航" : node.kind === "audio" ? "音频功能导航" : "图片功能导航"}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <AssetPluginMenu
              plugins={mediaPlugins}
              mediaKind={node.kind as MediaPluginType}
              onSelect={onOpenMediaPlugin}
            />
            {node.kind === "audio" ? (
              <button
                type="button"
                className={`result-text-action ${copyState === "copied" ? "is-success" : copyState === "failed" ? "is-error" : ""}`}
                aria-label={copyState === "copied" ? "音频链接已复制" : "复制音频链接"}
                title={copyState === "failed" ? "复制失败，请重试" : "复制音频链接"}
                onClick={(event) => {
                  event.stopPropagation();
                  void copyMediaLink(mediaUrl);
                }}
              >
                {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
                <span>
                  {copyState === "copied"
                    ? "已复制"
                    : copyState === "failed"
                      ? "复制失败"
                      : "复制"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="result-text-action"
                aria-label={node.kind === "video" ? "放大查看视频" : "放大查看图片"}
                title="放大查看"
                onClick={(event) => {
                  event.stopPropagation();
                  setViewerOpen(true);
                }}
              >
                <Maximize2 size={14} />
                <span>放大</span>
              </button>
            )}
            <button
              type="button"
              className={`result-text-action ${downloadState === "downloaded" ? "is-success" : downloadState === "failed" ? "is-error" : ""}`}
              aria-label={
                downloadState === "downloaded"
                  ? node.kind === "video"
                    ? "视频已下载"
                    : "图片已下载"
                  : node.kind === "video"
                    ? "下载视频"
                    : "下载图片"
              }
              title={downloadState === "failed" ? "下载失败，请重试" : node.kind === "video" ? "下载视频" : "下载图片"}
              onClick={(event) => {
                event.stopPropagation();
                void downloadMediaAsset(mediaUrl, assetDownloadUrl);
              }}
            >
              {downloadState === "downloaded" ? (
                <Check size={14} />
              ) : (
                <Download size={14} />
              )}
              <span>
                {downloadState === "downloaded"
                  ? "已下载"
                  : downloadState === "failed"
                    ? "下载失败"
                    : "下载"}
              </span>
            </button>
          </nav>
        )}

      {viewerOpen && mediaUrl ? (
        <MediaViewer
          url={mediaUrl}
          kind={node.kind === "video" ? "video" : "image"}
          title={`${node.title} 放大预览`}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}

        {renderResizeHandle()}

                {inputPorts.map((port, index) => {
          const compatible =
            Boolean(connectionDataType) &&
            port.dataTypes.includes(connectionDataType as PortDataType);
          const offset = (index - (inputPorts.length - 1) / 2) * 22;
          return (
            <button
              type="button"
              key={port.id}
              className={`port port-input ${compatible ? "is-available" : connectionDataType ? "is-incompatible" : ""}`}
              style={
                {
                  top: `calc(50% + ${offset}px)`,
                  "--port-color": portColor(port.dataTypes[0]),
                } as CSSProperties
              }
              data-node-id={node.id}
              data-port-id={port.id}
              data-port-types={port.dataTypes.join(",")}
              title={`${port.label} · 输入 ${port.dataTypes.join(" / ")}`}
              aria-label={`${port.label}输入端口`}
              onPointerDown={(event) => event.stopPropagation()}
            />
          );
        })}
{outputPorts.map((port, index) => {
          const offset = (index - (outputPorts.length - 1) / 2) * 22;
          return (
            <button
              type="button"
              key={port.id}
              className="port port-output"
              style={
                {
                  top: `calc(50% + ${offset}px)`,
                  "--port-color": portColor(port.dataTypes[0]),
                } as CSSProperties
              }
              data-node-id={node.id}
              data-port-id={port.id}
              title={`${port.label} · 输出 ${port.dataTypes.join(" / ")}`}
              aria-label={`${port.label}输出端口，输出${port.dataTypes.join("、")}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                onConnectionStart(
                  port.id,
                  port.dataTypes[0],
                  event.clientX,
                  event.clientY,
                );
              }}
            />
          );
        })}
      </article>
    );
  }

  if (role === "plugin") {
    const pluginName =
      typeof node.parameters?.pluginName === "string" &&
      node.parameters.pluginName.trim()
        ? node.parameters.pluginName.trim()
        : node.title;

    return (
      <article
        ref={cardRef}
        data-node-id={node.id}
        className={`canvas-node plugin-launcher-node ${isUserSized ? "is-user-sized" : ""} ${selected ? "is-selected" : ""} ${multiSelected ? "is-multi-selected" : ""}`}
        style={{ left: node.x, top: node.y, zIndex: node.layer ?? 0, ...nodeSizeStyle }}
        aria-label={`插件 ${pluginName}`}
      >
        <div
          className="plugin-canvas-toolbar"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          title="拖动插件卡片"
        >
          <span className="plugin-canvas-drag-label">
            <GripVertical size={16} aria-hidden="true" />
            <strong>{pluginName}</strong>
          </span>
          <div
            className="plugin-runtime-actions plugin-canvas-runtime-actions"
            aria-label="插件显示方式"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              title={`以小窗打开 ${pluginName}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(false);
                onOpenPlugin("window");
              }}
            >
              小窗
            </button>
            <button
              type="button"
              title={`全屏打开 ${pluginName}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(false);
                onOpenPlugin("fullscreen");
              }}
            >
              全屏
            </button>
            <button
              type="button"
              className="is-active"
              aria-current="page"
              title={`${pluginName} 当前显示在画布中`}
              onClick={(event) => event.stopPropagation()}
            >
              画布
            </button>
          </div>
        </div>

        <div className="plugin-launcher-surface">
          <div className="plugin-launcher-preview" ref={pluginPreviewHostRef}>
            {pluginPreview?.source !== pluginRuntimeUrl ? (
              pluginLaunchError ? (
                <div className="plugin-launcher-state is-error" role="alert">
                  <AlertCircle size={22} aria-hidden="true" />
                  <strong>插件加载失败</strong>
                  <span>{pluginLaunchError}</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPluginLaunchRevision((current) => current + 1);
                    }}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    重新加载
                  </button>
                </div>
              ) : (
                <div className="plugin-launcher-state is-loading" role="status">
                  <LoaderCircle size={22} aria-hidden="true" />
                  <span>
                    {pluginLaunching ? "正在连接插件…" : "正在准备插件…"}
                  </span>
                </div>
              )
            ) : null}
          </div>
        </div>

        {renderResizeHandle()}

        {inputPorts.map((port, index) => {
          const compatible =
            Boolean(connectionDataType) &&
            port.dataTypes.includes(connectionDataType as PortDataType);
          const offset = (index - (inputPorts.length - 1) / 2) * 22;
          return (
            <button
              type="button"
              key={port.id}
              className={`port port-input ${compatible ? "is-available" : connectionDataType ? "is-incompatible" : ""}`}
              style={
                {
                  top: `calc(50% + ${offset}px)`,
                  "--port-color": portColor(port.dataTypes[0]),
                } as CSSProperties
              }
              data-node-id={node.id}
              data-port-id={port.id}
              data-port-types={port.dataTypes.join(",")}
              title={port.label}
              aria-label={`${port.label}输入端口`}
              onPointerDown={(event) => event.stopPropagation()}
            />
          );
        })}
        {outputPorts.map((port, index) => {
          const offset = (index - (outputPorts.length - 1) / 2) * 22;
          return (
            <button
              type="button"
              key={port.id}
              className="port port-output"
              style={
                {
                  top: `calc(50% + ${offset}px)`,
                  "--port-color": portColor(port.dataTypes[0]),
                } as CSSProperties
              }
              data-node-id={node.id}
              data-port-id={port.id}
              title={port.label}
              aria-label={`${port.label}输出端口`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                onConnectionStart(
                  port.id,
                  port.dataTypes[0],
                  event.clientX,
                  event.clientY,
                );
              }}
            />
          );
        })}
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      data-node-id={node.id}
      className={`canvas-node node-${node.status} node-role-${role} node-kind-${node.kind} ${isEmptyResultPlaceholder ? "is-empty-result-placeholder" : ""} ${hasResultTextSurface ? "has-result-text-surface" : ""} ${isUserSized ? "is-user-sized" : ""} ${selected ? "is-selected" : ""} ${multiSelected ? "is-multi-selected" : ""}`}
      style={{
        left: node.x,
        top: node.y,
        zIndex: node.layer ?? 0,
        minHeight: customHeight === undefined && isEmptyResultPlaceholder ? 414 : undefined,
        overflow: isEmptyResultPlaceholder ? "visible" : undefined,
        padding: isEmptyResultPlaceholder ? 0 : undefined,
        ...nodeSizeStyle,
      }}
      onPointerDown={(event) => {
        handlePointerDown(event);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      aria-label={
        isEmptyResultPlaceholder
          ? resultPlaceholderLabels[node.kind]
          : hideSucceededResultStatus
            ? node.title
            : `${node.title}，${status.label}`
      }
    >
      {promptEditorOpen && role === "execution" && (
        <PromptEditorDialog
          nodeTitle={node.title}
          value={node.prompt}
          assets={canvasAssets}
          attachedSourceIds={new Set(inputAssets.map((asset) => asset.sourceNodeId))}
          onAttach={onAttachInputAsset}
          onCancel={() => setPromptEditorOpen(false)}
          onSave={(prompt) => {
            onUpdate({ prompt });
            setPromptEditorOpen(false);
          }}
        />
      )}
      {hasTextResultActions && (
        <nav
          className="result-action-nav"
          aria-label="文本结果功能导航"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`result-text-action ${copyState === "copied" ? "is-success" : copyState === "failed" ? "is-error" : ""}`}
            aria-label={copyState === "copied" ? "文本已复制" : "复制文本内容"}
            title={copyState === "failed" ? "复制失败，请重试" : "复制文本内容"}
            onClick={(event) => {
              event.stopPropagation();
              void copyTextResult();
            }}
          >
            {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
            <span>
              {copyState === "copied"
                ? "已复制"
                : copyState === "failed"
                  ? "复制失败"
                  : "复制"}
            </span>
          </button>
          <button
            type="button"
            className={`result-text-action ${downloadState === "downloaded" ? "is-success" : downloadState === "failed" ? "is-error" : ""}`}
            aria-label={
              downloadState === "downloaded" ? "文本已下载" : "下载文本内容"
            }
            title={downloadState === "failed" ? "下载失败，请重试" : "下载 TXT"}
            onClick={(event) => {
              event.stopPropagation();
              void downloadTextResult();
            }}
          >
            {downloadState === "downloaded" ? (
              <Check size={14} />
            ) : (
              <Download size={14} />
            )}
            <span>
              {downloadState === "downloaded"
                ? "已下载"
                : downloadState === "failed"
                  ? "下载失败"
                  : "下载"}
            </span>
          </button>
        </nav>
      )}

        {hasMediaActions && (
          <nav
            className="result-action-nav"
            aria-label={node.kind === "video" ? "视频功能导航" : node.kind === "audio" ? "音频功能导航" : "图片功能导航"}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <AssetPluginMenu
              plugins={mediaPlugins}
              mediaKind={node.kind as MediaPluginType}
              onSelect={onOpenMediaPlugin}
            />
            {node.kind === "audio" ? (
              <button
                type="button"
                className={`result-text-action ${copyState === "copied" ? "is-success" : copyState === "failed" ? "is-error" : ""}`}
                aria-label={copyState === "copied" ? "音频链接已复制" : "复制音频链接"}
                title={copyState === "failed" ? "复制失败，请重试" : "复制音频链接"}
                onClick={(event) => {
                  event.stopPropagation();
                  void copyMediaLink(mediaSourceUrl);
                }}
              >
                {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
                <span>
                  {copyState === "copied"
                    ? "已复制"
                    : copyState === "failed"
                      ? "复制失败"
                      : "复制"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="result-text-action"
                aria-label={node.kind === "video" ? "放大查看视频" : "放大查看图片"}
                title="放大查看"
                onClick={(event) => {
                  event.stopPropagation();
                  setViewerOpen(true);
                }}
              >
                <Maximize2 size={14} />
                <span>放大</span>
              </button>
            )}
            <button
              type="button"
              className={`result-text-action ${downloadState === "downloaded" ? "is-success" : downloadState === "failed" ? "is-error" : ""}`}
              aria-label={
                downloadState === "downloaded"
                  ? node.kind === "video"
                    ? "视频已下载"
                    : "图片已下载"
                  : node.kind === "video"
                    ? "下载视频"
                    : "下载图片"
              }
              title={downloadState === "failed" ? "下载失败，请重试" : node.kind === "video" ? "下载视频" : "下载图片"}
              onClick={(event) => {
                event.stopPropagation();
                void downloadMediaAsset(mediaSourceUrl, typeof node.parameters?.assetDownloadUrl === "string"
                  ? node.parameters.assetDownloadUrl
                  : undefined);
              }}
            >
              {downloadState === "downloaded" ? (
                <Check size={14} />
              ) : (
                <Download size={14} />
              )}
              <span>
                {downloadState === "downloaded"
                  ? "已下载"
                  : downloadState === "failed"
                    ? "下载失败"
                    : "下载"}
              </span>
            </button>
          </nav>
        )}

        {hasAudioActions && (
          <nav
            className="result-action-nav"
            aria-label="音频功能导航"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <AssetPluginMenu
              plugins={mediaPlugins}
              mediaKind="audio"
              onSelect={onOpenMediaPlugin}
            />
            <button
              type="button"
              className={`result-text-action ${copyState === "copied" ? "is-success" : copyState === "failed" ? "is-error" : ""}`}
              aria-label={copyState === "copied" ? "音频链接已复制" : "复制音频链接"}
              title={copyState === "failed" ? "复制失败，请重试" : "复制音频链接"}
              onClick={(event) => {
                event.stopPropagation();
                void copyMediaLink(mediaSourceUrl);
              }}
            >
              {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
              <span>
                {copyState === "copied"
                  ? "已复制"
                  : copyState === "failed"
                    ? "复制失败"
                    : "复制"}
              </span>
            </button>
            <button
              type="button"
              className={`result-text-action ${downloadState === "downloaded" ? "is-success" : downloadState === "failed" ? "is-error" : ""}`}
              aria-label={downloadState === "downloaded" ? "音频已下载" : "下载音频"}
              title={downloadState === "failed" ? "下载失败，请重试" : "下载音频"}
              onClick={(event) => {
                event.stopPropagation();
                void downloadMediaAsset(mediaSourceUrl, typeof node.parameters?.assetDownloadUrl === "string"
                  ? node.parameters.assetDownloadUrl
                  : undefined);
              }}
            >
              {downloadState === "downloaded" ? (
                <Check size={14} />
              ) : (
                <Download size={14} />
              )}
              <span>
                {downloadState === "downloaded"
                  ? "已下载"
                  : downloadState === "failed"
                    ? "下载失败"
                    : "下载"}
              </span>
            </button>
          </nav>
        )}

      {viewerOpen && mediaSourceUrl ? (
        <MediaViewer
          url={mediaSourceUrl}
          kind={node.kind === "video" ? "video" : "image"}
          title={`${node.title} 放大预览`}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}

      {isEmptyResultPlaceholder ? (
        <div className="result-placeholder-surface node-drag-handle">
          <header className="result-placeholder-header">
            <span className="result-placeholder-title">
              <ResultPlaceholderIcon size={14} aria-hidden="true" />
              <span>{resultPlaceholderLabels[node.kind]}</span>
            </span>
            <button
              type="button"
              className="result-placeholder-delete"
              aria-label={`删除${resultPlaceholderLabels[node.kind]}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <X size={14} />
            </button>
          </header>
          <div className="result-placeholder-body">
            {isGeneratingResultPlaceholder && (
              <div
                className="result-placeholder-generating"
                role="status"
                aria-live="polite"
              >
                <span className="result-placeholder-spinner-shell">
                  <LoaderCircle
                    className="result-placeholder-spinner"
                    size={28}
                    aria-hidden="true"
                  />
                </span>
                <strong>正在生成中…</strong>
                <small>完成后结果将自动显示在这里</small>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
      {role === "result" && node.kind === "text" && (
        <div className="node-workbench-content">
          <textarea
            className="text-result-editor"
            aria-label="编辑文本结果"
            value={inlineTextResult(node)}
            spellCheck={false}
            onFocus={() => {
              if (!selected) onSelect(false);
            }}
            onChange={(event) => updateTextResult(event.target.value)}
          />
        </div>
      )}

      {(role === "execution" ||
        (selected && role === "result" && node.kind !== "text")) && (
        <div className="node-workbench-content">
          {role === "result" ? (
            <NodeWorkbench node={node} />
          ) : null}

          {role === "execution" &&
            (node.kind !== "audio" || inputConstraints.maxTotal > 0) && (
            <NodeInputAssets
              assets={inputAssets}
              constraints={inputConstraints}
              onRemove={onRemoveInputAsset}
              onUpload={onUploadInputAssets}
            />
          )}

          {role !== "result" && (
            <NodePromptEditor
              value={node.prompt}
              assets={canvasAssets}
              attachedSourceIds={new Set(inputAssets.map((asset) => asset.sourceNodeId))}
              onChange={(prompt) => onUpdate({ prompt })}
              onAttach={onAttachInputAsset}
              onExpand={() => setPromptEditorOpen(true)}
            />
          )}

          {role === "execution" && (
            <div
              className="node-config-sections node-option-strip"
              aria-label="节点选项"
            >
              <section
                className="node-config-section node-config-skill"
                aria-label="Skill 能力配置"
              >
                <div className="node-config-section-heading">
                  <strong>Skill</strong>
                  <span>能力配置</span>
                </div>
                <div className="node-fields node-fields-single">
                  <label>
                    <Sparkles size={13} className="node-strip-icon" aria-hidden="true" />
                    <span>skill</span>
                    <SelectMenu
                      ariaLabel="skill"
                      value={node.capabilityId}
                      onChange={(nextCapabilityId) => {
                        const capability =
                          nextCapabilityId === "none"
                            ? undefined
                            : capabilities.find(
                                (item) => item.id === nextCapabilityId,
                              );
                        const currentModel = models.find(
                          (model) => model.id === node.modelId,
                        );
                        const nextModel = preferredModel(
                          models,
                          capability,
                          node.kind,
                        );
                        const nextModelId =
                          capability?.executionMode === "remote"
                            ? "skill-runtime"
                            : currentModel &&
                                modelMatchesCapability(
                                  currentModel,
                                  capability,
                                  node.kind,
                                )
                              ? currentModel.id
                              : (nextModel?.id ?? "unconfigured");
                        onUpdate({
                          capabilityId: nextCapabilityId,
                          modelId: nextModelId,
                          parameters: {
                            ...(node.parameters?.failurePolicy
                              ? {
                                  failurePolicy:
                                    node.parameters.failurePolicy,
                                }
                              : {}),
                            ...(node.parameters?.retryLimit !== undefined
                              ? { retryLimit: node.parameters.retryLimit }
                              : {}),
                            ...(nextModelId === node.modelId &&
                            node.parameters?.modelParameters
                              ? {
                                  modelParameters:
                                    node.parameters.modelParameters,
                                }
                              : {}),
                            ...(capability
                              ? {
                                  capabilitySnapshot:
                                    snapshotCapability(capability),
                                }
                              : {}),
                          },
                        });
                      }}
                      options={[
                        { value: "none", label: "无" },
                        ...(!hasNoCapability && !activeCapability
                          ? [
                              {
                                value: node.capabilityId,
                                label: "缺失能力（历史节点只读）",
                              },
                            ]
                          : []),
                        ...compatibleCapabilities.map((capability) => ({
                          value: capability.id,
                          label: capability.title,
                        })),
                      ]}
                    />
                  </label>
                </div>

                {node.kind !== "image" && capabilityContract?.inputSchema && (
                  <SchemaFields
                    schema={capabilityContract.inputSchema}
                    uiSchema={capabilityContract.uiSchema}
                    value={node.parameters ?? {}}
                    workspaceId={workspaceId}
                    onChange={(parameters) => onUpdate({ parameters })}
                  />
                )}
              </section>

              <section
                className="node-config-section node-config-model"
                aria-label="模型配置"
              >
                <div className="node-config-section-heading">
                  <strong>模型</strong>
                  <span>生成服务</span>
                </div>
                <div className="node-fields node-fields-single">
                  <label>
                    <Cpu size={13} className="node-strip-icon" aria-hidden="true" />
                    <span>模型</span>
                    <SelectMenu
                      ariaLabel="模型"
                      value={selectedModelId}
                      disabled={
                        capabilityContract?.executionMode === "remote"
                      }
                      onChange={(nextModelId) =>
                        onUpdate({
                          modelId: nextModelId,
                          parameters: {
                            ...node.parameters,
                            modelParameters: {},
                          },
                        })
                      }
                      options={[
                        ...(capabilityContract?.executionMode === "remote"
                          ? [
                              {
                                value: "skill-runtime",
                                label: "Skill 内置执行服务",
                              },
                            ]
                          : []),
                        ...(!compatibleModels.some(
                          (model) => model.id === selectedModelId,
                        )
                          ? [
                              {
                                value: "unconfigured",
                                label: "未配置兼容模型",
                              },
                            ]
                          : []),
                        ...compatibleModels.map((model) => ({
                          value: model.id,
                          label: (model.capabilityTags ?? []).includes("local")
                            ? "💻 " + model.name
                            : model.name,
                        })),
                      ]}
                    />
                  </label>
                </div>

                {capabilityContract?.executionMode !== "remote" &&
                  selectedModel?.parameterSchema && (
                    <SchemaFields
                      title="模型参数"
                      schema={selectedModel.parameterSchema}
                      uiSchema={selectedModel.uiSchema}
                      value={
                        node.parameters?.modelParameters &&
                        typeof node.parameters.modelParameters === "object" &&
                        !Array.isArray(node.parameters.modelParameters)
                          ? (node.parameters
                              .modelParameters as Record<string, unknown>)
                          : {}
                      }
                      workspaceId={workspaceId}
                      onChange={(modelParameters) =>
                        onUpdate({
                          parameters: {
                            ...node.parameters,
                            modelParameters,
                          },
                        })
                      }
                    />
                  )}
              </section>

              <section
                className="node-config-section node-config-policy"
                aria-label="运行策略"
              >
                <div className="node-config-section-heading">
                  <strong>运行策略</strong>
                </div>
                <div className="node-fields">
                  <label>
                    <span>失败策略</span>
                    <SelectMenu
                      ariaLabel="失败策略"
                      value={String(
                        node.parameters?.failurePolicy ?? "stop",
                      )}
                      onChange={(nextPolicy) =>
                        onUpdate({
                          parameters: {
                            ...node.parameters,
                            failurePolicy: nextPolicy,
                          },
                        })
                      }
                      options={[
                        { value: "stop", label: "停止工作流" },
                        { value: "retry", label: "自动重试" },
                        { value: "skip", label: "跳过并继续" },
                      ]}
                    />
                  </label>
                  {node.parameters?.failurePolicy === "retry" && (
                    <label>
                      <span>最大尝试次数</span>
                      <SelectMenu
                        ariaLabel="最大尝试次数"
                        value={String(node.parameters?.retryLimit ?? 3)}
                        onChange={(nextRetry) =>
                          onUpdate({
                            parameters: {
                              ...node.parameters,
                              retryLimit: Number(nextRetry),
                            },
                          })
                        }
                        options={[2, 3, 4, 5].map((attempts) => ({
                          value: String(attempts),
                          label: `${attempts} 次`,
                        }))}
                      />
                    </label>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {(node.status === "running" || node.status === "queued") && (
        <div className="node-progress" aria-label={`进度 ${node.progress ?? 0}%`}>
          <span style={{ width: `${node.progress ?? 0}%` }} />
        </div>
      )}

      {failureNotice && (
        <div className="node-failure-notice" role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          <span>{failureNotice}</span>
        </div>
      )}

      {!selected &&
      role === "result" &&
      node.kind !== "text" &&
      outputSchema &&
      kernelOutput &&
      !inlineTextResult(node) ? (
          <SchemaOutput
            schema={outputSchema}
            value={
              kernelOutput.data ??
              kernelOutput
            }
          />
        ) : null}

      {!selected &&
        role === "result" &&
        node.kind !== "text" &&
        kernelOutput &&
        (!outputSchema || Boolean(inlineTextResult(node))) && (
          <NodeWorkbench node={node} />
        )}

      {!selected &&
        role === "result" &&
        node.kind !== "text" &&
        node.result &&
        !kernelOutput && (
          <div className="node-result">{node.result}</div>
        )}

      {role === "execution" && (
        <div className="node-actions">
          <IconButton
            label={
              inputAssetValidation.valid
                ? "重试节点"
                : "输入素材超出当前模型限制"
            }
            onClick={onRun}
            disabled={!inputAssetValidation.valid}
          >
            <RotateCcw size={15} />
          </IconButton>
          <IconButton
            label="从此节点重跑下游分支"
            onClick={onRerunBranch}
            disabled={!inputAssetValidation.valid}
          >
            <GitBranch size={15} />
          </IconButton>
          <IconButton
            label="上移一层"
            onClick={() => onUpdate({ layer: (node.layer ?? 0) + 1 })}
          >
            <ChevronUp size={15} />
          </IconButton>
          <IconButton
            label="下移一层"
            onClick={() => onUpdate({ layer: (node.layer ?? 0) - 1 })}
          >
            <ChevronDown size={15} />
          </IconButton>
          <button
            type="button"
            className="node-run-button"
            title={
              !inputAssetValidation.valid
                ? "输入素材超出当前模型限制"
                : undefined
            }
            onClick={onRun}
            onPointerDown={(event) => event.stopPropagation()}
            disabled={
              !inputAssetValidation.valid ||
              node.status === "waiting" ||
              node.status === "running" ||
              node.status === "queued" ||
              node.status === "paused"
            }
          >
            {node.status === "waiting" || node.status === "running" ? (
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
            ) : (
              <Play size={13} aria-hidden="true" />
            )}
            运行节点
          </button>
        </div>
      )}
        </>
      )}

      {node.status !== "draft" &&
        !hideSucceededResultStatus &&
        !isGeneratingResultPlaceholder && (
        <span
          className={`node-status node-corner-status status-${node.status}`}
          role="status"
          aria-label={status.label}
        >
          <StatusIcon size={13} aria-hidden="true" />
          {status.label}
        </span>
      )}

      {renderResizeHandle()}

      {inputPorts.map((port, index) => {
        const compatible =
          Boolean(connectionDataType) &&
          port.dataTypes.includes(connectionDataType as PortDataType);
        const offset = (index - (inputPorts.length - 1) / 2) * 22;
        return (
          <button
            type="button"
            key={port.id}
            className={`port port-input ${compatible ? "is-available" : connectionDataType ? "is-incompatible" : ""}`}
            style={
              {
                top: `calc(50% + ${offset}px)`,
                "--port-color": portColor(port.dataTypes[0]),
              } as CSSProperties
            }
            data-node-id={node.id}
            data-port-id={port.id}
            data-port-types={port.dataTypes.join(",")}
            title={
              compatible
                ? `${port.label} · 可接收 ${connectionDataType}`
                : `${port.label} · ${port.dataTypes.join(" / ")}`
            }
            aria-label={`${port.label}输入端口，可接收${port.dataTypes.join("、")}`}
            onPointerDown={(event) => event.stopPropagation()}
          />
        );
      })}
      {outputPorts.map((port, index) => {
        const offset = (index - (outputPorts.length - 1) / 2) * 22;
        return (
          <button
            type="button"
            key={port.id}
            className="port port-output"
            style={
              {
                top: `calc(50% + ${offset}px)`,
                "--port-color": portColor(port.dataTypes[0]),
              } as CSSProperties
            }
            data-node-id={node.id}
            data-port-id={port.id}
            title={`${port.label} · 输出 ${port.dataTypes.join(" / ")}`}
            aria-label={`${port.label}输出端口，输出${port.dataTypes.join("、")}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onConnectionStart(
                port.id,
                port.dataTypes[0],
                event.clientX,
                event.clientY,
              );
            }}
          />
        );
      })}
    </article>
  );
}
