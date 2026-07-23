"use client";

import {
  AlertCircle,
  Check,
  Clock3,
  FileText,
  GripHorizontal,
  Image as ImageIcon,
  Pause,
  Play,
  RotateCcw,
  Video,
  XCircle,
} from "lucide-react";
import { useRef } from "react";
import type { CanvasNode, Capability, ModelConnection, NodeStatus } from "../types";
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
  zoom: number;
  capabilities: Capability[];
  models: ModelConnection[];
  onSelect: () => void;
  onMove: (x: number, y: number) => void;
  onUpdate: (patch: Partial<CanvasNode>) => void;
}

export function NodeCard({
  node,
  selected,
  zoom,
  capabilities,
  models,
  onSelect,
  onMove,
  onUpdate,
}: NodeCardProps) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
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

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button, input, textarea, select")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const scale = zoom / 100;
    onMove(
      Math.max(16, drag.current.nodeX + (event.clientX - drag.current.startX) / scale),
      Math.max(24, drag.current.nodeY + (event.clientY - drag.current.startY) / scale),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <article
      className={`canvas-node node-${node.status} ${selected ? "is-selected" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={onSelect}
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

      {selected ? (
        <textarea
          className="node-prompt-input"
          aria-label="节点任务描述"
          value={node.prompt}
          onChange={(event) => onUpdate({ prompt: event.target.value })}
        />
      ) : (
        <p className="node-prompt">{node.prompt}</p>
      )}

      {selected && (
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
      )}

      {selected && activeCapability?.inputSchema && (
        <SchemaFields
          schema={activeCapability.inputSchema}
          uiSchema={activeCapability.uiSchema}
          value={node.parameters ?? {}}
          onChange={(parameters) => onUpdate({ parameters })}
        />
      )}

      {(node.status === "running" || node.status === "queued") && (
        <div className="node-progress" aria-label={`进度 ${node.progress ?? 0}%`}>
          <span style={{ width: `${node.progress ?? 0}%` }} />
        </div>
      )}

      {node.result && <div className="node-result">{node.result}</div>}

      {selected && (
        <div className="node-actions">
          <IconButton label="运行节点">
            <Play size={15} />
          </IconButton>
          <IconButton label="重试节点">
            <RotateCcw size={15} />
          </IconButton>
          <span className="saved-state">
            <Check size={13} /> 已保存
          </span>
        </div>
      )}

      <span className="port port-input" aria-hidden="true" />
      <span className="port port-output" aria-hidden="true" />
    </article>
  );
}
