"use client";

import type { KeyboardEvent, PointerEvent } from "react";
import { useMemo } from "react";
import { indexedPortPoint } from "../lib/canvas-geometry";
import {
  portColor,
  portsForNode,
  resolveEdgePorts,
} from "../lib/node-ports";
import { widthForNode } from "../lib/node-layout";
import type {
  CanvasEdge,
  CanvasNode,
  PortDataType,
} from "../types";

interface ConnectionDraft {
  sourceId: string;
  sourcePortId: string;
  dataType: PortDataType;
  current: { x: number; y: number };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface CanvasEdgeLayerProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  nodeHeights: Record<string, number>;
  visibleBounds: Bounds;
  selectedEdgeId: string | null;
  draft: ConnectionDraft | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function portPoint(
  node: CanvasNode,
  portId: string,
  direction: "input" | "output",
  height: number,
) {
  const ports = portsForNode(node, direction);
  const index = Math.max(
    0,
    ports.findIndex((port) => port.id === portId),
  );
  return indexedPortPoint(
    node,
    { width: widthForNode(node), height },
    direction,
    index,
    ports.length,
  );
}

function curve(start: { x: number; y: number }, end: { x: number; y: number }) {
  const control = Math.max(72, Math.abs(end.x - start.x) * 0.42);
  return `M ${start.x} ${start.y} C ${start.x + control} ${start.y}, ${end.x - control} ${end.y}, ${end.x} ${end.y}`;
}

function curveMidpoint(
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const control = Math.max(72, Math.abs(end.x - start.x) * 0.42);
  const first = { x: start.x + control, y: start.y };
  const second = { x: end.x - control, y: end.y };
  return {
    x:
      start.x * 0.125 +
      first.x * 0.375 +
      second.x * 0.375 +
      end.x * 0.125,
    y:
      start.y * 0.125 +
      first.y * 0.375 +
      second.y * 0.375 +
      end.y * 0.125,
  };
}

function lineIntersectsBounds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: Bounds,
) {
  return !(
    Math.max(start.x, end.x) < bounds.minX ||
    Math.min(start.x, end.x) > bounds.maxX ||
    Math.max(start.y, end.y) < bounds.minY ||
    Math.min(start.y, end.y) > bounds.maxY
  );
}

export function canvasEdgeGeometry(
  edge: CanvasEdge,
  source: CanvasNode,
  target: CanvasNode,
  nodeHeights: Record<string, number>,
) {
  const resolved = resolveEdgePorts(edge, source, target);
  if (!resolved.sourcePort || !resolved.targetPort) return null;
  const start = portPoint(
    source,
    resolved.sourcePort.id,
    "output",
    nodeHeights[source.id] ?? 156,
  );
  const end = portPoint(
    target,
    resolved.targetPort.id,
    "input",
    nodeHeights[target.id] ?? 156,
  );
  return {
    start,
    end,
    path: curve(start, end),
    midpoint: curveMidpoint(start, end),
    dataType: resolved.dataType ?? edge.dataType,
    sourcePortLabel: resolved.sourcePort.label,
    targetPortLabel: resolved.targetPort.label,
  };
}

export function CanvasEdgeLayer({
  nodes,
  edges,
  nodeHeights,
  visibleBounds,
  selectedEdgeId,
  draft,
  onSelect,
  onDelete,
}: CanvasEdgeLayerProps) {
  const nodeMap = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const bounds = {
    minX: visibleBounds.minX - 360,
    minY: visibleBounds.minY - 360,
    maxX: visibleBounds.maxX + 360,
    maxY: visibleBounds.maxY + 360,
  };
  const stop = (event: PointerEvent<SVGGElement>) => {
    // SVG groups receive a browser focus rectangle around their full bounds
    // when selected with the pointer. Keep keyboard focus available, but do
    // not focus the edge for ordinary mouse/touch selection.
    event.preventDefault();
    event.stopPropagation();
  };
  const keyboardSelect = (
    event: KeyboardEvent<SVGGElement>,
    edgeId: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(edgeId);
  };

  return (
    <svg className="canvas-edge-layer" aria-label="节点连线">
      {edges.map((edge) => {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) return null;
        const geometry = canvasEdgeGeometry(
          edge,
          source,
          target,
          nodeHeights,
        );
        if (!geometry) return null;
        const {
          start,
          end,
          path,
          midpoint,
          dataType,
          sourcePortLabel,
          targetPortLabel,
        } = geometry;
        const selected = edge.id === selectedEdgeId;
        if (!selected && !lineIntersectsBounds(start, end, bounds)) return null;
        const running =
          source.status === "running" || target.status === "running";
        const color = portColor(dataType);
        return (
          <g
            key={edge.id}
            data-edge-id={edge.id}
            className={`canvas-edge ${running ? "is-flowing" : ""} ${selected ? "is-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`连接：${source.title} 的 ${sourcePortLabel} 到 ${target.title} 的 ${targetPortLabel}`}
            aria-pressed={selected}
            style={{ color }}
            onPointerDown={stop}
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.blur();
              onSelect(edge.id);
            }}
            onKeyDown={(event) => keyboardSelect(event, edge.id)}
          >
            <path className="canvas-edge-hit" d={path} />
            <path
              className="canvas-edge-path"
              d={path}
            />
            {selected && (
              <g
                className="canvas-edge-remove"
                transform={`translate(${midpoint.x} ${midpoint.y})`}
                role="button"
                aria-label="取消连接"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(edge.id);
                }}
              >
                <circle r="11" />
                <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
              </g>
            )}
          </g>
        );
      })}
      {draft &&
        (() => {
          const source = nodeMap.get(draft.sourceId);
          if (!source) return null;
          const start = portPoint(
            source,
            draft.sourcePortId,
            "output",
            nodeHeights[source.id] ?? 156,
          );
          return (
            <path
              className="canvas-edge-draft"
              d={curve(start, draft.current)}
              style={{ color: portColor(draft.dataType) }}
            />
          );
        })()}
    </svg>
  );
}
