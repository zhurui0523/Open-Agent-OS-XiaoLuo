export interface Point {
  x: number;
  y: number;
}

export interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type PortSide = "input" | "output";

export const MIN_CANVAS_ZOOM = 15;
export const MAX_CANVAS_ZOOM = 300;

export function clampCanvasZoom(value: number) {
  return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, value));
}

export function screenToWorld(
  point: Point,
  viewport: ViewportTransform,
): Point {
  const scale = viewport.zoom / 100;
  return {
    x: (point.x - viewport.x) / scale,
    y: (point.y - viewport.y) / scale,
  };
}

export function worldToScreen(
  point: Point,
  viewport: ViewportTransform,
): Point {
  const scale = viewport.zoom / 100;
  return {
    x: point.x * scale + viewport.x,
    y: point.y * scale + viewport.y,
  };
}

export function centeredPortPoint(
  position: Point,
  size: Size,
  side: PortSide,
): Point {
  return {
    x: position.x + (side === "output" ? size.width : 0),
    y: position.y + size.height / 2,
  };
}

export function indexedPortPoint(
  position: Point,
  size: Size,
  side: PortSide,
  index: number,
  count: number,
): Point {
  const gap = 22;
  const offset = (index - (Math.max(1, count) - 1) / 2) * gap;
  return {
    x: position.x + (side === "output" ? size.width : 0),
    y: position.y + size.height / 2 + offset,
  };
}

export function zoomViewportAt(
  viewport: ViewportTransform,
  nextZoom: number,
  anchor: Point,
): ViewportTransform {
  const zoom = clampCanvasZoom(nextZoom);
  const worldAnchor = screenToWorld(anchor, viewport);
  const nextScale = zoom / 100;
  return {
    zoom,
    x: anchor.x - worldAnchor.x * nextScale,
    y: anchor.y - worldAnchor.y * nextScale,
  };
}

export function visibleWorldBounds(
  viewport: ViewportTransform,
  size: Size,
): WorldBounds {
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport);
  const bottomRight = screenToWorld(
    { x: size.width, y: size.height },
    viewport,
  );
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

export function fitWorldBounds(
  bounds: WorldBounds,
  size: Size,
  padding = 72,
): ViewportTransform {
  const worldWidth = Math.max(1, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, size.width - padding * 2);
  const availableHeight = Math.max(1, size.height - padding * 2);
  const zoom = clampCanvasZoom(
    Math.min(availableWidth / worldWidth, availableHeight / worldHeight, 1.25) *
      100,
  );
  const scale = zoom / 100;
  return {
    zoom: Math.round(zoom),
    x: (size.width - worldWidth * scale) / 2 - bounds.minX * scale,
    y: (size.height - worldHeight * scale) / 2 - bounds.minY * scale,
  };
}

export function unionBounds(
  first: WorldBounds,
  second: WorldBounds,
): WorldBounds {
  return {
    minX: Math.min(first.minX, second.minX),
    minY: Math.min(first.minY, second.minY),
    maxX: Math.max(first.maxX, second.maxX),
    maxY: Math.max(first.maxY, second.maxY),
  };
}
