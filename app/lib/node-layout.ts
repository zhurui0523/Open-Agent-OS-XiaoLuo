import type { CanvasNode } from "../types";
import { roleForNode } from "./node-role";

export const DEFAULT_NODE_WIDTH = 264;
export const EXECUTION_NODE_WIDTH = 360;
export const EXECUTION_NODE_HEIGHT = 300;
export const PLUGIN_NODE_WIDTH = 360;
export const TEXT_RESULT_NODE_WIDTH = 360;
export const TEXT_RESULT_NODE_HEIGHT = 400;
export const MAX_NODE_WIDTH = 2400;
export const MAX_NODE_HEIGHT = 2400;
export const AUTO_LAYOUT_COLUMN_GAP = 64;
export const AUTO_LAYOUT_ROW_GAP = 64;
export const AUTO_LAYOUT_COLUMNS = 4;

function numericLayoutValue(node: CanvasNode, key: "layoutWidth" | "layoutHeight") {
  const value = node.parameters?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textResultHasOutput(node: CanvasNode) {
  if (roleForNode(node) !== "result" || node.kind !== "text") return false;
  if (node.result?.trim()) return true;
  const output = node.parameters?.kernelOutput;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const value = output as {
    text?: unknown;
    assetUrl?: unknown;
    data?: unknown;
  };
  return (
    (typeof value.text === "string" && Boolean(value.text.trim())) ||
    (typeof value.assetUrl === "string" && Boolean(value.assetUrl.trim())) ||
    value.data !== undefined
  );
}

export function minWidthForNode(node: CanvasNode) {
  const role = roleForNode(node);
  if (role === "execution") return 360;
  if (role === "plugin") return 240;
  return 120;
}

export function minHeightForNode(node: CanvasNode) {
  const role = roleForNode(node);
  if (role === "execution" || role === "plugin") return 180;
  if (role === "material") return 80;
  return 120;
}

export function customWidthForNode(node: CanvasNode) {
  const value = numericLayoutValue(node, "layoutWidth");
  return value === undefined
    ? undefined
    : Math.min(MAX_NODE_WIDTH, Math.max(minWidthForNode(node), value));
}

export function heightForNode(node: CanvasNode) {
  const value = numericLayoutValue(node, "layoutHeight");
  return value === undefined
    ? undefined
    : Math.min(MAX_NODE_HEIGHT, Math.max(minHeightForNode(node), value));
}

export function widthForNode(node: CanvasNode) {
  const customWidth = customWidthForNode(node);
  if (customWidth !== undefined) return customWidth;
  const role = roleForNode(node);
  if (role === "execution") return EXECUTION_NODE_WIDTH;
  if (role === "plugin") return PLUGIN_NODE_WIDTH;
  if (textResultHasOutput(node)) return TEXT_RESULT_NODE_WIDTH;
  return DEFAULT_NODE_WIDTH;
}

function autoLayoutHeightForNode(
  node: CanvasNode,
  measuredHeights: Record<string, number>,
) {
  const measured = measuredHeights[node.id];
  if (typeof measured === "number" && Number.isFinite(measured) && measured > 0) {
    return measured;
  }

  const customHeight = heightForNode(node);
  if (customHeight !== undefined) return customHeight;

  const role = roleForNode(node);
  if (role === "execution") return EXECUTION_NODE_HEIGHT;
  if (role === "plugin") return 330;
  if (role === "result" && node.kind === "text" && textResultHasOutput(node)) {
    return TEXT_RESULT_NODE_HEIGHT;
  }
  if (role === "result" || role === "material") {
    return node.kind === "image" || node.kind === "video" ? 560 : 220;
  }
  return 220;
}

function nodeCreationOrder(nodes: CanvasNode[]) {
  const sourceOrder = new Map(nodes.map((node, index) => [node.id, index]));
  return [...nodes].sort(
    (first, second) =>
      (first.createdAt ?? sourceOrder.get(first.id) ?? 0) -
      (second.createdAt ?? sourceOrder.get(second.id) ?? 0),
  );
}

export function arrangeNodesWithoutOverlap(
  nodes: CanvasNode[],
  mode: "time" | "type",
  measuredHeights: Record<string, number> = {},
) {
  if (nodes.length < 2) return nodes;
  const startX = Math.min(...nodes.map((node) => node.x));
  const startY = Math.min(...nodes.map((node) => node.y));

  if (mode === "type") {
    const kindOrder = ["text", "image", "video", "audio", "document"] as const;
    const positions = new Map<string, { x: number; y: number }>();
    let columnX = startX;

    for (const kind of kindOrder) {
      const columnNodes = nodes.filter((node) => node.kind === kind);
      if (!columnNodes.length) continue;
      let rowY = startY;
      let columnWidth = 0;
      for (const node of columnNodes) {
        positions.set(node.id, { x: columnX, y: rowY });
        columnWidth = Math.max(columnWidth, widthForNode(node));
        rowY +=
          autoLayoutHeightForNode(node, measuredHeights) +
          AUTO_LAYOUT_ROW_GAP;
      }
      columnX += columnWidth + AUTO_LAYOUT_COLUMN_GAP;
    }

    return nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, ...position } : node;
    });
  }

  const ordered = nodeCreationOrder(nodes);
  const arranged: CanvasNode[] = [];
  let rowY = startY;
  for (let rowStart = 0; rowStart < ordered.length; rowStart += AUTO_LAYOUT_COLUMNS) {
    const row = ordered.slice(rowStart, rowStart + AUTO_LAYOUT_COLUMNS);
    let columnX = startX;
    let rowHeight = 0;
    for (const node of row) {
      arranged.push({ ...node, x: columnX, y: rowY });
      columnX += widthForNode(node) + AUTO_LAYOUT_COLUMN_GAP;
      rowHeight = Math.max(
        rowHeight,
        autoLayoutHeightForNode(node, measuredHeights),
      );
    }
    rowY += rowHeight + AUTO_LAYOUT_ROW_GAP;
  }
  return arranged;
}
