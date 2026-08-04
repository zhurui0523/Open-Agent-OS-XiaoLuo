"use client";

import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Download,
  FileText,
  FileOutput,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Video,
  X,
  XCircle,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type {
  CanvasAssetReference,
  CanvasNode,
  Capability,
  KernelNodeOutput,
  ModelInputAssetKind,
  ModelInputConstraints,
  ModelConnection,
  NodeInputAssetReference,
  NodeStatus,
  PortDataType,
} from "../types";
import { SUPPORTED_FILE_ACCEPT } from "../lib/file-formats";
import { portColor, portsForNode } from "../lib/node-ports";
import { roleForNode } from "../lib/node-role";
import {
  customWidthForNode,
  EXECUTION_NODE_HEIGHT,
  EXECUTION_NODE_WIDTH,
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
import { SchemaFields } from "./schema-fields";
import { SchemaOutput } from "./schema-output";
import {
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../lib/model-input-constraints";

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
  workspaceId: string;
  selected: boolean;
  multiSelected: boolean;
  zoom: number;
  panMode: boolean;
  capabilities: Capability[];
  models: ModelConnection[];
  canvasAssets: CanvasAssetReference[];
  inputAssets: NodeInputAssetReference[];
  onSelect: (additive?: boolean) => void;
  onMoveStart: () => void;
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
  onOpenPlugin: () => void;
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
        <img src={asset.url} alt="" draggable={false} />
      ) : asset.kind === "video" && asset.url ? (
        <video src={asset.url} muted playsInline preload="metadata" />
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

export function NodePromptEditor({
  value,
  assets,
  attachedSourceIds,
  onChange,
  onAttach,
  onExpand,
  onSubmitShortcut,
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
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [mention, setMention] = useState<ActiveAssetMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
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
          if (event.key === "Enter") {
            event.preventDefault();
            insertPromptText(event.currentTarget, "\n");
            syncEditorValue(event.currentTarget);
          }
        }}
        onBlur={() => setMention(null)}
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
          />
        )}
        {node.kind === "video" && mediaUrl && (
          <video src={mediaUrl} controls aria-label={`${node.title} 生成结果`} />
        )}
        {node.kind === "audio" && mediaUrl && (
          <audio src={mediaUrl} controls preload="metadata" />
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
  workspaceId,
  selected,
  multiSelected,
  zoom,
  panMode,
  capabilities,
  models,
  canvasAssets = [],
  inputAssets = [],
  onSelect,
  onMoveStart,
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
}: NodeCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
    checkpointed: boolean;
    captured: boolean;
  } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const pendingResize = useRef<{ width: number; height: number } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
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
  const status = statusMeta[node.status];
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
  const isEmptyResultPlaceholder = role === "result" && !hasResultOutput;
  const isSizedTextResult =
    role === "result" && node.kind === "text" && hasResultOutput;
  const hasTextResultActions =
    selected && role === "result" && node.kind === "text" && hasResultOutput;
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
    (node.kind === "text" || node.kind === "image" || node.kind === "video");
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
  const pluginRuntimeUrl =
    role === "plugin" && typeof node.parameters?.runtimeUrl === "string"
      ? node.parameters.runtimeUrl
      : "";

  useEffect(() => {
    let cancelled = false;
    if (!pluginRuntimeUrl) return;

    const target = new URL(pluginRuntimeUrl, window.location.origin);
    if (!target.pathname.startsWith("/api/v2/packages/runtime/static/")) {
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setPluginPreview({ source: pluginRuntimeUrl, url: target.href });
        }
      });
      return;
    }

    void fetch("/api/v2/packages/runtime/launch", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target.href }),
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          url?: string;
          error?: string;
        };
        if (!response.ok || !payload.url) {
          throw new Error(payload.error || "无法加载插件预览");
        }
        return payload.url;
      })
      .then((previewUrl) => {
        if (!cancelled) {
          setPluginPreview({ source: pluginRuntimeUrl, url: previewUrl });
        }
      })
      .catch(() => {
        // Keep the node usable through the full-window launch button when a
        // lightweight preview grant cannot be created.
      });

    return () => {
      cancelled = true;
    };
  }, [pluginRuntimeUrl]);

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

  const customWidth = customWidthForNode(node);
  const customHeight = heightForNode(node);
  const nodeSizeStyle: CSSProperties = {
    width:
      customWidth ??
      (isExecutionNode
        ? EXECUTION_NODE_WIDTH
        : isSizedTextResult
          ? TEXT_RESULT_NODE_WIDTH
          : undefined),
    height:
      customHeight ??
      (isExecutionNode
        ? EXECUTION_NODE_HEIGHT
        : isSizedTextResult
          ? TEXT_RESULT_NODE_HEIGHT
          : undefined),
  };
  const isUserSized = customWidth !== undefined || customHeight !== undefined;

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
      const next = {
        width: Math.round(
          Math.min(
            MAX_NODE_WIDTH,
            Math.max(
              minWidthForNode(node),
              current.startWidth + (clientX - current.startX) / scale,
            ),
          ),
        ),
        height: Math.round(
          Math.min(
            MAX_NODE_HEIGHT,
            Math.max(
              minHeightForNode(node),
              current.startHeight + (clientY - current.startY) / scale,
            ),
          ),
        ),
      };
      pendingResize.current = next;
      card.style.width = `${next.width}px`;
      card.style.height = `${next.height}px`;
    };

    const handleResizeMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      pointerEvent.preventDefault();
      applyResize(pointerEvent.clientX, pointerEvent.clientY);
    };

    function cleanup() {
      window.removeEventListener("pointermove", handleResizeMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      document.body.classList.remove("is-resizing-node");
      resizeCleanup.current = null;
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
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", handleResizeMove, { passive: false });
    window.addEventListener("pointerup", finishResize, { passive: false });
    window.addEventListener("pointercancel", finishResize, { passive: false });
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
    pendingResize.current = {
      width: Math.round(
        Math.min(
          MAX_NODE_WIDTH,
          Math.max(
            minWidthForNode(node),
            cardRef.current.offsetWidth + horizontal * step,
          ),
        ),
      ),
      height: Math.round(
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
      target.closest("button, input, textarea, select, audio, a")
    ) {
      return;
    }
    const video = target.closest("video");
    if (video) {
      const rect = video.getBoundingClientRect();
      const controlHeight = Math.min(48, rect.height * 0.3);
      if (event.clientY >= rect.bottom - controlHeight) return;
    }
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
      checkpointed: false,
      captured: false,
    };
    onSelect(event.shiftKey || event.metaKey || event.ctrlKey);
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
    }
    if (!drag.current.checkpointed) {
      drag.current.checkpointed = true;
      onMoveStart();
    }
    const scale = zoom / 100;
    pendingMove.current = {
      x: drag.current.nodeX + (event.clientX - drag.current.startX) / scale,
      y: drag.current.nodeY + (event.clientY - drag.current.startY) / scale,
    };
    if (moveFrame.current === null) {
      moveFrame.current = requestAnimationFrame(() => {
        if (pendingMove.current) {
          onMove(pendingMove.current.x, pendingMove.current.y);
        }
        pendingMove.current = null;
        moveFrame.current = null;
      });
    }
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId === event.pointerId) {
      if (pendingMove.current) {
        onMove(pendingMove.current.x, pendingMove.current.y);
        pendingMove.current = null;
      }
      drag.current = null;
    }
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

        {renderResizeHandle()}

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
          className="plugin-launcher-surface"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <strong>{pluginName}</strong>
          <div className="plugin-launcher-preview" aria-hidden="true">
            {pluginPreview?.source === pluginRuntimeUrl ? (
              <iframe
                src={pluginPreview.url}
                title={`${pluginName} 预览`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                tabIndex={-1}
              />
            ) : (
              <span>插件预览</span>
            )}
          </div>
          <button
            type="button"
            className="plugin-launcher-run-button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(false);
              onOpenPlugin();
            }}
          >
            <span>启动插件</span>
          </button>
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

          {role === "execution" && (
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
                    <span>能力</span>
                    <select
                      aria-label="能力"
                      value={node.capabilityId}
                      onChange={(event) => {
                        const nextCapabilityId = event.target.value;
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
                    >
                      <option value="none">无</option>
                      {!hasNoCapability && !activeCapability && (
                        <option value={node.capabilityId}>
                          缺失能力（历史节点只读）
                        </option>
                      )}
                      {compatibleCapabilities.map((capability) => (
                        <option key={capability.id} value={capability.id}>
                          {capability.title}
                        </option>
                      ))}
                    </select>
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
                    <span>模型</span>
                    <select
                      aria-label="模型"
                      value={selectedModelId}
                      disabled={
                        capabilityContract?.executionMode === "remote"
                      }
                      onChange={(event) =>
                        onUpdate({
                          modelId: event.target.value,
                          parameters: {
                            ...node.parameters,
                            modelParameters: {},
                          },
                        })
                      }
                    >
                      {capabilityContract?.executionMode === "remote" && (
                        <option value="skill-runtime">
                          Skill 内置执行服务
                        </option>
                      )}
                      {!compatibleModels.some(
                        (model) => model.id === selectedModelId,
                      ) && (
                        <option value="unconfigured">
                          未配置兼容模型
                        </option>
                      )}
                      {compatibleModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
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
                    <select
                      aria-label="失败策略"
                      value={String(
                        node.parameters?.failurePolicy ?? "stop",
                      )}
                      onChange={(event) =>
                        onUpdate({
                          parameters: {
                            ...node.parameters,
                            failurePolicy: event.target.value,
                          },
                        })
                      }
                    >
                      <option value="stop">停止工作流</option>
                      <option value="retry">自动重试</option>
                      <option value="skip">跳过并继续</option>
                    </select>
                  </label>
                  {node.parameters?.failurePolicy === "retry" && (
                    <label>
                      <span>最大尝试次数</span>
                      <select
                        aria-label="最大尝试次数"
                        value={String(node.parameters?.retryLimit ?? 3)}
                        onChange={(event) =>
                          onUpdate({
                            parameters: {
                              ...node.parameters,
                              retryLimit: Number(event.target.value),
                            },
                          })
                        }
                      >
                        {[2, 3, 4, 5].map((attempts) => (
                          <option key={attempts} value={attempts}>
                            {attempts} 次
                          </option>
                        ))}
                      </select>
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
                ? "运行节点"
                : "输入素材超出当前模型限制"
            }
            onClick={onRun}
            disabled={!inputAssetValidation.valid}
          >
            <Play size={15} />
          </IconButton>
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
        </div>
      )}
        </>
      )}

      {node.status !== "draft" && !hideSucceededResultStatus && (
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
