"use client";

import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  FileText,
  FileOutput,
  GitBranch,
  GripHorizontal,
  Image as ImageIcon,
  Layers3,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Type,
  Video,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import type {
  CanvasNode,
  Capability,
  KernelNodeOutput,
  ModelConnection,
  NodeStatus,
  PortDataType,
} from "../types";
import { portColor, portsForNode } from "../lib/node-ports";
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

interface NodeCardProps {
  node: CanvasNode;
  workspaceId: string;
  saveState: "loading" | "ready" | "saving" | "saved" | "conflict" | "error";
  selected: boolean;
  multiSelected: boolean;
  zoom: number;
  panMode: boolean;
  capabilities: Capability[];
  models: ModelConnection[];
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
  connectionDataType?: PortDataType;
  onRun: () => void;
  onRerunBranch: () => void;
}

interface NodeWorkbenchProps {
  node: CanvasNode;
  onUpdate: (patch: Partial<CanvasNode>) => void;
}

function NodeWorkbench({ node, onUpdate }: NodeWorkbenchProps) {
  const parameters = node.parameters ?? {};
  const value = (key: string, fallback: string) =>
    typeof parameters[key] === "string" ? String(parameters[key]) : fallback;
  const updateParameter = (key: string, nextValue: string) =>
    onUpdate({ parameters: { ...parameters, [key]: nextValue } });
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
  const progressLabel =
    node.status === "running"
      ? `生成中 ${node.progress ?? 0}%`
      : node.status === "queued"
        ? "等待执行"
        : "预览";

  return (
    <section className={`node-workbench workbench-${node.kind}`}>
      <header>
        <span>
          <Layers3 size={12} /> 专业工作台
        </span>
        <small>{node.kind.toUpperCase()}</small>
      </header>

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
          <><Type size={15} /><p>{kernelOutput?.text ?? node.result ?? "暂无输出"}</p></>
        )}
        {node.kind === "image" && mediaUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl} alt={`${node.title} 生成结果`} />
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
        <span className="media-preview-badge">
          <Sparkles size={11} /> {progressLabel}
        </span>
      </div>

      {false && node.kind === "text" && (
        <>
          <div className="workbench-preview text-workbench-preview">
            <Type size={15} />
            <p>{node.result ?? "运行节点后，文本结果会直接显示在这里。"}</p>
          </div>
          <div className="workbench-fields">
            <label>
              <span>语气</span>
              <select
                value={value("tone", "brand")}
                onChange={(event) => updateParameter("tone", event.target.value)}
              >
                <option value="brand">品牌叙事</option>
                <option value="cinematic">电影感</option>
                <option value="natural">自然口语</option>
              </select>
            </label>
            <label>
              <span>长度</span>
              <select
                value={value("length", "medium")}
                onChange={(event) => updateParameter("length", event.target.value)}
              >
                <option value="short">精简</option>
                <option value="medium">标准</option>
                <option value="long">详细</option>
              </select>
            </label>
          </div>
        </>
      )}

      {false && node.kind === "image" && (
        <>
          <div className="workbench-preview image-workbench-preview">
            {mediaUrl ? (
              // Provider and OSS result URLs are dynamic.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl} alt={`${node.title} 生成结果`} />
            ) : (
              <div className="media-preview-art" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            )}
            <span className="media-preview-badge">
              <Sparkles size={11} /> {progressLabel}
            </span>
          </div>
          <label className="workbench-reference">
            <span>参考素材</span>
            <input
              value={value("reference", "上游节点 · 主视觉参考")}
              onChange={(event) => updateParameter("reference", event.target.value)}
            />
          </label>
          <div className="workbench-fields">
            <label>
              <span>画幅</span>
              <select
                value={value("ratio", "16:9")}
                onChange={(event) => updateParameter("ratio", event.target.value)}
              >
                <option value="16:9">16:9 横向</option>
                <option value="9:16">9:16 竖向</option>
                <option value="1:1">1:1 方形</option>
              </select>
            </label>
            <label>
              <span>质量</span>
              <select
                value={value("quality", "high")}
                onChange={(event) => updateParameter("quality", event.target.value)}
              >
                <option value="draft">草图</option>
                <option value="high">高清</option>
                <option value="ultra">超清</option>
              </select>
            </label>
          </div>
        </>
      )}

      {false && node.kind === "video" && (
        <>
          <div className="workbench-preview video-workbench-preview">
            {mediaUrl ? (
              <video src={mediaUrl} controls aria-label={`${node.title} 生成结果`} />
            ) : (
              <>
                <Clapperboard size={18} />
                <span className="video-preview-play" aria-hidden="true">
                  <Play size={14} fill="currentColor" />
                </span>
                <div className="video-preview-timeline">
                  <span style={{ width: `${node.progress ?? 0}%` }} />
                </div>
                <small>{value("duration", "6")}s</small>
              </>
            )}
          </div>
          <label className="workbench-reference">
            <span>首帧素材</span>
            <input
              value={value("firstFrame", "继承上游图像节点")}
              onChange={(event) => updateParameter("firstFrame", event.target.value)}
            />
          </label>
          <div className="workbench-fields">
            <label>
              <span>时长</span>
              <select
                value={value("duration", "6")}
                onChange={(event) => updateParameter("duration", event.target.value)}
              >
                <option value="4">4 秒</option>
                <option value="6">6 秒</option>
                <option value="10">10 秒</option>
              </select>
            </label>
            <label>
              <span>运镜</span>
              <select
                value={value("camera", "push")}
                onChange={(event) => updateParameter("camera", event.target.value)}
              >
                <option value="push">缓慢推进</option>
                <option value="follow">稳定跟随</option>
                <option value="orbit">环绕主体</option>
              </select>
            </label>
          </div>
        </>
      )}

      {false && node.kind === "audio" && (
        <>
          <div className="workbench-preview audio-workbench-preview">
            {mediaUrl ? (
              <audio src={mediaUrl} controls preload="metadata" />
            ) : (
              <>
                <AudioLines size={22} />
                <span>{progressLabel}</span>
              </>
            )}
          </div>
          <div className="workbench-fields">
            <label>
              <span>格式</span>
              <select
                value={value("format", "mp3")}
                onChange={(event) => updateParameter("format", event.target.value)}
              >
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
                <option value="flac">FLAC</option>
              </select>
            </label>
            <label>
              <span>采样率</span>
              <select
                value={value("sampleRate", "44100")}
                onChange={(event) =>
                  updateParameter("sampleRate", event.target.value)
                }
              >
                <option value="22050">22.05 kHz</option>
                <option value="44100">44.1 kHz</option>
                <option value="48000">48 kHz</option>
              </select>
            </label>
          </div>
        </>
      )}

      {false && node.kind === "document" && (
        <>
          <div className="workbench-preview document-workbench-preview">
            <FileOutput size={22} />
            <span>{mediaUrl ? "文档已生成，可在结果区打开" : progressLabel}</span>
          </div>
          <div className="workbench-fields">
            <label>
              <span>输出格式</span>
              <select
                value={value("format", "pdf")}
                onChange={(event) => updateParameter("format", event.target.value)}
              >
                <option value="pdf">PDF</option>
                <option value="docx">Word</option>
                <option value="pptx">PowerPoint</option>
                <option value="xlsx">Excel</option>
              </select>
            </label>
            <label>
              <span>模板</span>
              <input
                value={value("template", "默认模板")}
                onChange={(event) =>
                  updateParameter("template", event.target.value)
                }
              />
            </label>
          </div>
        </>
      )}
    </section>
  );
}

export function NodeCard({
  node,
  workspaceId,
  saveState,
  selected,
  multiSelected,
  zoom,
  panMode,
  capabilities,
  models,
  onSelect,
  onMoveStart,
  onMove,
  onUpdate,
  onSizeChange,
  onConnectionStart,
  connectionDataType,
  onRun,
  onRerunBranch,
}: NodeCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
    checkpointed: boolean;
  } | null>(null);
  const moveFrame = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const status = statusMeta[node.status];
  const StatusIcon = status.icon;
  const KindIcon = kindMeta[node.kind].icon;
  const modalityCapabilities = capabilities.filter(
    (capability) => capability.enabled && capability.modality === node.kind,
  );
  const packageCapabilities = modalityCapabilities.filter(
    (capability) => capability.packageId,
  );
  const activeCapability = capabilities.find(
    (capability) => capability.id === node.capabilityId,
  );
  const compatibleCapabilities = packageCapabilities.length
    ? [
        ...(activeCapability &&
        !packageCapabilities.some((item) => item.id === activeCapability.id)
          ? [activeCapability]
          : []),
        ...packageCapabilities,
      ]
    : modalityCapabilities;
  const capabilityContract =
    activeCapability ?? nodeCapabilitySnapshot(node);
  const compatibleModels = models.filter((model) =>
    modelMatchesCapability(model, capabilityContract, node.kind),
  );
  const outputSchema = capabilityContract?.outputSchema;
  const kernelOutput = node.parameters?.kernelOutput as
    | KernelNodeOutput
    | undefined;
  const inputPorts = portsForNode(node, "input");
  const outputPorts = portsForNode(node, "output");

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
    },
    [],
  );

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (panMode || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
      checkpointed: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(event.shiftKey || event.metaKey || event.ctrlKey);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - drag.current.startX,
      event.clientY - drag.current.startY,
    );
    if (distance <= 2) return;
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

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) {
      if (pendingMove.current) {
        onMove(pendingMove.current.x, pendingMove.current.y);
        pendingMove.current = null;
      }
      drag.current = null;
    }
  }

  return (
    <article
      ref={cardRef}
      className={`canvas-node node-${node.status} ${selected ? "is-selected" : ""} ${multiSelected ? "is-multi-selected" : ""} ${node.collapsed ? "is-collapsed" : ""}`}
      style={{ left: node.x, top: node.y, zIndex: node.layer ?? 0 }}
      onPointerDown={(event) => {
        if (
          panMode ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest(
            "button, input, textarea, select, .node-drag-handle, .port",
          )
        ) {
          return;
        }
        onSelect(event.shiftKey || event.metaKey || event.ctrlKey);
      }}
      aria-label={`${node.title}，${status.label}`}
    >
      <div
        className="node-drag-handle"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className={`node-kind kind-${node.kind}`}>
          <KindIcon size={14} aria-hidden="true" />
          {kindMeta[node.kind].label}
        </span>
        <GripHorizontal size={16} aria-hidden="true" />
        {node.collapsed && <strong className="collapsed-node-title">{node.title}</strong>}
        <IconButton
          label={node.collapsed ? "展开节点" : "折叠节点"}
          onClick={() => onUpdate({ collapsed: !node.collapsed })}
        >
          <Minimize2 size={13} />
        </IconButton>
        <span className={`node-status status-${node.status}`}>
          <StatusIcon size={13} aria-hidden="true" />
          {status.label}
        </span>
      </div>

      {selected ? (
        <input
          className="node-title-input"
          aria-label="节点标题"
          value={node.title}
          onChange={(event) => onUpdate({ title: event.target.value })}
        />
      ) : (
        <h3>{node.title}</h3>
      )}

      {!selected && (
        <p className="node-prompt">{node.prompt}</p>
      )}

      {selected && (
        <div className="node-workbench-content">
          <textarea
            className="node-prompt-input"
            aria-label="节点任务描述"
            value={node.prompt}
            onChange={(event) => onUpdate({ prompt: event.target.value })}
          />

          <NodeWorkbench node={node} onUpdate={onUpdate} />

          <div className="node-fields">
            <label>
              <span>能力</span>
              <select
                aria-label="能力"
                value={node.capabilityId}
                onChange={(event) => {
                  const capability = capabilities.find(
                    (item) => item.id === event.target.value,
                  );
                  const currentModel = models.find(
                    (model) => model.id === node.modelId,
                  );
                  const nextModel = capability
                    ? preferredModel(models, capability, node.kind)
                    : undefined;
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
                    capabilityId: event.target.value,
                    modelId: nextModelId,
                    parameters: {
                      ...(node.parameters?.failurePolicy
                        ? { failurePolicy: node.parameters.failurePolicy }
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
                {!activeCapability && (
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
            <label>
              <span>模型</span>
              <select
                aria-label="模型"
                value={node.modelId}
                disabled={capabilityContract?.executionMode === "remote"}
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
                  <option value="skill-runtime">Skill 内置执行服务</option>
                )}
                {!compatibleModels.some((model) => model.id === node.modelId) && (
                  <option value="unconfigured">未配置兼容模型</option>
                )}
                {compatibleModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>失败策略</span>
              <select
                aria-label="失败策略"
                value={String(node.parameters?.failurePolicy ?? "stop")}
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

          {!activeCapability && (
            <div className="node-missing-capability" role="status">
              当前 Package 已停用或卸载。历史参数和结果仍保留；请重新安装或选择替代能力后再执行。
            </div>
          )}

          {capabilityContract?.inputSchema && (
            <SchemaFields
              schema={capabilityContract.inputSchema}
              uiSchema={capabilityContract.uiSchema}
              value={node.parameters ?? {}}
              workspaceId={workspaceId}
              onChange={(parameters) => onUpdate({ parameters })}
            />
          )}

          {capabilityContract?.executionMode !== "remote" &&
            models.find((model) => model.id === node.modelId)
              ?.parameterSchema && (
              <SchemaFields
                title="模型参数"
                schema={
                  models.find((model) => model.id === node.modelId)
                    ?.parameterSchema
                }
                uiSchema={
                  models.find((model) => model.id === node.modelId)?.uiSchema
                }
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
        </div>
      )}

      {(node.status === "running" || node.status === "queued") && (
        <div className="node-progress" aria-label={`进度 ${node.progress ?? 0}%`}>
          <span style={{ width: `${node.progress ?? 0}%` }} />
        </div>
      )}

      {!selected && outputSchema && kernelOutput ? (
          <SchemaOutput
            schema={outputSchema}
            value={
              kernelOutput.data ??
              kernelOutput
            }
          />
        ) : null}

      {!selected &&
        node.result &&
        !(outputSchema && kernelOutput) && (
          <div className="node-result">{node.result}</div>
        )}

      {selected && (
        <div className="node-actions">
          <IconButton label="运行节点" onClick={onRun}>
            <Play size={15} />
          </IconButton>
          <IconButton label="重试节点" onClick={onRun}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label="从此节点重跑下游分支" onClick={onRerunBranch}>
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
          <span className="saved-state">
            {saveState === "conflict" || saveState === "error" ? (
              <AlertCircle size={13} />
            ) : (
              <Check size={13} />
            )}{" "}
            {saveState === "saving"
              ? "保存中"
              : saveState === "conflict"
                ? "版本冲突"
                : saveState === "error"
                  ? "保存失败"
                  : "已保存"}
          </span>
        </div>
      )}

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
