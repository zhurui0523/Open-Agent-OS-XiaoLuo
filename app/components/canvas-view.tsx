"use client";

import {
  Check,
  ChevronsLeft,
  CircleAlert,
  Map as MapIcon,
  Layers3,
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
import type { IntentOSController } from "../hooks/use-intent-os";
import {
  fitWorldBounds,
  screenToWorld,
  unionBounds,
  visibleWorldBounds,
  zoomViewportAt,
  type ViewportTransform,
  type WorldBounds,
} from "../lib/canvas-geometry";
import { CanvasSpatialIndex } from "../lib/canvas-spatial-index";
import type {
  NodeKind,
  PortDataType,
} from "../types";
import { CanvasContextMenu } from "./canvas-context-menu";
import {
  CanvasCollaborationPanel,
  useCanvasCollaboration,
} from "./canvas-collaboration";
import { CanvasDrawer } from "./canvas-drawer";
import { CanvasEdgeLayer } from "./canvas-edge-layer";
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
const CONTEXT_MENU_HEIGHT = 700;

interface ContextMenuState {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  opensLeft: boolean;
}

interface ConnectionDraft {
  sourceId: string;
  sourcePortId: string;
  dataType: PortDataType;
  current: { x: number; y: number };
}

interface CanvasViewProps {
  os: IntentOSController;
}

function expandBounds(bounds: WorldBounds, amount: number): WorldBounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

export function CanvasView(props: CanvasViewProps) {
  return (
    <CanvasWorkspace
      key={props.os.activeCanvasId || "cloud-canvas-loading"}
      {...props}
    />
  );
}

function CanvasWorkspace({ os }: CanvasViewProps) {
  const {
    addNode,
    copySelected,
    deleteEdge,
    deleteSelected,
    pasteCopied,
    redoCanvas,
    setCanvasViewport,
    undoCanvas,
  } = os;
  const {
    gesturePreset,
    invertZoom,
    keyboardShortcuts,
    zoomSensitivity,
  } = os.preferences;
  const activeCanvas =
    os.canvases.find((canvas) => canvas.id === os.activeCanvasId) ?? {
      id: "",
      title: "正在加载云画布",
      project: os.projectName,
      nodes: 0,
      updatedAt: new Date().toISOString(),
    };
  const workspaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadAnchorRef = useRef({ x: 0, y: 0 });
  const [pan, setPan] = useState({
    x: os.canvasViewport.x,
    y: os.canvasViewport.y,
  });
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const [isPanning, setIsPanning] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [connectionDraft, setConnectionDraft] =
    useState<ConnectionDraft | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const initialFitDone = useRef(false);
  const panGesture = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const selectionPointerId = useRef<number | null>(null);
  const viewportRef = useRef<ViewportTransform>({
    x: pan.x,
    y: pan.y,
    zoom: os.zoom,
  });
  const panFrame = useRef<number | null>(null);
  const pendingPan = useRef<{ x: number; y: number } | null>(null);
  const collaborationCursorRef = useRef<{ x: number; y: number } | null>(
    null,
  );
  const collaboration = useCanvasCollaboration({
    canvasId: os.activeCanvasId,
    sessionId: os.collaborationSessionId,
    selectedNodeIds: os.selectedNodeIds,
    canvasRevision: os.canvasRevision,
    cursorRef: collaborationCursorRef,
  });

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
      setCanvasViewport(next);
    },
    [setCanvasViewport],
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

  useEffect(
    () => () => {
      if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
    },
    [],
  );

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
      const wheelZoom =
        gesturePreset === "zoom-wheel" ||
        event.ctrlKey ||
        event.metaKey;
      if (wheelZoom) {
        const rect = canvasStage.getBoundingClientRect();
        const sensitivity =
          zoomSensitivity === "slow"
            ? 0.0009
            : zoomSensitivity === "fast"
              ? 0.0024
              : 0.0016;
        const direction = invertZoom ? -1 : 1;
        const factor = Math.exp(-event.deltaY * sensitivity * direction);
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
      setCanvasViewport(next);
    }
    canvasStage.addEventListener("wheel", wheel, { passive: false });
    return () => canvasStage.removeEventListener("wheel", wheel);
  }, [
    commitViewport,
    gesturePreset,
    invertZoom,
    setCanvasViewport,
    zoomSensitivity,
  ]);

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
      if (!keyboardShortcuts) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "y" ||
          (event.key.toLowerCase() === "z" && event.shiftKey))
      ) {
        event.preventDefault();
        redoCanvas();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "c"
      ) {
        if (copySelected()) event.preventDefault();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "v"
      ) {
        if (pasteCopied()) event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (connectionDraft) setConnectionDraft(null);
        setContextMenu(null);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (selectedEdgeId) {
          deleteEdge(selectedEdgeId);
          setSelectedEdgeId(null);
        } else {
          deleteSelected();
        }
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        setSpaceHeld(true);
      }
      if (event.key.toLowerCase() === "f" || event.key === "0") {
        event.preventDefault();
        fitView();
      }
      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        setMinimapOpen((current) => !current);
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        ["1", "2", "3", "4", "5"].includes(event.key)
      ) {
        event.preventDefault();
        const kind: NodeKind =
          event.key === "1"
            ? "text"
            : event.key === "2"
              ? "image"
              : event.key === "3"
                ? "video"
                : event.key === "4"
                  ? "audio"
                  : "document";
        const center = screenToWorld(
          { x: stageSize.width / 2, y: stageSize.height / 2 },
          viewportRef.current,
        );
        addNode(kind, {
          x: center.x - NODE_WIDTH / 2,
          y: center.y - NODE_FIT_HEIGHT / 2,
        });
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
    addNode,
    copySelected,
    deleteEdge,
    deleteSelected,
    keyboardShortcuts,
    pasteCopied,
    redoCanvas,
    selectedEdgeId,
    stageSize.height,
    stageSize.width,
    undoCanvas,
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
    if (
      event.button === 0 &&
      emptyCanvas &&
      os.activeTool === "multi-select" &&
      !spaceHeld
    ) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      selectionPointerId.current = event.pointerId;
      setSelectionBox({ startX: x, startY: y, currentX: x, currentY: y });
      return;
    }
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
    sourcePortId: string,
    dataType: PortDataType,
    clientX: number,
    clientY: number,
  ) {
    const current = clientToWorld(clientX, clientY);
    if (!current) return;
    setSelectedEdgeId(null);
    setConnectionDraft({ sourceId, sourcePortId, dataType, current });
  }

  function handleStagePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const collaborationCursor = clientToWorld(event.clientX, event.clientY);
    if (collaborationCursor) {
      collaborationCursorRef.current = collaborationCursor;
      collaboration.scheduleHeartbeat();
    }
    if (connectionDraft) {
      const current = clientToWorld(event.clientX, event.clientY);
      if (current) {
        setConnectionDraft((draft) =>
          draft ? { ...draft, current } : draft,
        );
      }
      return;
    }
    if (selectionPointerId.current === event.pointerId && selectionBox) {
      const rect = event.currentTarget.getBoundingClientRect();
      setSelectionBox((current) =>
        current
          ? {
              ...current,
              currentX: event.clientX - rect.left,
              currentY: event.clientY - rect.top,
            }
          : current,
      );
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
    pendingPan.current = { x: next.x, y: next.y };
    if (panFrame.current === null) {
      panFrame.current = requestAnimationFrame(() => {
        if (pendingPan.current) setPan(pendingPan.current);
        pendingPan.current = null;
        panFrame.current = null;
      });
    }
  }

  function endStagePan(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(".port-input[data-node-id]");
      const targetId = target?.dataset.nodeId;
      const targetPortId = target?.dataset.portId;
      const targetTypes = target?.dataset.portTypes?.split(",") ?? [];
      if (
        targetId &&
        targetPortId &&
        targetTypes.includes(connectionDraft.dataType)
      ) {
        os.connectNodes(
          connectionDraft.sourceId,
          targetId,
          connectionDraft.sourcePortId,
          targetPortId,
        );
      }
      setConnectionDraft(null);
      return;
    }
    if (selectionPointerId.current === event.pointerId && selectionBox) {
      const left = Math.min(selectionBox.startX, selectionBox.currentX);
      const right = Math.max(selectionBox.startX, selectionBox.currentX);
      const top = Math.min(selectionBox.startY, selectionBox.currentY);
      const bottom = Math.max(selectionBox.startY, selectionBox.currentY);
      const start = screenToWorld({ x: left, y: top }, viewportRef.current);
      const end = screenToWorld({ x: right, y: bottom }, viewportRef.current);
      os.selectNodes(
        os.nodes
          .filter((node) => {
            const height = nodeHeights[node.id] ?? NODE_FIT_HEIGHT;
            return !(
              node.x + NODE_WIDTH < start.x ||
              node.x > end.x ||
              node.y + height < start.y ||
              node.y > end.y
            );
          })
          .map((node) => node.id),
      );
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      selectionPointerId.current = null;
      setSelectionBox(null);
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
    setPan({ x: viewportRef.current.x, y: viewportRef.current.y });
    os.setCanvasViewport(viewportRef.current);
  }

  function cancelStagePointer(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      setConnectionDraft(null);
      return;
    }
    if (selectionPointerId.current === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      selectionPointerId.current = null;
      setSelectionBox(null);
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

  async function shareCanvas() {
    if (!os.activeCanvasId) return;
    const choice = window.prompt(
      "输入分享类型：readonly（只读链接）或 workflow（Workflow 模板）",
      "readonly",
    );
    if (choice === null) return;
    const mode =
      choice.trim().toLowerCase() === "workflow"
        ? "workflow"
        : "read_only";
    try {
      const response = await fetch("/api/v2/canvases/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canvasId: os.activeCanvasId,
          mode,
          expiresInDays: 30,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        share?: { url: string };
        error?: string;
      };
      if (!response.ok || !payload.share?.url) {
        throw new Error(payload.error ?? "创建分享失败");
      }
      await navigator.clipboard.writeText(payload.share.url).catch(() => undefined);
      window.prompt("分享链接已生成并尝试复制，可手动复制：", payload.share.url);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : "创建分享失败");
    }
  }

  async function handleCanvasUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    let asset;
    try {
      asset = await os.uploadAsset(file, {
        sourceType: "canvas-upload",
        sourceRef: os.activeCanvasId,
        tags: ["画布上传"],
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "文件上传失败");
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind: NodeKind = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
          ? "audio"
          : file.type.startsWith("text/") ||
              ["md", "txt", "json"].includes(extension)
            ? "text"
            : "document";
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
      result: `已进入 AI 文件系统 · ${sizeLabel}`,
      parameters: {
        source: "asset-kernel",
        assetId: asset.id,
        assetUri: asset.uri,
        assetContentUrl: asset.contentUrl,
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

  const visibleBounds = visibleWorldBounds(
    { x: pan.x, y: pan.y, zoom: os.zoom },
    stageSize,
  );
  const renderBounds = expandBounds(visibleBounds, 420);
  const spatialIndex = useMemo(
    () => new CanvasSpatialIndex(os.nodes, os.edges, nodeHeights),
    [nodeHeights, os.edges, os.nodes],
  );
  const visibleNodeIds = spatialIndex.queryNodeIds(renderBounds);
  os.selectedNodeIds.forEach((id) => visibleNodeIds.add(id));
  if (connectionDraft?.sourceId) visibleNodeIds.add(connectionDraft.sourceId);
  const visibleNodes = [...visibleNodeIds]
    .map((id) => spatialIndex.nodeById.get(id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));
  const visibleEdgeIds = spatialIndex.queryEdgeIds(expandBounds(visibleBounds, 360));
  if (selectedEdgeId) visibleEdgeIds.add(selectedEdgeId);
  const visibleEdges = [...visibleEdgeIds]
    .map((id) => spatialIndex.edgeById.get(id))
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));
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
        projectId={os.projectId}
        canvases={os.canvases}
        workspaceName={os.workspaceName}
        projectName={os.projectName}
        projects={os.projects}
        onClose={() => os.setDrawerOpen(false)}
        onSelect={os.setActiveCanvasId}
        onCreate={() => void os.createCanvas()}
        onRename={os.renameCanvas}
        onArchive={os.archiveCanvas}
        onDelete={os.deleteCanvas}
        onDuplicate={os.duplicateCanvas}
        onRestore={os.restoreCanvas}
        onStar={os.toggleCanvasStar}
        onCreateSnapshot={os.createCanvasSnapshot}
        onRestoreSnapshot={os.restoreCanvasSnapshot}
        onSwitchProject={os.switchProject}
        onCreateProject={os.createProject}
        onRenameProject={os.renameProject}
        onArchiveProject={os.archiveProject}
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
            <span>{os.workspaceName || "云端工作空间"}</span>
            <ChevronsLeft size={13} className="breadcrumb-chevron" />
            <strong>{activeCanvas.title}</strong>
            <span className={`save-indicator is-${os.cloudStatus}`}>
              <Check size={13} />{" "}
              {os.cloudStatus === "saving"
                ? "保存中"
                : os.cloudStatus === "loading"
                  ? "同步中"
                  : os.cloudStatus === "conflict"
                    ? "存在版本冲突"
                    : os.cloudStatus === "error"
                      ? "云端保存失败"
                      : "已保存到云端"}
            </span>
          </div>
          <div className="canvas-header-actions">
            <CanvasCollaborationPanel
              presence={collaboration.presence}
              comments={collaboration.comments}
              selfId={collaboration.selfId}
              remoteRevision={collaboration.remoteRevision}
              accessRevoked={collaboration.accessRevoked}
              error={collaboration.error}
              selectedNodeId={os.selectedNodeId}
              onRefresh={collaboration.refresh}
              onReloadCanvas={os.reloadActiveCanvas}
              onAcknowledgeRemoteRevision={
                collaboration.acknowledgeRemoteRevision
              }
              onCreateComment={collaboration.createComment}
              onResolveComment={collaboration.resolveComment}
            />
            <button
              type="button"
              className="secondary-button compact"
              onClick={() => void shareCanvas()}
            >
              <Share2 size={15} /> 分享
            </button>
            <IconButton
              label="全屏画布"
              onClick={() => void workspaceRef.current?.requestFullscreen()}
            >
              <Maximize2 size={17} />
            </IconButton>
            <IconButton
              label="图层"
              active={layersOpen}
              onClick={() => setLayersOpen((current) => !current)}
            >
              <Layers3 size={17} />
            </IconButton>
          </div>
        </header>

        {layersOpen && (
          <aside className="canvas-layers-panel" aria-label="图层管理">
            <header><Layers3 size={14} /><b>图层</b><small>{os.nodes.length}</small></header>
            <div>
              {[...os.nodes]
                .sort((first, second) => (second.layer ?? 0) - (first.layer ?? 0))
                .map((node) => (
                  <button
                    type="button"
                    key={node.id}
                    className={os.selectedNodeIds.includes(node.id) ? "is-active" : ""}
                    onClick={() => os.setSelectedNodeId(node.id)}
                  >
                    <span>{node.title}</span>
                    <small>{node.kind} · L{node.layer ?? 0}{node.collapsed ? " · 已折叠" : ""}</small>
                  </button>
                ))}
            </div>
          </aside>
        )}

        <div
          ref={stageRef}
          className={stageClass}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("application/x-xiaoluo-asset")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            const serialized = event.dataTransfer.getData("application/x-xiaoluo-asset");
            if (!serialized) return;
            event.preventDefault();
            try {
              const asset = JSON.parse(serialized) as import("../types").FileSystemAsset;
              const rect = event.currentTarget.getBoundingClientRect();
              const position = screenToWorld(
                {
                  x: event.clientX - rect.left,
                  y: event.clientY - rect.top,
                },
                viewportRef.current,
              );
              os.addAssetToCanvas(asset, position);
            } catch {
              window.alert("无法读取拖入的资产");
            }
          }}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={endStagePan}
          onPointerCancel={cancelStagePointer}
          onContextMenu={handleStageContextMenu}
        >
          <div className="canvas-grid" style={gridStyle} aria-hidden="true" />
          {selectionBox && (
            <div
              className="canvas-selection-box"
              style={{
                left: Math.min(selectionBox.startX, selectionBox.currentX),
                top: Math.min(selectionBox.startY, selectionBox.currentY),
                width: Math.abs(selectionBox.currentX - selectionBox.startX),
                height: Math.abs(selectionBox.currentY - selectionBox.startY),
              }}
              aria-hidden="true"
            />
          )}
          {os.cloudError && (
            <div className="canvas-cloud-error" role="alert">
              {os.cloudError}
            </div>
          )}
          {collaboration.accessRevoked && (
            <div className="canvas-access-revoked" role="alert">
              <CircleAlert size={18} />
              <div>
                <b>画布权限已撤销</b>
                <span>协作连接已经停止，请返回画布管理选择仍可访问的画布。</span>
              </div>
              <button type="button" onClick={() => os.setDrawerOpen(true)}>
                打开画布管理
              </button>
            </div>
          )}

          <div className="canvas-content" style={worldStyle}>
            {collaboration.presence
              .filter(
                (item) =>
                  item.userId !== collaboration.selfId &&
                  item.sessionId !== os.collaborationSessionId &&
                  item.cursorX !== null &&
                  item.cursorY !== null,
              )
              .map((item) => (
                <div
                  className="remote-collaboration-cursor"
                  key={`${item.userId}-${item.sessionId}`}
                  style={{ left: item.cursorX ?? 0, top: item.cursorY ?? 0 }}
                >
                  <i />
                  <span>{item.displayName}</span>
                </div>
              ))}
            <CanvasEdgeLayer
              nodes={os.nodes}
              edges={visibleEdges}
              nodeHeights={nodeHeights}
              visibleBounds={visibleBounds}
              selectedEdgeId={selectedEdgeId}
              draft={connectionDraft}
              onSelect={(edgeId) => {
                setSelectedEdgeId(edgeId);
                os.setSelectedNodeId(null);
              }}
              onDelete={(edgeId) => {
                os.deleteEdge(edgeId);
                setSelectedEdgeId(null);
              }}
            />

            {visibleNodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                workspaceId={os.workspaceId}
                saveState={os.cloudStatus}
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
                onConnectionStart={(portId, dataType, clientX, clientY) =>
                  beginConnection(node.id, portId, dataType, clientX, clientY)
                }
                connectionDataType={
                  connectionDraft?.sourceId === node.id
                    ? undefined
                    : connectionDraft?.dataType
                }
                onRun={() => void os.startRun(node.id)}
                onRerunBranch={() => void os.rerunBranch(node.id)}
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
              canRedo={os.canRedo}
              canCopy={Boolean(os.selectedNodeIds.length)}
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
              onRedo={os.redoCanvas}
              onCopy={() => {
                os.copySelected();
              }}
              onPaste={() => {
                os.pasteCopied();
              }}
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
              {/* Static brand asset; image optimization adds no value at this size. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
          capabilities={os.capabilities}
          onClose={() => os.setConsoleOpen(false)}
          onSubmit={os.submitIntent}
          onUploadAttachments={os.uploadIntentAttachments}
          onConfirmPlan={os.confirmPlan}
          onUpdatePlan={os.updatePlan}
          onRejectPlan={os.rejectPlan}
          onStart={os.startRun}
          onPause={os.pauseRun}
          onCancel={os.cancelRun}
        />
      )}
    </div>
  );
}
