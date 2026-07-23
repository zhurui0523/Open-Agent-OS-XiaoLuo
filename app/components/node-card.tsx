"use client";

import {
  AlertCircle,
  Check,
  Clapperboard,
  Clock3,
  FileText,
  GripHorizontal,
  Image as ImageIcon,
  Layers3,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Type,
  Video,
  XCircle,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type {
  CanvasNode,
  Capability,
  KernelNodeOutput,
  ModelConnection,
  NodeStatus,
} from "../types";
import { IconButton } from "./icon-button";
import { SchemaFields } from "./schema-fields";

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
};

const kindMeta = {
  text: { label: "文本", icon: FileText },
  image: { label: "图像", icon: ImageIcon },
  video: { label: "视频", icon: Video },
};

interface NodeCardProps {
  node: CanvasNode;
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
  onConnectionStart: (clientX: number, clientY: number) => void;
  connectionTargetAvailable: boolean;
  onRun: () => void;
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
        <small>{node.kind === "text" ? "TEXT" : node.kind === "image" ? "IMAGE" : "VIDEO"}</small>
      </header>

      {node.kind === "text" && (
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

      {node.kind === "image" && (
        <>
          <div className="workbench-preview image-workbench-preview">
            {mediaUrl ? (
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

      {node.kind === "video" && (
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
    </section>
  );
}

export function NodeCard({
  node,
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
  connectionTargetAvailable,
  onRun,
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
  const status = statusMeta[node.status];
  const StatusIcon = status.icon;
  const KindIcon = kindMeta[node.kind].icon;
  const compatibleCapabilities = capabilities.filter(
    (capability) => capability.enabled && capability.modality === node.kind,
  );
  const compatibleModels = models.filter((model) =>
    model.modalities.includes(node.kind),
  );
  const activeCapability = capabilities.find(
    (capability) => capability.id === node.capabilityId,
  );

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const reportSize = () => onSizeChange(node.id, card.offsetHeight);
    reportSize();
    const observer = new ResizeObserver(reportSize);
    observer.observe(card);
    return () => observer.disconnect();
  }, [node.id, onSizeChange]);

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
    onMove(
      drag.current.nodeX + (event.clientX - drag.current.startX) / scale,
      drag.current.nodeY + (event.clientY - drag.current.startY) / scale,
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <article
      ref={cardRef}
      className={`canvas-node node-${node.status} ${selected ? "is-selected" : ""} ${multiSelected ? "is-multi-selected" : ""}`}
      style={{ left: node.x, top: node.y }}
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
                onChange={(event) => onUpdate({ capabilityId: event.target.value })}
              >
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
                onChange={(event) => onUpdate({ modelId: event.target.value })}
              >
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
          </div>

          {activeCapability?.inputSchema && (
            <SchemaFields
              schema={activeCapability.inputSchema}
              uiSchema={activeCapability.uiSchema}
              value={node.parameters ?? {}}
              onChange={(parameters) => onUpdate({ parameters })}
            />
          )}
        </div>
      )}

      {(node.status === "running" || node.status === "queued") && (
        <div className="node-progress" aria-label={`进度 ${node.progress ?? 0}%`}>
          <span style={{ width: `${node.progress ?? 0}%` }} />
        </div>
      )}

      {!selected && node.result && <div className="node-result">{node.result}</div>}

      {selected && (
        <div className="node-actions">
          <IconButton label="运行节点" onClick={onRun}>
            <Play size={15} />
          </IconButton>
          <IconButton label="重试节点" onClick={onRun}>
            <RotateCcw size={15} />
          </IconButton>
          <span className="saved-state">
            <Check size={13} /> 已保存
          </span>
        </div>
      )}

      <button
        type="button"
        className={`port port-input ${connectionTargetAvailable ? "is-available" : ""}`}
        data-node-id={node.id}
        aria-label={`连接到${node.title}`}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <button
        type="button"
        className="port port-output"
        data-node-id={node.id}
        aria-label={`从${node.title}开始连接`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          onConnectionStart(event.clientX, event.clientY);
        }}
      />
    </article>
  );
}
