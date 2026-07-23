"use client";

import {
  Check,
  ChevronsLeft,
  Map as MapIcon,
  Maximize2,
  PanelLeftOpen,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { canvasList } from "../data";
import type { IntentOSController } from "../hooks/use-intent-os";
import {
  centeredPortPoint,
  fitWorldBounds,
  screenToWorld,
  unionBounds,
  visibleWorldBounds,
  zoomViewportAt,
  type ViewportTransform,
  type WorldBounds,
} from "../lib/canvas-geometry";
import type { NodeKind } from "../types";
import { CanvasContextMenu } from "./canvas-context-menu";
import { CanvasDrawer } from "./canvas-drawer";
import { IconButton } from "./icon-button";
import { IntentConsole } from "./intent-console";
import { NodeCard } from "./node-card";
import { ZoomControls } from "./zoom-controls";

const NODE_WIDTH = 264;
const NODE_FIT_HEIGHT = 220;
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 124;
const MINIMAP_PADDING = 8;
const CONTEXT_MENU_WIDTH = 286;
const CONTEXT_MENU_HEIGHT = 462;

interface ContextMenuState {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  opensLeft: boolean;
}

interface ConnectionDraft {
  sourceId: string;
  current: { x: number; y: number };
}

interface CanvasViewProps {
  os: IntentOSController;
}

function lineStyle(
  start: { x: number; y: number },
  end: { x: number; y: number },
): CSSProperties {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const angle = Math.atan2(end.y - start.y, end.x - start.x) * (180 / Math.PI);
  return {
    left: start.x,
    top: start.y,
    width: distance,
    transform: `rotate(${angle}deg)`,
  };
}

function edgeStyle(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sourceHeight: number,
  targetHeight: number,
): CSSProperties {
  const start = centeredPortPoint(
    source,
    { width: NODE_WIDTH, height: sourceHeight },
    "output",
  );
  const end = centeredPortPoint(
    target,
    { width: NODE_WIDTH, height: targetHeight },
    "input",
  );
  return lineStyle(start, end);
}

function expandBounds(bounds: WorldBounds, amount: number): WorldBounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

export function CanvasView({ os }: CanvasViewProps) {
  const activeCanvas =
    canvasList.find((canvas) => canvas.id === os.activeCanvasId) ?? canvasList[0];
  const workspaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAnchorRef = useRef({ x: 0, y: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const [isPanning, setIsPanning] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [connectionDraft, setConnectionDraft] =
    useState<ConnectionDraft | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const initialFitDone = useRef(false);
  const panGesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const viewportRef = useRef<ViewportTransform>({
    x: pan.x,
    y: pan.y,
    zoom: os.zoom,
  });
  viewportRef.current = { x: pan.x, y: pan.y, zoom: os.zoom };

  const nodeBounds = useMemo<WorldBounds>(() => {
    if (!os.nodes.length) {
      return { minX: -160, minY: -100, maxX: 160, maxY: 100 };
    }
    return {
      minX: Math.min(...os.nodes.map((node) => node.x)),
      minY: Math.min(...os.nodes.map((node) => node.y)),
      maxX: Math.max(...os.nodes.map((node) => node.x + NODE_WIDTH)),
      maxY: Math.max(
        ...os.nodes.map(
          (node) => node.y + (nodeHeights[node.id] ?? NODE_FIT_HEIGHT),
        ),
      ),
    };
  }, [nodeHeights, os.nodes]);

  const handleNodeSizeChange = useCallback(
    (nodeId: string, height: number) => {
      const roundedHeight = Math.max(1, Math.round(height));
      setNodeHeights((current) =>
        current[nodeId] === roundedHeight
          ? current
          : { ...current, [nodeId]: roundedHeight },
      );
    },
    [],
  );

  const commitViewport = useCallback(
    (next: ViewportTransform) => {
      viewportRef.current = next;
      setPan({ x: next.x, y: next.y });
      os.setZoom(next.zoom);
    },
    [os.setZoom],
  );

  const fitView = useCallback(() => {
    if (stageSize.width <= 1 || stageSize.height <= 1) return;
    commitViewport(
      fitWorldBounds(expandBounds(nodeBounds, 24), stageSize, 56),
    );
  }, [commitViewport, nodeBounds, stageSize]);

  const zoomAtCenter = useCallback(
    (nextZoom: number) => {
      commitViewport(
        zoomViewportAt(viewportRef.current, nextZoom, {
          x: stageSize.width / 2,
          y: stageSize.height / 2,
        }),
      );
    },
    [commitViewport, stageSize],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const rect = stage.getBoundingClientRect();
      setStageSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const canvasStage = stage;
    function wheel(event: WheelEvent) {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          ".schema-fields, .canvas-toolbar, .zoom-controls, .minimap, .minimap-toggle, .canvas-context-menu, input, textarea, select",
        )
      ) {
        return;
      }
      event.preventDefault();
      const current = viewportRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = canvasStage.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.0016);
        commitViewport(
          zoomViewportAt(current, current.zoom * factor, {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          }),
        );
        return;
      }
      const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
      const vertical = event.shiftKey ? 0 : event.deltaY;
      const next = {
        ...current,
        x: current.x - horizontal,
        y: current.y - vertical,
      };
      viewportRef.current = next;
      setPan({ x: next.x, y: next.y });
    }
    canvasStage.addEventListener("wheel", wheel, { passive: false });
    return () => canvasStage.removeEventListener("wheel", wheel);
  }, [commitViewport]);

  useEffect(() => {
    if (
      initialFitDone.current ||
      stageSize.width < 120 ||
      stageSize.height < 120
    ) {
      return;
    }
    initialFitDone.current = true;
    commitViewport(
      fitWorldBounds(expandBounds(nodeBounds, 24), stageSize, 48),
    );
  }, [commitViewport, nodeBounds, stageSize]);

  useEffect(() => {
    function editableTarget(target: EventTarget | null) {
      return (
        target instanceof HTMLElement &&
        Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
      );
    }
    function keyDown(event: KeyboardEvent) {
      if (editableTarget(event.target)) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        os.undoCanvas();
        return;
      }
      if (event.key === "Escape" && connectionDraft) {
        event.preventDefault();
        setConnectionDraft(null);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (selectedEdgeId) {
          os.deleteEdge(selectedEdgeId);
          setSelectedEdgeId(null);
        } else {
          os.deleteSelected();
        }
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(true);
      }
      if (event.key === "0") {
        event.preventDefault();
        fitView();
      }
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomAtCenter(viewportRef.current.zoom + 10);
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomAtCenter(viewportRef.current.zoom - 10);
      }
    }
    function keyUp(event: KeyboardEvent) {
      if (event.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [
    connectionDraft,
    fitView,
    os.deleteEdge,
    os.deleteSelected,
    os.undoCanvas,
    selectedEdgeId,
    zoomAtCenter,
  ]);

  function isCanvasOverlay(target: HTMLElement) {
    return Boolean(
      target.closest(
        ".canvas-node, .canvas-toolbar, .zoom-controls, .minimap, .minimap-toggle, .canvas-context-menu, .canvas-mode-chip, .canvas-navigation-hint, .open-console-button",
      ),
    );
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const emptyCanvas = !isCanvasOverlay(target);
    const shouldPan =
      event.button === 1 ||
      (event.button === 0 &&
        (emptyCanvas || os.activeTool === "hand" || spaceHeld));
    if (!shouldPan || target.closest("input, textarea, select, button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportRef.current.x,
      originY: viewportRef.current.y,
      moved: false,
    };
    setIsPanning(true);
  }

  function handleStageContextMenu(
    event: React.MouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (
      target.closest(
        ".canvas-toolbar, .zoom-controls, .minimap, .minimap-toggle, .canvas-mode-chip, .canvas-navigation-hint, .open-console-button",
      )
    ) {
      setContextMenu(null);
      return;
    }
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const screenPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const worldPoint = screenToWorld(screenPoint, viewportRef.current);
    const maxX = Math.max(8, rect.width - CONTEXT_MENU_WIDTH - 8);
    const maxY = Math.max(8, rect.height - CONTEXT_MENU_HEIGHT - 8);
    setContextMenu({
      x: Math.max(8, Math.min(screenPoint.x, maxX)),
      y: Math.max(8, Math.min(screenPoint.y, maxY)),
      worldX: worldPoint.x,
      worldY: worldPoint.y,
      opensLeft:
        screenPoint.x + CONTEXT_MENU_WIDTH * 2 + 20 > rect.width,
    });
  }

  function clientToWorld(clientX: number, clientY: number) {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return screenToWorld(
      { x: clientX - rect.left, y: clientY - rect.top },
      viewportRef.current,
    );
  }

  function beginConnection(
    sourceId: string,
    clientX: number,
    clientY: number,
  ) {
    const current = clientToWorld(clientX, clientY);
    if (!current) return;
    setSelectedEdgeId(null);
    setConnectionDraft({ sourceId, current });
  }

  function handleStagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      const current = clientToWorld(event.clientX, event.clientY);
      if (current) {
        setConnectionDraft((draft) =>
          draft ? { ...draft, current } : draft,
        );
      }
      return;
    }
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.hypot(deltaX, deltaY) > 2) gesture.moved = true;
    const next = {
      ...viewportRef.current,
      x: gesture.originX + deltaX,
      y: gesture.originY + deltaY,
    };
    viewportRef.current = next;
    setPan({ x: next.x, y: next.y });
  }

  function endStagePan(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".port-input[data-node-id]");
      const targetId = target?.dataset.nodeId;
      if (targetId) {
        os.connectNodes(connectionDraft.sourceId, targetId);
      }
      setConnectionDraft(null);
      return;
    }
    const gesture = panGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.moved && event.button === 0) {
      os.setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panGesture.current = null;
    setIsPanning(false);
  }

  function cancelStagePointer(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      setConnectionDraft(null);
      return;
    }
    endStagePan(event);
  }

  function addNodeAtContext(
    kind: NodeKind,
    preset?: Parameters<typeof os.addNode>[2],
  ) {
    if (!contextMenu) return;
    os.addNode(
      kind,
      { x: contextMenu.worldX, y: contextMenu.worldY },
      preset,
    );
  }

  function uploadAtContext() {
    if (!contextMenu) return;
    uploadAnchorRef.current = {
      x: contextMenu.worldX,
      y: contextMenu.worldY,
    };
    uploadInputRef.current?.click();
  }

  async function handleCanvasUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind: NodeKind = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : "text";
    let prompt = `从本地导入 ${file.name}，可继续补充处理要求。`;
    if (
      kind === "text" &&
      file.size <= 2_000_000 &&
      (file.type.startsWith("text/") ||
        ["md", "txt", "json"].includes(extension))
    ) {
      const preview = (await file.text()).trim().slice(0, 360);
      if (preview) prompt = preview;
    }
    const sizeLabel =
      file.size >= 1_048_576
        ? `${(file.size / 1_048_576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    os.addNode(kind, uploadAnchorRef.current, {
      title: file.name,
      prompt,
      result: `本地文件 · ${sizeLabel}`,
      parameters: {
        source: "local-upload",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      },
    });
  }

  const scale = os.zoom / 100;
  const gridStyle: CSSProperties = {
    backgroundPosition: `${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px, ${pan.x}px ${pan.y}px`,
    backgroundSize: `${32 * scale}px ${32 * scale}px, ${32 * scale}px ${32 * scale}px, ${8 * scale}px ${8 * scale}px`,
  };
  const worldStyle: CSSProperties = {
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
  };

  const visibleBounds = visibleWorldBounds(viewportRef.current, stageSize);
  const minimapBounds = expandBounds(
    unionBounds(nodeBounds, visibleBounds),
    80,
  );
  const minimapWorldWidth = Math.max(
    1,
    minimapBounds.maxX - minimapBounds.minX,
  );
  const minimapWorldHeight = Math.max(
    1,
    minimapBounds.maxY - minimapBounds.minY,
  );
  const minimapScale = Math.min(
    (MINIMAP_WIDTH - MINIMAP_PADDING * 2) / minimapWorldWidth,
    (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / minimapWorldHeight,
  );
  const minimapOffsetX =
    (MINIMAP_WIDTH - minimapWorldWidth * minimapScale) / 2;
  const minimapOffsetY =
    (MINIMAP_HEIGHT - minimapWorldHeight * minimapScale) / 2;

  function minimapX(worldX: number) {
    return minimapOffsetX + (worldX - minimapBounds.minX) * minimapScale;
  }
  function minimapY(worldY: number) {
    return minimapOffsetY + (worldY - minimapBounds.minY) * minimapScale;
  }
  function recenterFromMinimap(clientX: number, clientY: number, element: HTMLDivElement) {
    const rect = element.getBoundingClientRect();
    const worldX =
      (clientX - rect.left - minimapOffsetX) / minimapScale +
      minimapBounds.minX;
    const worldY =
      (clientY - rect.top - minimapOffsetY) / minimapScale +
      minimapBounds.minY;
    const current = viewportRef.current;
    const next = {
      ...current,
      x: stageSize.width / 2 - worldX * (current.zoom / 100),
      y: stageSize.height / 2 - worldY * (current.zoom / 100),
    };
    viewportRef.current = next;
    setPan({ x: next.x, y: next.y });
  }

  const connectionSource = connectionDraft
    ? os.nodes.find((node) => node.id === connectionDraft.sourceId)
    : null;
  const stageClass = [
    "canvas-stage",
    isPanning ? "is-panning" : "",
    connectionDraft ? "is-connecting" : "",
    minimapOpen ? "" : "is-minimap-collapsed",
    os.activeTool === "hand" || spaceHeld ? "is-pan-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="canvas-view">
      <CanvasDrawer
        open={os.drawerOpen}
        activeCanvasId={os.activeCanvasId}
        onClose={() => os.setDrawerOpen(false)}
        onSelect={os.setActiveCanvasId}
      />

      <section
        ref={workspaceRef}
        className="canvas-workspace"
        aria-label="无限画布"
      >
        <header className="canvas-header">
          <div className="canvas-breadcrumbs">
            {!os.drawerOpen && (
              <IconButton label="打开画布管理" onClick={() => os.setDrawerOpen(true)}>
                <PanelLeftOpen size={17} />
              </IconButton>
            )}
            <span>品牌内容实验室</span>
            <ChevronsLeft size={13} className="breadcrumb-chevron" />
            <strong>{activeCanvas.title}</strong>
            <span className="save-indicator">
              <Check size={13} /> 已保存
            </span>
          </div>
          <div className="canvas-header-actions">
            <span className="viewer-stack" aria-label="2 位协作者">
              <i>洛</i>
              <i>林</i>
            </span>
            <button type="button" className="secondary-button compact">
              <Share2 size={15} /> 分享
            </button>
            <IconButton
              label="全屏画布"
              onClick={() => void workspaceRef.current?.requestFullscreen()}
            >
              <Maximize2 size={17} />
            </IconButton>
          </div>
        </header>

        <div
          ref={stageRef}
          className={stageClass}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={endStagePan}
          onPointerCancel={cancelStagePointer}
          onContextMenu={handleStageContextMenu}
        >
          <div className="canvas-grid" style={gridStyle} aria-hidden="true" />

          <div className="canvas-content" style={worldStyle}>
            {os.edges.map((edge) => {
              const source = os.nodes.find((node) => node.id === edge.source);
              const target = os.nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const flowing =
                source.status === "running" || target.status === "running";
              const selected = selectedEdgeId === edge.id;
              return (
                <div
                  key={edge.id}
                  className={`edge-line ${flowing ? "is-flowing" : ""} ${selected ? "is-selected" : ""}`}
                  style={edgeStyle(
                    source,
                    target,
                    nodeHeights[source.id] ?? 156,
                    nodeHeights[target.id] ?? 156,
                  )}
                  role="button"
                  tabIndex={0}
                  aria-label={`连接：${source.title} 到 ${target.title}`}
                  aria-pressed={selected}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedEdgeId(edge.id);
                    os.setSelectedNodeId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelectedEdgeId(edge.id);
                    os.setSelectedNodeId(null);
                  }}
                >
                  <span />
                  {selected && (
                    <button
                      type="button"
                      className="edge-remove-button"
                      aria-label="取消连接"
                      title="取消连接"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        os.deleteEdge(edge.id);
                        setSelectedEdgeId(null);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
            })}

            {connectionDraft && connectionSource && (
              <div
                className="edge-line edge-line-draft"
                style={lineStyle(
                  centeredPortPoint(
                    connectionSource,
                    {
                      width: NODE_WIDTH,
                      height: nodeHeights[connectionSource.id] ?? 156,
                    },
                    "output",
                  ),
                  connectionDraft.current,
                )}
                aria-hidden="true"
              />
            )}

            {os.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={node.id === os.selectedNodeId}
                multiSelected={os.selectedNodeIds.includes(node.id)}
                zoom={os.zoom}
                panMode={os.activeTool === "hand" || spaceHeld}
                capabilities={os.capabilities}
                models={os.models}
                onSelect={(additive) => {
                  setSelectedEdgeId(null);
                  os.selectNode(node.id, additive);
                }}
                onMoveStart={os.beginNodeMove}
                onMove={(x, y) => os.moveNode(node.id, x, y)}
                onUpdate={(patch) => os.updateNode(node.id, patch)}
                onSizeChange={handleNodeSizeChange}
                onConnectionStart={(clientX, clientY) =>
                  beginConnection(node.id, clientX, clientY)
                }
                connectionTargetAvailable={Boolean(
                  connectionDraft &&
                    connectionDraft.sourceId !== node.id &&
                    !os.edges.some(
                      (edge) =>
                        edge.source === connectionDraft.sourceId &&
                        edge.target === node.id,
                    ),
                )}
              />
            ))}
          </div>

          <div className="canvas-mode-chip">
            <Sparkles size={14} />
            <span>无限画布</span>
            <code>
              {Math.round(visibleBounds.minX)}, {Math.round(visibleBounds.minY)}
            </code>
          </div>

          {minimapOpen ? (
            <div
              className="minimap"
              aria-label="无限画布小地图，点击或拖动定位"
              onPointerDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                recenterFromMinimap(
                  event.clientX,
                  event.clientY,
                  event.currentTarget,
                );
              }}
              onPointerMove={(event) => {
                if (event.buttons !== 1) return;
                recenterFromMinimap(
                  event.clientX,
                  event.clientY,
                  event.currentTarget,
                );
              }}
            >
              <button
                type="button"
                className="minimap-close"
                aria-label="收起地图导航"
                title="收起地图导航"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setMinimapOpen(false);
                }}
              >
                <X size={16} />
              </button>
              <span
                className="minimap-viewport"
                style={{
                  left: minimapX(visibleBounds.minX),
                  top: minimapY(visibleBounds.minY),
                  width: Math.max(
                    8,
                    (visibleBounds.maxX - visibleBounds.minX) * minimapScale,
                  ),
                  height: Math.max(
                    6,
                    (visibleBounds.maxY - visibleBounds.minY) * minimapScale,
                  ),
                }}
              />
              {os.nodes.map((node) => (
                <i
                  key={node.id}
                  style={{
                    left: minimapX(node.x),
                    top: minimapY(node.y),
                    width: Math.max(5, NODE_WIDTH * minimapScale),
                    height: Math.max(
                      4,
                      (nodeHeights[node.id] ?? 156) * minimapScale,
                    ),
                  }}
                  className={`mini-${node.kind}`}
                />
              ))}
            </div>
          ) : (
            <button
              type="button"
              className="minimap-toggle"
              aria-label="展开地图导航"
              title="展开地图导航"
              onClick={() => setMinimapOpen(true)}
            >
              <MapIcon size={23} />
            </button>
          )}

          <div className="canvas-navigation-hint">
            拖动空白处平移 · 右键快捷菜单 · Ctrl/⌘ + 滚轮缩放 · Space 抓手 · 0 适配全部
          </div>

          <ZoomControls
            zoom={os.zoom}
            onFit={fitView}
            onReset={() => zoomAtCenter(100)}
            onZoomIn={() => zoomAtCenter(viewportRef.current.zoom + 10)}
            onZoomOut={() => zoomAtCenter(viewportRef.current.zoom - 10)}
          />

          <input
            ref={uploadInputRef}
            className="canvas-file-input"
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            accept=".txt,.md,.json,.pdf,text/*,image/*,video/*"
            onChange={handleCanvasUpload}
          />

          {contextMenu && (
            <CanvasContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              opensLeft={contextMenu.opensLeft}
              capabilities={os.capabilities}
              packages={os.packages}
              canUndo={os.canUndo}
              multiSelectActive={os.activeTool === "multi-select"}
              arrangeMode={os.arrangeMode}
              onAddNode={addNodeAtContext}
              onAddCapability={(capability) =>
                addNodeAtContext(capability.modality, {
                  title: capability.title,
                  prompt: capability.description,
                  capabilityId: capability.id,
                })
              }
              onAddPlugin={(plugin) =>
                addNodeAtContext("text", {
                  title: plugin.name,
                  prompt: plugin.description,
                  parameters: {
                    packageId: plugin.id,
                    runtimeType: plugin.runtimeType,
                  },
                })
              }
              onUndo={os.undoCanvas}
              onToggleMultiSelect={() => {
                if (os.activeTool === "multi-select") {
                  os.setActiveTool("select");
                  os.setSelectedNodeId(os.selectedNodeId);
                  return;
                }
                os.setActiveTool("multi-select");
              }}
              onArrange={os.arrangeNodes}
              onUpload={uploadAtContext}
              onOpenExtensions={() => os.setView("capabilities")}
              onClose={() => setContextMenu(null)}
            />
          )}

          {!os.consoleOpen && (
            <button
              type="button"
              className="open-console-button"
              onClick={() => os.setConsoleOpen(true)}
            >
              <img
                src="/xiaoluo-intent-mark.png"
                alt=""
                className="intent-brand-icon"
              />
              Intent
            </button>
          )}
        </div>
      </section>

      {os.consoleOpen && (
        <IntentConsole
          messages={os.messages}
          plan={os.plan}
          isPlanning={os.isPlanning}
          runState={os.runState}
          onClose={() => os.setConsoleOpen(false)}
          onSubmit={os.submitIntent}
          onConfirmPlan={os.confirmPlan}
          onStart={os.startRun}
          onPause={os.pauseRun}
          onCancel={os.cancelRun}
        />
      )}
    </div>
  );
}
