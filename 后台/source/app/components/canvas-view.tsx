"use client";

import {
  AppWindow,
  Check,
  CircleAlert,
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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { copyTextToClipboard } from "../xiaoluo-brain/components/chat/clipboard";
import { createPortal } from "react-dom";
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
import {
  executionSizeForKind,
  widthForNode,
} from "../lib/node-layout";
import { compatibleInputPorts } from "../lib/node-ports";
import { resolveAssetContentUrl } from "./asset-content-preview";
import type {
  CanvasAssetReference,
  CanvasEdge,
  CanvasNode,
  KernelNodeOutput,
  ModelInputAssetKind,
  NodeKind,
  NodeInputAssetReference,
  PortDataType,
  PluginAssetContext,
  PluginTextContext,
  WorkflowMarketplaceItem,
  WorkflowVisibility,
} from "../types";
import { SUPPORTED_FILE_ACCEPT } from "../lib/file-formats";
import { mediaPluginSupports } from "../lib/media-plugin";
import { packageInstallStatus } from "../lib/package-install-status";
import { CanvasContextMenu } from "./canvas-context-menu";
import {
  CanvasCollaborationPanel,
  useCanvasCollaboration,
} from "./canvas-collaboration";
import { CanvasDrawer } from "./canvas-drawer";
import {
  CanvasEdgeLayer,
  canvasEdgeGeometry,
} from "./canvas-edge-layer";
import { CanvasGroupRegion } from "./canvas-group-region";
import { useAppDialog } from "./app-dialog";
import { IconButton } from "./icon-button";
import { IntentConsole } from "./intent-console";
import { NodeCard } from "./node-card";
import {
  PluginRuntimeDialog,
  type PluginRuntimeMode,
} from "./plugin-runtime-dialog";
import {
  pluginAssetContextsFromReferences,
  pluginTextContextsFromNodes,
} from "../lib/plugin-reference-context";
import { ZoomControls } from "./zoom-controls";
import { BrainResultDock } from "./brain-result-dock";
import type { BrainResultSnapshot } from "./brain-result-dock";

const NODE_FIT_HEIGHT = 220;
const MINIMAP_WIDTH = 200;
const MINIMAP_HEIGHT = 124;
const MINIMAP_PADDING = 8;
const CONTEXT_MENU_WIDTH = 244;
const CONTEXT_MENU_HEIGHT = 500;
const MATERIAL_NODE_COLUMN_GAP = 300;
const MATERIAL_NODE_ROW_GAP = 300;
const MATERIAL_NODES_PER_COLUMN = 3;
const INTENT_DOCK_DEFAULT_WIDTH = 420;
const INTENT_DOCK_MIN_WIDTH = 360;
const INTENT_DOCK_MAX_WIDTH = 680;
const INTENT_DOCK_WIDTH_STORAGE_KEY = "xiaoluo.intent-dock.width";

function clampIntentDockWidth(width: number) {
  return Math.min(
    INTENT_DOCK_MAX_WIDTH,
    Math.max(INTENT_DOCK_MIN_WIDTH, Math.round(width)),
  );
}

function canvasAssetReference(node: CanvasNode): CanvasAssetReference | null {
  if (!["image", "video", "audio", "document"].includes(node.kind)) {
    return null;
  }
  const parameters = node.parameters ?? {};
  const output =
    parameters.kernelOutput && typeof parameters.kernelOutput === "object"
      ? (parameters.kernelOutput as KernelNodeOutput)
      : undefined;
  const outputData =
    output?.data && typeof output.data === "object"
      ? (output.data as Record<string, unknown>)
      : undefined;
  const url =
    typeof output?.assetUrl === "string" && output.assetUrl
      ? output.assetUrl
      : typeof parameters.assetContentUrl === "string" &&
          parameters.assetContentUrl
        ? parameters.assetContentUrl
        : undefined;
  if (!url) return null;
  return {
    sourceNodeId: node.id,
    assetId:
      typeof outputData?.assetId === "string"
        ? outputData.assetId
        : typeof parameters.assetId === "string"
          ? parameters.assetId
          : undefined,
    title: node.title,
    kind: node.kind as ModelInputAssetKind,
    // asset:// 协议浏览器无法加载，统一转为同源 HTTP 内容地址
    url: resolveAssetContentUrl(url),
    mimeType:
      typeof parameters.mimeType === "string"
        ? parameters.mimeType
        : undefined,
    status: node.status,
  };
}

interface ContextMenuState {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  opensLeft: boolean;
  nodeId: string | null;
  groupId: string | null;
  edgeId: string | null;
  pendingConnection: ConnectionDraft | null;
}

interface ConnectionDraft {
  sourceId: string;
  sourcePortId: string;
  dataType: PortDataType;
  current: { x: number; y: number };
}

interface CanvasViewProps {
  os: IntentOSController;
  /** 小逻结果面板开关（宿主受控，左侧工具栏与画布共享） */
  brainDockOpen: boolean;
  onBrainDockOpenChange: (open: boolean) => void;
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

function CanvasWorkspace({ os, brainDockOpen, onBrainDockOpenChange }: CanvasViewProps) {
  const dialog = useAppDialog();
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
    canvasBackground,
    gesturePreset,
    invertZoom,
    keyboardShortcuts,
    zoomSensitivity,
  } = os.preferences;
  const activeCanvas =
    os.canvases.find((canvas) => canvas.id === os.activeCanvasId) ?? {
      id: "",
      title: "正在加载云画布节点列表...",
      project: os.projectName,
      nodes: 0,
      updatedAt: new Date().toISOString(),
    };
  const workspaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const intentDockResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const intentDockPreferencesReadyRef = useRef(false);
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
  /** 小逻大脑结果面板：最新代码产物/预览快照 + 开关 */
  const [brainResult, setBrainResult] = useState<BrainResultSnapshot | null>(null);
  /** 是否已有结果：仅无结果→有结果的第一次自动弹面板，之后更新快照不打扰老板 */
  const hadBrainResultRef = useRef(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [intentDockWidth, setIntentDockWidth] = useState(() => {
    if (typeof window === "undefined") return INTENT_DOCK_DEFAULT_WIDTH;
    try {
      const storedWidth = Number(
        window.localStorage.getItem(INTENT_DOCK_WIDTH_STORAGE_KEY),
      );
      return Number.isFinite(storedWidth) && storedWidth > 0
        ? clampIntentDockWidth(storedWidth)
        : INTENT_DOCK_DEFAULT_WIDTH;
    } catch {
      return INTENT_DOCK_DEFAULT_WIDTH;
    }
  });
  const [intentDockResizing, setIntentDockResizing] = useState(false);
  const [distributionTarget, setDistributionTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [pluginRuntime, setPluginRuntime] = useState<{
    title: string;
    url: string | null;
    packageId: string | null;
    packageKey: string | null;
    assetContexts: PluginAssetContext[];
    textContexts: PluginTextContext[];
    mode: PluginRuntimeMode;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [connectionDraft, setConnectionDraft] =
    useState<ConnectionDraft | null>(null);
  const [pendingAutoConnection, setPendingAutoConnection] = useState<{
    sourceId: string;
    sourcePortId: string;
    targetId: string;
  } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
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
  const lastPanStateCommit = useRef(0);
  const wheelCommitTimer = useRef<number | null>(null);
  const edgePreviewElements = useRef(
    new Map<
      string,
      {
        group: SVGGElement;
        paths: SVGPathElement[];
        remove: SVGGElement | null;
      }
    >(),
  );
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
  /** 小逻大脑产出新结果时自动弹出独立面板 */
  const [dockFocus, setDockFocus] = useState<{ tab: "preview" | "code"; nonce: number } | null>(null);
  const openBrainDock = useCallback(
    (tab?: "preview" | "code") => {
      onBrainDockOpenChange(true);
      if (tab) setDockFocus((prev) => ({ tab, nonce: (prev?.nonce ?? 0) + 1 }));
      // 跳转落地后清除 focus：残留的 focus 会让后续快照更新把页签抢回（原“点代码没反应”根因）
      window.setTimeout(() => setDockFocus(null), 0);
    },
    [onBrainDockOpenChange],
  );

  /** 程序卡片（画布⇄代码）：document 节点承载入口文件内容 */
  const handlePinProgram = (p: { name: string; entry: string; artifact: NonNullable<BrainResultSnapshot["artifact"]> }) => {
    const entryFile = p.artifact.files.find((f) => f.path === (p.artifact.entryFile ?? p.entry)) ?? p.artifact.files[0];
    const text = entryFile ? entryFile.content.slice(0, 6000) : "（无可读入口文件）";
    os.addNode("document", undefined, {
      role: "result",
      title: p.name,
      prompt: "小逻程序库产出（入口：" + p.entry + "）",
      result: text,
      parameters: { nodeRole: "result", source: "brain-program" },
    });
  };

  // ---- MCP 引用（工作区 mcp.json）：结果面板 MCP 页签与输入条共享 hooks----
  const [mcpServers, setMcpServers] = useState<
    { name: string; ok: boolean; toolCount: number; error?: string }[]
  >([]);
  const [pickedMcps, setPickedMcps] = useState<string[]>([]);
  useEffect(() => {
    const bridge = (
      window as unknown as {
        xiaoluoDesktop?: {
          mcpAction?: (payload: { action: string }) => Promise<{
            servers?: { name: string; ok?: boolean; error?: string; tools?: unknown[] }[];
          }>;
        };
      }
    ).xiaoluoDesktop;
    if (!bridge?.mcpAction) return;
    let disposed = false;
    void bridge
      .mcpAction({ action: "servers" })
      .then((res) => {
        if (disposed) return;
        setMcpServers(
          (res.servers ?? []).map((s) => ({
            name: s.name,
            ok: Boolean(s.ok),
            toolCount: s.tools?.length ?? 0,
            error: s.error,
          })),
        );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const toggleMcpPick = useCallback((name: string) => {
    setPickedMcps((current) =>
      current.includes(name)
        ? current.filter((n) => n !== name)
        : [...current, name],
    );
  }, []);

  const handleBrainResult = useCallback((snapshot: BrainResultSnapshot) => {
    // 空快照不覆盖已有结果：Agent 重建/历史恢复时预览会暂时丢失
    // 直接覆盖会出现“结果预览几秒后消失”
    if (snapshot.artifact || snapshot.preview) {
      setBrainResult(snapshot);
      // 仅无结果→有结果的第一次自动弹面板：后续快照更新不再强制打开
      // 老板点×关闭后不会被下一轮结果上报立刻重开（原“关闭没反应”根因）
      if (!hadBrainResultRef.current) {
        hadBrainResultRef.current = true;
        onBrainDockOpenChange(true);
      }
    }
  }, []);

  /** 分享到能力中心：将当前代码产物生成插件并安装 */
  const handleShareToCapability = useCallback(async () => {
    if (!brainResult?.artifact) {
      void dialog.alert('没有可分享的代码产物', { tone: 'info' });
      return;
    }
    const artifact = brainResult.artifact;
    // 走应用内 dialog.prompt：Electron 不支持原生 window.prompt（会静默返回 null）
    const name = await dialog.prompt("请输入插件名称：", {
      defaultValue: artifact.entryFile?.replace(/\.[^.]+$/, "") ?? "my-plugin",
      inputLabel: "插件名称",
      confirmText: "分享并安装",
    });
    if (!name) return;

    try {
      const resp = await fetch('/api/v2/packages/from-artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-workspace-id': os.workspaceId },
        body: JSON.stringify({
          name,
          description: `由小逻生成的插件：${name}`,
          workspaceId: os.workspaceId,
          files: artifact.files.map((f) => ({ path: f.path, content: f.content })),
          entryFile: artifact.entryFile,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        // SHARE-CHAIN-FIX：透出服务端校验明细，避免只看到笼统报错
        const issues = Array.isArray(data.issues) && data.issues.length
          ? `（${data.issues.join('；')}）`
          : '';
        throw new Error(`${data.error ?? '分享失败'}${issues}`);
      }
      // SHARE-REFRESH-FIX：立即刷新注册表缓存，否则能力中心要等下次启动才能看到新插件
      await os.refreshRegistry().catch(() => {});
      void dialog.alert(`${name} 已成功安装到能力中心！`, { tone: 'success' });
    } catch (err) {
      void dialog.alert(`分享失败：${err instanceof Error ? err.message : String(err)}`, { tone: 'danger' });
    }
  }, [brainResult, dialog, os.workspaceId, os.refreshRegistry]);

  const previewViewport = useCallback((next: ViewportTransform) => {
    const scale = next.zoom / 100;
    const grid = gridRef.current;
    const content = contentRef.current;
    if (grid) {
      grid.style.backgroundPosition = `${next.x}px ${next.y}px, ${next.x}px ${next.y}px, ${next.x}px ${next.y}px`;
      grid.style.backgroundSize = `${32 * scale}px ${32 * scale}px, ${32 * scale}px ${32 * scale}px, ${8 * scale}px ${8 * scale}px`;
    }
    if (content) {
      content.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${scale})`;
    }
  }, []);
  const cancelStageInteractions = useCallback(() => {
    const stage = stageRef.current;
    const pointerIds = [
      panGesture.current?.pointerId,
      selectionPointerId.current,
    ].filter((pointerId): pointerId is number => pointerId !== null && pointerId !== undefined);
    for (const pointerId of pointerIds) {
      if (stage?.hasPointerCapture(pointerId)) {
        try {
          stage.releasePointerCapture(pointerId);
        } catch {
          // Capture can already be gone after the browser loses focus.
        }
      }
    }
    if (panFrame.current !== null) {
      cancelAnimationFrame(panFrame.current);
      panFrame.current = null;
    }
    if (wheelCommitTimer.current !== null) {
      window.clearTimeout(wheelCommitTimer.current);
      wheelCommitTimer.current = null;
    }
    pendingPan.current = null;
    if (panGesture.current) {
      setPan({ x: viewportRef.current.x, y: viewportRef.current.y });
      os.setCanvasViewport(viewportRef.current);
    }
    panGesture.current = null;
    selectionPointerId.current = null;
    setIsPanning(false);
    setSelectionBox(null);
    setConnectionDraft(null);
  }, [os]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelStageInteractions();
    };
    window.addEventListener("blur", cancelStageInteractions);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelStageInteractions);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancelStageInteractions]);

  const nodeBounds = useMemo<WorldBounds>(() => {
    if (!os.nodes.length) {
      return { minX: -160, minY: -100, maxX: 160, maxY: 100 };
    }
    return {
      minX: Math.min(...os.nodes.map((node) => node.x)),
      minY: Math.min(...os.nodes.map((node) => node.y)),
      maxX: Math.max(
        ...os.nodes.map((node) => node.x + widthForNode(node)),
      ),
      maxY: Math.max(
        ...os.nodes.map(
          (node) => node.y + (nodeHeights[node.id] ?? NODE_FIT_HEIGHT),
        ),
      ),
    };
  }, [nodeHeights, os.nodes]);

  const groupBounds = useMemo<WorldBounds>(() => {
    if (!os.groups.length) return nodeBounds;
    return {
      minX: Math.min(...os.groups.map((group) => group.x)),
      minY: Math.min(...os.groups.map((group) => group.y)),
      maxX: Math.max(
        ...os.groups.map((group) => group.x + group.width),
      ),
      maxY: Math.max(
        ...os.groups.map((group) => group.y + group.height),
      ),
    };
  }, [nodeBounds, os.groups]);

  const contentBounds = useMemo(
    () => (os.groups.length ? unionBounds(nodeBounds, groupBounds) : nodeBounds),
    [groupBounds, nodeBounds, os.groups.length],
  );

  const groupMemberIds = useMemo(
    () =>
      new Map(
        os.groups.map((group) => [
          group.id,
          os.nodes
            .filter((node) => {
              const centerX = node.x + widthForNode(node) / 2;
              const centerY =
                node.y + (nodeHeights[node.id] ?? NODE_FIT_HEIGHT) / 2;
              return (
                centerX >= group.x &&
                centerX <= group.x + group.width &&
                centerY >= group.y &&
                centerY <= group.y + group.height
              );
            })
            .map((node) => node.id),
        ]),
      ),
    [nodeHeights, os.groups, os.nodes],
  );

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
      fitWorldBounds(expandBounds(contentBounds, 24), stageSize, 56),
    );
  }, [commitViewport, contentBounds, stageSize]);

  const focusNodeOnCanvas = useCallback(
    (nodeId: string) => {
      const node = os.nodes.find((item) => item.id === nodeId);
      if (!node) return;
      os.setSelectedNodeId(nodeId);
      const scale = viewportRef.current.zoom / 100;
      const width = widthForNode(node);
      const height = nodeHeights[node.id] ?? NODE_FIT_HEIGHT;
      commitViewport({
        x: stageSize.width / 2 - (node.x + width / 2) * scale,
        y: stageSize.height / 2 - (node.y + height / 2) * scale,
        zoom: viewportRef.current.zoom,
      });
    },
    [commitViewport, nodeHeights, os, stageSize],
  );

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

  // 面板开合不做持久化：新打开程序默认收起，是否展开由老板当次决定
  useEffect(() => {
    const timer = window.setTimeout(() => {
      intentDockPreferencesReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!intentDockPreferencesReadyRef.current) return;
    try {
      window.localStorage.setItem(
        INTENT_DOCK_WIDTH_STORAGE_KEY,
        String(intentDockWidth),
      );
    } catch {
      // Keep the dock usable even when local persistence is unavailable.
    }
  }, [intentDockWidth]);

  useEffect(() => {
    document.body.style.setProperty(
      "--intent-dock-width",
      `${intentDockWidth}px`,
    );
    return () => {
      document.body.style.removeProperty("--intent-dock-width");
    };
  }, [intentDockWidth]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [intentDockWidth, os.consoleOpen]);

  useEffect(() => {
    document.body.classList.toggle(
      "is-resizing-intent-dock",
      intentDockResizing,
    );
    return () => document.body.classList.remove("is-resizing-intent-dock");
  }, [intentDockResizing]);

  useEffect(() => {
    if (!os.cloudError) return;
    const timer = window.setTimeout(() => {
      os.clearCloudError();
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [os.cloudError, os.clearCloudError]);

  useEffect(
    () => () => {
      if (panFrame.current !== null) cancelAnimationFrame(panFrame.current);
      if (wheelCommitTimer.current !== null) {
        window.clearTimeout(wheelCommitTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (
      !pendingAutoConnection ||
      !os.nodes.some((node) => node.id === pendingAutoConnection.targetId)
    ) {
      return;
    }
    os.connectNodes(
      pendingAutoConnection.sourceId,
      pendingAutoConnection.targetId,
      pendingAutoConnection.sourcePortId,
    );
    queueMicrotask(() => setPendingAutoConnection(null));
  }, [os, pendingAutoConnection]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const canvasStage = stage;
    function wheel(event: WheelEvent) {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          ".schema-fields, .canvas-toolbar, .zoom-controls, .minimap, .minimap-toggle, .canvas-context-menu, .brain-result-dock, input, textarea, select",
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
      previewViewport(next);
      const now = performance.now();
      if (now - lastPanStateCommit.current > 100) {
        lastPanStateCommit.current = now;
        setPan({ x: next.x, y: next.y });
      }
      if (wheelCommitTimer.current !== null) {
        window.clearTimeout(wheelCommitTimer.current);
      }
      wheelCommitTimer.current = window.setTimeout(() => {
        wheelCommitTimer.current = null;
        setPan({ x: viewportRef.current.x, y: viewportRef.current.y });
        setCanvasViewport(viewportRef.current);
      }, 120);
    }
    canvasStage.addEventListener("wheel", wheel, { passive: false });
    return () => canvasStage.removeEventListener("wheel", wheel);
  }, [
    commitViewport,
    gesturePreset,
    invertZoom,
    previewViewport,
    setCanvasViewport,
    zoomSensitivity,
  ]);

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
        if (copySelected({ edgeId: selectedEdgeId })) event.preventDefault();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "v"
      ) {
        if (pasteCopied()) event.preventDefault();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "m"
      ) {
        event.preventDefault();
        if (os.activeTool === "multi-select") {
          os.setActiveTool("select");
          os.setSelectedNodeId(os.selectedNodeId);
        } else {
          os.setActiveTool("multi-select");
        }
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
          void deleteSelected();
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
        const spawnSize = executionSizeForKind(kind);
        addNode(kind, {
          x: center.x - spawnSize.width / 2,
          y: center.y - spawnSize.height / 2,
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
    os,
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
        ".canvas-node, .canvas-group-header, .canvas-group-resize, .canvas-toolbar, .zoom-controls, .minimap, .minimap-toggle, .canvas-context-menu, .canvas-mode-chip, .canvas-navigation-hint, .open-console-button",
      ),
    );
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // 模态框（如图片预览）打开时，禁止画布拖拽
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
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
    const nodeId = target.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const groupId = target.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
    const edgeId = target.closest<HTMLElement>("[data-edge-id]")?.dataset.edgeId;
    if (nodeId && !os.selectedNodeIds.includes(nodeId)) {
      os.setSelectedNodeId(nodeId);
      setSelectedEdgeId(null);
    } else if (edgeId) {
      setSelectedEdgeId(edgeId);
      os.setSelectedNodeId(null);
    }
    openContextMenuAt(
      event.clientX,
      event.clientY,
      nodeId ?? null,
      groupId ?? null,
      edgeId ?? null,
      null,
    );
  }

  function openContextMenuAt(
    clientX: number,
    clientY: number,
    nodeId: string | null,
    groupId: string | null,
    edgeId: string | null,
    pendingConnection: ConnectionDraft | null,
  ) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const screenPoint = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
    const worldPoint = screenToWorld(screenPoint, viewportRef.current);
    const maxX = Math.max(8, rect.width - CONTEXT_MENU_WIDTH - 8);
    const maxY = Math.max(8, rect.height - CONTEXT_MENU_HEIGHT - 8);
    setContextMenu({
      x: Math.max(8, Math.min(screenPoint.x, maxX)),
      y: Math.max(8, Math.min(screenPoint.y, maxY)),
      worldX: worldPoint.x,
      worldY: worldPoint.y,
      nodeId,
      groupId,
      edgeId,
      pendingConnection,
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
    const ownsActiveGesture =
      connectionDraft !== null ||
      selectionPointerId.current === event.pointerId ||
      panGesture.current?.pointerId === event.pointerId;
    if (
      ownsActiveGesture &&
      event.pointerType !== "touch" &&
      (event.buttons & 1) === 0 &&
      (event.buttons & 4) === 0
    ) {
      cancelStageInteractions();
      return;
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
        if (pendingPan.current) {
          const current = {
            ...viewportRef.current,
            ...pendingPan.current,
          };
          previewViewport(current);
          const now = performance.now();
          if (now - lastPanStateCommit.current > 100) {
            lastPanStateCommit.current = now;
            setPan(pendingPan.current);
          }
        }
        pendingPan.current = null;
        panFrame.current = null;
      });
    }
  }

  function endStagePan(event: React.PointerEvent<HTMLDivElement>) {
    if (connectionDraft) {
      const dropElement = document.elementFromPoint(
        event.clientX,
        event.clientY,
      ) as HTMLElement | null;
      const target = dropElement?.closest<HTMLElement>(
        ".port-input[data-node-id]",
      );
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
      } else {
        const directTargetNode = dropElement?.closest<HTMLElement>(
          ".canvas-node[data-node-id]",
        );
        const geometricTargetNode = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".canvas-stage .canvas-node[data-node-id]",
          ),
        )
          .reverse()
          .find((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              event.clientX >= bounds.left &&
              event.clientX <= bounds.right &&
              event.clientY >= bounds.top &&
              event.clientY <= bounds.bottom
            );
          });
        // Media previews, iframes and placeholder surfaces can intercept the
        // pointer target. Falling back to the card bounds keeps the whole
        // visual card available as a connection drop target.
        const targetNodeElement = directTargetNode ?? geometricTargetNode;
        const targetNodeId = targetNodeElement?.dataset.nodeId;
        const targetNode = targetNodeId
          ? os.nodes.find((node) => node.id === targetNodeId)
          : undefined;
        const automaticPort =
          targetNode && targetNode.id !== connectionDraft.sourceId
            ? compatibleInputPorts(targetNode, connectionDraft.dataType)[0]
            : undefined;
        if (targetNode && automaticPort) {
          os.connectNodes(
            connectionDraft.sourceId,
            targetNode.id,
            connectionDraft.sourcePortId,
            automaticPort.id,
          );
        } else {
          const stage = stageRef.current;
          const droppedOnEmptyCanvas =
            Boolean(dropElement && stage?.contains(dropElement)) &&
            !isCanvasOverlay(dropElement!) &&
            !dropElement?.closest("[data-node-id], [data-edge-id]");
          if (droppedOnEmptyCanvas) {
            const current =
              clientToWorld(event.clientX, event.clientY) ??
              connectionDraft.current;
            openContextMenuAt(
              event.clientX,
              event.clientY,
              null,
              null,
              null,
              { ...connectionDraft, current },
            );
          }
        }
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
              node.x + widthForNode(node) < start.x ||
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
    if (panFrame.current !== null) {
      cancelAnimationFrame(panFrame.current);
      panFrame.current = null;
    }
    pendingPan.current = null;
    panGesture.current = null;
    setIsPanning(false);
    previewViewport(viewportRef.current);
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
    const targetId = os.addNode(
      kind,
      { x: contextMenu.worldX, y: contextMenu.worldY },
      preset,
    );
    if (targetId && contextMenu.pendingConnection) {
      setPendingAutoConnection({
        sourceId: contextMenu.pendingConnection.sourceId,
        sourcePortId: contextMenu.pendingConnection.sourcePortId,
        targetId,
      });
    }
  }

  function uploadAtContext() {
    if (!contextMenu) return;
    uploadAnchorRef.current = {
      x: contextMenu.worldX,
      y: contextMenu.worldY,
    };
    uploadInputRef.current?.click();
  }

  async function importFilesToCanvas(
    files: File[],
    anchor: { x: number; y: number },
    options: {
      connectToNodeId?: string;
      direction?: "left" | "right";
    } = {},
  ) {
    if (!files.length) return [];
    const createdNodeIds: string[] = [];
    for (const [index, file] of files.entries()) {
      let asset;
      try {
        asset = await os.uploadAsset(file, {
          sourceType: "canvas-upload",
          sourceRef: os.activeCanvasId,
          tags: ["画布上传"],
        });
      } catch (error) {
        await dialog.alert(
          `${file.name}：${error instanceof Error ? error.message : "文件上传失败"}`,
          {
            title: "文件上传失败",
            tone: "danger",
          },
        );
        continue;
      }
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const kind: NodeKind = asset.kind === "image" ||
        asset.kind === "video" ||
        asset.kind === "audio" ||
        asset.kind === "text"
        ? asset.kind
        : "document";
      let prompt = `从本地导入：${file.name}，可继续补充处理要求。`;
      if (
        kind === "text" &&
        file.size <= 2_000_000 &&
        (file.type.startsWith("text/") ||
          [
            "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml",
            "yml", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts",
            "tsx", "jsx", "py", "java", "c", "cpp", "h", "hpp", "go", "rs",
            "sql", "log", "ini", "toml",
          ].includes(extension))
      ) {
        const preview = (await file.text()).trim().slice(0, 10_000);
        if (preview) prompt = preview;
      }
      const sizeLabel =
        file.size >= 1_048_576
          ? `${(file.size / 1_048_576).toFixed(1)} MB`
          : `${Math.max(1, Math.round(file.size / 1024))} KB`;
      const column = Math.floor(index / MATERIAL_NODES_PER_COLUMN);
      const row = index % MATERIAL_NODES_PER_COLUMN;
      const horizontalDirection = options.direction === "left" ? -1 : 1;
      const nodeId = os.addNode(
        kind,
        {
          x:
            anchor.x +
            horizontalDirection * column * MATERIAL_NODE_COLUMN_GAP,
          y: anchor.y + row * MATERIAL_NODE_ROW_GAP,
        },
        {
          role: "material",
          title: file.name,
          prompt,
          result: `已进入 AI 文件系统 · ${sizeLabel}`,
          parameters: {
            source: "asset-kernel",
            assetId: asset.id,
            assetUri: asset.uri,
            assetContentUrl: asset.contentUrl,
            assetDownloadUrl: asset.downloadUrl,
            fileName: asset.name,
            mimeType: asset.mimeType,
            size: asset.size,
            sourceType: asset.sourceType,
            sourceRef: asset.sourceRef,
            sourceVersion: asset.currentVersion,
          },
        },
        options.connectToNodeId
          ? { targetId: options.connectToNodeId }
          : undefined,
      );
      createdNodeIds.push(nodeId);
    }
    return createdNodeIds;
  }

  async function handleCanvasUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await importFilesToCanvas(files, uploadAnchorRef.current);
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
  const connectedEdgesByNode = useMemo(() => {
    const result = new Map<string, CanvasEdge[]>();
    for (const edge of os.edges) {
      const sourceEdges = result.get(edge.source) ?? [];
      sourceEdges.push(edge);
      result.set(edge.source, sourceEdges);
      const targetEdges = result.get(edge.target) ?? [];
      targetEdges.push(edge);
      result.set(edge.target, targetEdges);
    }
    return result;
  }, [os.edges]);
  useEffect(() => {
    edgePreviewElements.current.clear();
  }, [os.edges]);
  const previewNodeMove = useCallback(
    (nodeId: string, x: number, y: number) => {
      const stage = stageRef.current;
      const node = spatialIndex.nodeById.get(nodeId);
      if (!stage || !node) return;
      const movedNode = { ...node, x, y };
      for (const edge of connectedEdgesByNode.get(nodeId) ?? []) {
        const source =
          edge.source === nodeId
            ? movedNode
            : spatialIndex.nodeById.get(edge.source);
        const target =
          edge.target === nodeId
            ? movedNode
            : spatialIndex.nodeById.get(edge.target);
        if (!source || !target) continue;
        const geometry = canvasEdgeGeometry(
          edge,
          source,
          target,
          nodeHeights,
        );
        if (!geometry) continue;
        let elements = edgePreviewElements.current.get(edge.id);
        if (!elements?.group.isConnected) {
          const group = stage.querySelector<SVGGElement>(
            `[data-edge-id="${CSS.escape(edge.id)}"]`,
          );
          if (!group) continue;
          elements = {
            group,
            paths: Array.from(
              group.querySelectorAll<SVGPathElement>(
                ".canvas-edge-hit, .canvas-edge-path",
              ),
            ),
            remove: group.querySelector<SVGGElement>(".canvas-edge-remove"),
          };
          edgePreviewElements.current.set(edge.id, elements);
        }
        elements.paths.forEach((path) =>
          path.setAttribute("d", geometry.path),
        );
        elements.remove?.setAttribute(
          "transform",
          `translate(${geometry.midpoint.x} ${geometry.midpoint.y})`,
        );
      }
    },
    [connectedEdgesByNode, nodeHeights, spatialIndex],
  );
  const canvasAssets = useMemo(
    () =>
      os.nodes
        .map(canvasAssetReference)
        .filter((asset): asset is CanvasAssetReference => Boolean(asset)),
    [os.nodes],
  );
  const inputAssetsByNode = useMemo(() => {
    const result = new Map<string, NodeInputAssetReference[]>();

    for (const edge of os.edges) {
      const source = spatialIndex.nodeById.get(edge.source);
      const asset = source ? canvasAssetReference(source) : null;
      if (!asset) continue;
      const assets = result.get(edge.target) ?? [];
      assets.push({
        ...asset,
        edgeId: edge.id,
      });
      result.set(edge.target, assets);
    }

    return result;
  }, [os.edges, spatialIndex]);
  const inputTextContextsByNode = useMemo(() => {
    const result = new Map<string, PluginTextContext[]>();

    for (const edge of os.edges) {
      const source = spatialIndex.nodeById.get(edge.source);
      if (!source || source.kind !== "text") continue;
      const [context] = pluginTextContextsFromNodes(os.activeCanvasId, [source]);
      if (!context) continue;
      const contexts = result.get(edge.target) ?? [];
      if (!contexts.some((item) => item.nodeId === context.nodeId)) {
        contexts.push(context);
      }
      result.set(edge.target, contexts);
    }

    return result;
  }, [os.activeCanvasId, os.edges, spatialIndex]);
  const displayedConnectionDraft =
    connectionDraft ?? contextMenu?.pendingConnection ?? null;
  const visibleNodeIds = spatialIndex.queryNodeIds(renderBounds);
  os.selectedNodeIds.forEach((id) => visibleNodeIds.add(id));
  if (displayedConnectionDraft?.sourceId) {
    visibleNodeIds.add(displayedConnectionDraft.sourceId);
  }
  const visibleNodes = [...visibleNodeIds]
    .map((id) => spatialIndex.nodeById.get(id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));

  function installedPluginForNode(node: CanvasNode) {
    const packageId =
      typeof node.parameters?.packageId === "string"
        ? node.parameters.packageId
        : "";
    const packageKey =
      typeof node.parameters?.packageKey === "string"
        ? node.parameters.packageKey
        : "";
    return os.packages.find(
      (item) =>
        item.id === packageId ||
        (Boolean(packageKey) && item.packageKey === packageKey),
    );
  }

  function currentPluginRuntimeUrl(node: CanvasNode) {
    const installedPlugin = installedPluginForNode(node);
    const savedRuntimeUrl =
      typeof node.parameters?.runtimeUrl === "string"
        ? node.parameters.runtimeUrl
        : null;
    return installedPlugin?.runtimeUrl ?? savedRuntimeUrl;
  }
  function pluginAssetContextForNode(
    node: CanvasNode,
  ): PluginAssetContext[] {
    if (!(["image", "video", "audio", "document"] as NodeKind[]).includes(node.kind)) {
      return [];
    }
    const asset = canvasAssetReference(node);
    if (!asset?.url) return [];
    const [context] = pluginAssetContextsFromReferences(os.activeCanvasId, [asset]);
    return context
      ? [{
          ...context,
          ...(typeof node.parameters?.assetDownloadUrl === "string"
            ? { downloadUrl: node.parameters.assetDownloadUrl }
            : {}),
        }]
      : [];
  }
  const availableMediaPlugins = useMemo(
    () =>
      os.packages.filter(
        (item) =>
          item.packageType === "plugin" &&
          item.enabled &&
          item.permissions.includes("assets:read") &&
          Boolean(item.runtimeUrl) &&
          packageInstallStatus(item).available,
      ),
    [os.packages],
  );
  const visibleEdgeIds = spatialIndex.queryEdgeIds(expandBounds(visibleBounds, 360));
  if (selectedEdgeId) visibleEdgeIds.add(selectedEdgeId);
  const visibleEdges = [...visibleEdgeIds]
    .map((id) => spatialIndex.edgeById.get(id))
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));
  const minimapBounds = expandBounds(
    unionBounds(contentBounds, visibleBounds),
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
    displayedConnectionDraft ? "is-connecting" : "",
    minimapOpen ? "" : "is-minimap-collapsed",
    os.activeTool === "hand" || spaceHeld ? "is-pan-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const startIntentDockResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      intentDockResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: intentDockWidth,
      };
      setIntentDockResizing(true);
    },
    [intentDockWidth],
  );

  const moveIntentDockResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const activeResize = intentDockResizeRef.current;
      if (!activeResize || activeResize.pointerId !== event.pointerId) return;
      setIntentDockWidth(
        clampIntentDockWidth(
          activeResize.startWidth + activeResize.startX - event.clientX,
        ),
      );
    },
    [],
  );

  const stopIntentDockResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const activeResize = intentDockResizeRef.current;
      if (!activeResize || activeResize.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      intentDockResizeRef.current = null;
      setIntentDockResizing(false);
    },
    [],
  );

  const handleIntentDockResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIntentDockWidth((width) => clampIntentDockWidth(width + 16));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setIntentDockWidth((width) => clampIntentDockWidth(width - 16));
      } else if (event.key === "Home") {
        event.preventDefault();
        setIntentDockWidth(INTENT_DOCK_DEFAULT_WIDTH);
      }
    },
    [],
  );

  return (
    <div
      className={`canvas-view canvas-background-${canvasBackground}${
        os.consoleOpen ? " is-intent-docked" : ""
      }`}
      style={
        os.consoleOpen
          ? ({
              "--intent-dock-width": `${intentDockWidth}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <div className="canvas-main-pane">
        <CanvasDrawer
        open={os.drawerOpen}
        activeCanvasId={os.activeCanvasId}
        canvases={os.canvases}
        onClose={() => os.setDrawerOpen(false)}
        onSelect={os.setActiveCanvasId}
        onCreate={() => void os.createCanvas()}
        onRename={os.renameCanvas}
        onShare={(id, title) => setDistributionTarget({ id, title })}
        onDelete={os.deleteCanvas}
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
              onClick={() => setShareOpen(true)}
            >
              <Share2 size={15} /> 发布 Workflow
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
                    <small>{node.kind} · L{node.layer ?? 0}</small>
                  </button>
                ))}
            </div>
          </aside>
        )}

        <div
          ref={stageRef}
          className={stageClass}
          onDragOver={(event) => {
            if (
              event.dataTransfer.types.includes("Files") ||
              event.dataTransfer.types.includes("application/x-xiaoluo-asset")
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={async (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const position = screenToWorld(
              {
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
              },
              viewportRef.current,
            );
            const files = Array.from(event.dataTransfer.files ?? []);
            if (files.length) {
              event.preventDefault();
              await importFilesToCanvas(files, position);
              return;
            }
            const serialized = event.dataTransfer.getData("application/x-xiaoluo-asset");
            if (!serialized) return;
            event.preventDefault();
            try {
              const asset = JSON.parse(serialized) as import("../types").FileSystemAsset;
              os.addAssetToCanvas(asset, position);
            } catch {
              await dialog.alert("无法读取拖入的资产，请检查文件后重试。", {
                title: "资产读取失败",
                tone: "danger",
              });
            }
          }}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={endStagePan}
          onPointerCancel={cancelStagePointer}
          onLostPointerCapture={(event) => {
            if (event.target === event.currentTarget) cancelStagePointer(event);
          }}
          onContextMenu={handleStageContextMenu}
        >
          <div
            ref={gridRef}
            className="canvas-grid"
            style={gridStyle}
            aria-hidden="true"
          />
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
              <span>{os.cloudError}</span>
              <button
                type="button"
                aria-label="关闭提示"
                title="关闭提示"
                onClick={os.clearCloudError}
              >
                <X size={14} />
              </button>
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

          <div ref={contentRef} className="canvas-content" style={worldStyle}>
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
            {os.groups.map((group) => (
              <CanvasGroupRegion
                key={group.id}
                group={group}
                memberNodeIds={groupMemberIds.get(group.id) ?? []}
                zoom={os.zoom}
                running={
                  os.runState === "running" || os.runState === "waiting"
                }
                onChangeStart={os.beginGroupChange}
                onMoveBy={(deltaX, deltaY, memberNodeIds) =>
                  os.moveGroupBy(
                    group.id,
                    deltaX,
                    deltaY,
                    memberNodeIds,
                  )
                }
                onResizeBy={(deltaWidth, deltaHeight) =>
                  os.resizeGroupBy(group.id, deltaWidth, deltaHeight)
                }
                onRename={(title) => os.updateGroup(group.id, { title })}
                onDelete={() => os.deleteGroup(group.id)}
                onRun={() => void os.startGroupRun(group.id)}
              />
            ))}
            <CanvasEdgeLayer
              nodes={os.nodes}
              edges={visibleEdges}
              nodeHeights={nodeHeights}
              visibleBounds={visibleBounds}
              selectedEdgeId={selectedEdgeId}
              draft={displayedConnectionDraft}
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
                canvasId={os.activeCanvasId}
                workspaceId={os.workspaceId}
                selected={node.id === os.selectedNodeId}
                multiSelected={os.selectedNodeIds.includes(node.id)}
                zoom={os.zoom}
                panMode={os.activeTool === "hand" || spaceHeld}
                capabilities={os.capabilities}
                models={os.models}
                canvasAssets={canvasAssets.filter(
                  (asset) => asset.sourceNodeId !== node.id,
                )}
                inputAssets={inputAssetsByNode.get(node.id) ?? []}
                inputTextContexts={inputTextContextsByNode.get(node.id) ?? []}
                mediaPlugins={availableMediaPlugins.filter((item) =>
                  mediaPluginSupports(item, node.kind),
                )}
                pluginRuntimeUrl={currentPluginRuntimeUrl(node)}
                onSelect={(additive) => {
                  setSelectedEdgeId(null);
                  os.selectNode(node.id, additive);
                }}
                onMoveStart={os.beginNodeMove}
                onMovePreview={(x, y) => previewNodeMove(node.id, x, y)}
                onMove={(x, y) => os.moveNode(node.id, x, y)}
                onUpdate={(patch) => os.updateNode(node.id, patch)}
                onSizeChange={handleNodeSizeChange}
                onConnectionStart={(portId, dataType, clientX, clientY) =>
                  beginConnection(node.id, portId, dataType, clientX, clientY)
                }
                onAttachInputAsset={(sourceNodeId) => {
                  os.connectNodes(sourceNodeId, node.id, undefined, "reference");
                }}
                onRemoveInputAsset={(edgeId) => os.deleteEdge(edgeId)}
                onUploadInputAssets={async (files) => {
                  await importFilesToCanvas(
                    files,
                    {
                      x: node.x - MATERIAL_NODE_COLUMN_GAP,
                      y: node.y,
                    },
                    {
                      connectToNodeId: node.id,
                      direction: "left",
                    },
                  );
                }}
                connectionDataType={
                  displayedConnectionDraft?.sourceId === node.id
                    ? undefined
                    : displayedConnectionDraft?.dataType
                }
                onRun={() => void os.startRun(node.id)}
                onRerunBranch={() => void os.rerunBranch(node.id)}
                onDelete={() => void os.deleteNode(node.id)}
                onOpenPlugin={(mode = "window") => {
                  const installedPlugin = installedPluginForNode(node);

                  setPluginRuntime({
                    title: installedPlugin?.name ?? node.title,
                    url: currentPluginRuntimeUrl(node),
                    packageId:
                      installedPlugin?.id ??
                      (typeof node.parameters?.packageId === "string"
                        ? node.parameters.packageId
                        : null),
                    packageKey:
                      installedPlugin?.packageKey ??
                      (typeof node.parameters?.packageKey === "string"
                        ? node.parameters.packageKey
                        : null),
                    assetContexts: pluginAssetContextsFromReferences(
                      os.activeCanvasId,
                      inputAssetsByNode.get(node.id) ?? [],
                    ),
                    textContexts: inputTextContextsByNode.get(node.id) ?? [],
                    mode,
                  });
                }}
                onOpenMediaPlugin={(plugin) => {
                  setPluginRuntime({
                    title: plugin.name,
                    url: plugin.runtimeUrl ?? null,
                    packageId: plugin.id,
                    packageKey: plugin.packageKey ?? null,
                    assetContexts: pluginAssetContextForNode(node),
                    textContexts: [],
                    mode: "window",
                  });
                }}
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

          {minimapOpen && (
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
              {os.groups.map((group) => (
                <span
                  key={group.id}
                  className={`minimap-group color-${group.color}`}
                  style={{
                    left: minimapX(group.x),
                    top: minimapY(group.y),
                    width: Math.max(8, group.width * minimapScale),
                    height: Math.max(6, group.height * minimapScale),
                  }}
                />
              ))}
              {os.nodes.map((node) => (
                <i
                  key={node.id}
                  style={{
                    left: minimapX(node.x),
                    top: minimapY(node.y),
                    width: Math.max(5, widthForNode(node) * minimapScale),
                    height: Math.max(
                      4,
                      (nodeHeights[node.id] ?? 156) * minimapScale,
                    ),
                  }}
                  className={`mini-${node.kind}`}
                />
              ))}
            </div>
          )}

          <div className="canvas-navigation-hint">
            拖动空白处平移 · 右键快捷菜单 · Ctrl/⌘ + 滚轮缩放 · Space 抓手 · 0 适配全部
          </div>

          <ZoomControls
            zoom={os.zoom}
            minimapOpen={minimapOpen}
            onToggleMinimap={() => setMinimapOpen((current) => !current)}
            onFit={fitView}
            onReset={() => zoomAtCenter(100)}
            onZoomIn={() => zoomAtCenter(viewportRef.current.zoom + 10)}
            onZoomOut={() => zoomAtCenter(viewportRef.current.zoom - 10)}
            brainDockOpen={brainDockOpen}
            onToggleBrainDock={() => onBrainDockOpenChange(!brainDockOpen)}
          />

          {brainDockOpen && (
            <BrainResultDock
              snapshot={brainResult}
              onClose={() => onBrainDockOpenChange(false)}
              focus={dockFocus}
              mcpServers={mcpServers}
              pickedMcps={pickedMcps}
              onToggleMcp={toggleMcpPick}
              onShareToCapability={handleShareToCapability}
            />
          )}

          <input
            ref={uploadInputRef}
            className="canvas-file-input"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            accept={SUPPORTED_FILE_ACCEPT}
            onChange={handleCanvasUpload}
          />

          {contextMenu && (
            <CanvasContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              opensLeft={contextMenu.opensLeft}
              packages={os.packages}
              canUndo={os.canUndo}
              canRedo={os.canRedo}
              canCopy={Boolean(
                os.selectedNodeIds.length ||
                  contextMenu.nodeId ||
                  contextMenu.groupId ||
                  contextMenu.edgeId,
              )}
              canPaste={os.canPaste}
              canDelete={Boolean(
                contextMenu.nodeId || contextMenu.groupId || contextMenu.edgeId,
              )}
              multiSelectActive={os.activeTool === "multi-select"}
              arrangeMode={os.arrangeMode}
              onAddGroup={() =>
                os.addGroup({
                  x: contextMenu.worldX,
                  y: contextMenu.worldY,
                })
              }
              onAddNode={(kind) =>
                addNodeAtContext(kind, {
                  role: "execution",
                  prompt: "选择已安装的 Skill 与模型，并描述这个节点需要完成的任务。",
                })
              }
              onAddPlaceholder={(kind) =>
                addNodeAtContext(kind, {
                  role: "result",
                  title:
                    kind === "image"
                      ? "图片占位卡片"
                      : kind === "video"
                        ? "视频占位卡片"
                        : kind === "audio"
                          ? "音频占位卡片"
                          : kind === "document"
                            ? "文档占位卡片"
                            : "文本占位卡片",
                  prompt: "",
                  parameters: {
                    nodeRole: "result",
                    resultSlot: true,
                  },
                })
              }
              onAddPlugin={async (plugin) => {
                if (!plugin.enabled) {
                  try {
                    await os.setPackageEnabled(plugin.id, true);
                  } catch (error) {
                    await dialog.alert(
                      error instanceof Error
                        ? error.message
                        : "插件启用失败，请稍后重试。",
                      {
                        title: "无法添加插件",
                        tone: "danger",
                      },
                    );
                    return;
                  }
                }
                const contribution = plugin.nodeContributions?.[0];
                addNodeAtContext(contribution?.modality ?? "text", {
                  role: "plugin",
                  title: plugin.name,
                  prompt:
                    contribution?.description ||
                    plugin.description ||
                    "接收一个或多个素材，通过已安装插件处理后输出给下游节点。",
                  capabilityId: contribution?.id ?? "core.plugin.runner",
                  parameters: {
                    nodeRole: "plugin",
                    packageId: plugin.id,
                    packageKey: plugin.packageKey,
                    packageVersion: plugin.version,
                    pluginName: plugin.name,
                    runtimeType: plugin.runtimeType,
                    runtimeLanguage: plugin.runtimeLanguage,
                    runtimeUrl: plugin.runtimeUrl ?? null,
                    batchMode: "combine",
                    ...(contribution
                      ? {
                          capabilitySnapshot: {
                            id: contribution.id,
                            capabilityKey: contribution.id,
                            title: contribution.title,
                            description: contribution.description,
                            packageId: plugin.id,
                            packageKey: plugin.packageKey,
                            packageVersion: plugin.version,
                            contributionType: "node",
                            inputSchema: contribution.inputSchema,
                            outputSchema: contribution.outputSchema,
                            uiSchema: contribution.uiSchema,
                            ports: contribution.ports,
                            executionMode: "remote",
                            modelRequirements: { required: false },
                          },
                        }
                      : {}),
                  },
                });
              }}
              onUndo={os.undoCanvas}
              onRedo={os.redoCanvas}
              onCopy={() => {
                os.copySelected({
                  groupId: contextMenu.groupId,
                  edgeId: contextMenu.edgeId,
                });
              }}
              onDelete={async () => {
                if (contextMenu.edgeId) {
                  os.deleteEdge(contextMenu.edgeId);
                  return;
                }
                if (contextMenu.groupId) {
                  os.deleteGroup(contextMenu.groupId);
                  return;
                }
                if (contextMenu.nodeId) {
                  await os.deleteNode(contextMenu.nodeId);
                }
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
              onArrange={(mode) => os.arrangeNodes(mode, nodeHeights)}
              onUpload={uploadAtContext}
              onOpenExtensions={() => os.setView("capabilities")}
              onClose={() => setContextMenu(null)}
            />
          )}

          <button
            type="button"
            className={"brain-dock-float" + (brainDockOpen ? " is-active" : "")}
            title={brainDockOpen ? "收起小逻结果面板" : "查看小逻结果面板"}
            aria-label={brainDockOpen ? "收起小逻结果面板" : "查看小逻结果面板"}
            onClick={() => onBrainDockOpenChange(!brainDockOpen)}
          >
            <AppWindow size={15} />
          </button>

          {!os.consoleOpen && (
            <button
              type="button"
              className="open-console-button"
              onClick={() => os.setConsoleOpen(true)}
            >
              {/* Static brand asset; image optimization adds no value at this size. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/xiaoluo-mascot.jpg"
                alt=""
                className="intent-brand-icon"
              />
              Intent
            </button>
          )}
        </div>
      </section>
      </div>

      {os.consoleOpen && (
        <div className="intent-dock" aria-label="Intent 工作台">
          <button
            type="button"
            className="intent-dock-resizer"
            aria-label="调整 Intent 工作台宽度"
            title="拖动调整宽度，方向键微调，Home 恢复默认宽度"
            onPointerDown={startIntentDockResize}
            onPointerMove={moveIntentDockResize}
            onPointerUp={stopIntentDockResize}
            onPointerCancel={stopIntentDockResize}
            onKeyDown={handleIntentDockResizeKey}
          />
          <IntentConsole
            messages={os.messages}
            plan={os.plan}
            isPlanning={os.isPlanning}
            isQuickAnswering={os.isQuickAnswering}
            runState={os.runState}
            planApplied={os.planApplied}
            capabilities={os.capabilities}
            models={os.models}
            canvasAssets={canvasAssets}
            nodes={os.nodes}
            canvasId={os.activeCanvasId}
            onFocusNode={focusNodeOnCanvas}
            onClose={() => os.setConsoleOpen(false)}
            onSubmit={os.submitIntent}
            onQuickAnswer={os.submitQuickAnswer}
            onGenerate={os.generateDirectly}
            onGenerateMedia={os.generateForBrain}
            onBrainResult={handleBrainResult}
            mcpServers={mcpServers}
            pickedMcps={pickedMcps}
            onToggleMcp={toggleMcpPick}
            onClearMcps={() => setPickedMcps([])}
            onPinProgram={handlePinProgram}
            onOpenResult={openBrainDock}
            onUploadAttachments={os.uploadIntentAttachments}
            onConfirmPlan={os.confirmPlan}
            onUpdatePlan={os.updatePlan}
            onRejectPlan={os.rejectPlan}
            onStart={os.startRun}
            onPause={os.pauseRun}
            onCancel={os.cancelRun}
            onDeleteConversation={(id) => {
              void dialog
                .confirm("确定删除该对话？对话中的消息和计划将永久删除，此操作不可恢复。", {
                  tone: "danger",
                  title: "删除对话",
                  confirmText: "删除",
                  cancelText: "取消",
                })
                .then((ok) => {
                  if (ok) void os.deleteConversation(id);
                });
            }}
            onNewConversation={() => {
              void dialog
                .confirm("结束当前对话并新建一个？当前对话将归档保存。", {
                  tone: "warning",
                  title: "新建对话",
                  confirmText: "确定",
                  cancelText: "取消",
                })
                .then((ok) => {
                  if (ok) os.startNewConversation();
                });
            }}
            activeConversationId={os.conversationId}
            conversationHistory={os.conversationHistory}
            onFetchHistory={os.fetchConversationHistory}
            onRestoreConversation={os.restoreConversation}
            onRenameConversation={os.renameConversation}
          />
        </div>
      )}
      {shareOpen && (
        <CanvasShareDialog
          canvasId={os.activeCanvasId}
          canvasTitle={activeCanvas.title}
          workspaceId={os.workspaceId}
          onClose={() => setShareOpen(false)}
        />
      )}
      {distributionTarget && (
        <CanvasDistributionDialog
          canvasId={distributionTarget.id}
          canvasTitle={distributionTarget.title}
          onCompleted={async (sharedCanvasId) => {
            await os.refreshCanvases();
            if (sharedCanvasId) await os.setActiveCanvasId(sharedCanvasId);
          }}
          onClose={() => setDistributionTarget(null)}
        />
      )}
      {pluginRuntime && (
        <PluginRuntimeDialog
          title={pluginRuntime.title}
          url={pluginRuntime.url}
          workspaceId={os.workspaceId}
          packageId={pluginRuntime.packageId}
          packageKey={pluginRuntime.packageKey}
          assetContexts={pluginRuntime.assetContexts}
          textContexts={pluginRuntime.textContexts}
          initialMode={pluginRuntime.mode}
          onClose={() => setPluginRuntime(null)}
        />
      )}
    </div>
  );
}

function CanvasDistributionDialog({
  canvasId,
  canvasTitle,
  onCompleted,
  onClose,
}: {
  canvasId: string;
  canvasTitle: string;
  onCompleted: (sharedCanvasId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [audience, setAudience] = useState<
    "public" | "organization" | "organization_live"
  >("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shared, setShared] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v2/workflows/marketplace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canvasId,
          title: canvasTitle,
          description:
            "由画布管理共享的独立画布副本。安装后可单独编辑、运行和删除。",
          category: "共享画布",
          tags: ["共享画布"],
          visibility: audience === "public" ? "public" : "workspace",
          audience,
          canvasShare: true,
          changelog: "更新共享画布快照",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        workflow?: { id?: string };
        collaboration?: { canvasId?: string };
        error?: string;
      };
      const completed =
        audience === "organization_live"
          ? Boolean(payload.collaboration?.canvasId)
          : Boolean(payload.workflow?.id);
      if (!response.ok || !completed) {
        throw new Error(payload.error ?? "共享画布失败");
      }
      await onCompleted(payload.collaboration?.canvasId);
      setShared(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "共享画布失败");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="extension-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="extension-modal canvas-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-distribution-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">CANVAS SHARING</span>
            <h2 id="canvas-distribution-title">共享画布</h2>
            <p>
              公共及企业副本采用独立快照；企业实时协作会让成员共同编辑同一张画布。            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {!shared ? (
          <>
            <div className="workflow-publish-form">
              <label
                className="span-two canvas-share-scope-field"
                style={{ width: "25%", minWidth: 180, justifySelf: "start" }}
              >
                <span>共享范围</span>
                <select
                  value={audience}
                  onChange={(event) =>
                    setAudience(
                      event.target.value as
                        | "public"
                        | "organization"
                        | "organization_live",
                    )
                  }
                >
                  <option value="public">所有用户（独立副本）</option>
                  <option value="organization">所在企业用户（独立副本）</option>
                  <option value="organization_live">
                    所在企业用户（实时协作）                  </option>
                </select>
              </label>
              <div className="workflow-privacy-note span-two">
                <Share2 size={16} />
                <p>
                  {audience === "organization_live"
                    ? "仅同一企业的有效成员可进入；成员共同读取和保存同一份节点、连线与结果。成员只能编辑，不能重命名、再次共享或删除原画布。"
                    : "API Key、密钥、模型连接 ID、账号信息和私有素材地址会在共享前移除。用户安装后会生成全新的画布、节点和连线 ID，双方后续修改互不影响。"}
                </p>
              </div>
            </div>
            {error && (
              <div className="modal-error">
                <CircleAlert size={14} /> {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? <Sparkles size={15} /> : <Share2 size={15} />}
                共享画布
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="share-result">
              <Check size={22} />
              <div>
                <b>画布已共享</b>
                <p>
                  {audience === "organization_live"
                    ? "企业成员将在画布管理中看到“企业协作”画布，并实时编辑同一份内容。"
                    : "目标用户可在能力商城的 Workflow 分类安装独立副本。"}
                </p>
              </div>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onClose}
              >
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CanvasShareDialog({
  canvasId,
  canvasTitle,
  workspaceId,
  onClose,
}: {
  canvasId: string;
  canvasTitle: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"read_only" | "workflow">("workflow");
  const [title, setTitle] = useState(canvasTitle);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("通用");
  const [tags, setTags] = useState("");
  const [visibility, setVisibility] =
    useState<WorkflowVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (mode === "read_only") {
        const response = await fetch("/api/v2/canvases/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            canvasId,
            mode: "read_only",
            expiresInDays: 30,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          share?: { url?: string };
          error?: string;
        };
        if (!response.ok || !payload.share?.url) {
          throw new Error(payload.error ?? "创建只读分享失败");
        }
        setShareUrl(payload.share.url);
        await copyTextToClipboard(payload.share.url);
        return;
      }

      const existingResponse = await fetch(
        `/api/v2/workflows/marketplace?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const existingPayload = (await existingResponse
        .json()
        .catch(() => ({}))) as {
        workflows?: WorkflowMarketplaceItem[];
      };
      const existing = existingPayload.workflows?.find(
        (item) => item.sourceCanvasId === canvasId,
      );
      const response = await fetch("/api/v2/workflows/marketplace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canvasId,
          listingId: existing?.id,
          title,
          description,
          category,
          tags: tags
            .split(/[,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean),
          visibility,
          changelog: existing
            ? `从画布发布版本${existing.version + 1}`
            : "首次发布",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        workflow?: { shareUrl?: string; version?: number };
        error?: string;
      };
      if (!response.ok || !payload.workflow?.shareUrl) {
        throw new Error(payload.error ?? "发布 Workflow 失败");
      }
      setShareUrl(payload.workflow.shareUrl);
      await copyTextToClipboard(payload.workflow.shareUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分享失败");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="extension-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <div
        className="extension-modal canvas-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-share-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">SHARE & PUBLISH</span>
            <h2 id="canvas-share-title">分享画布</h2>
            <p>只读链接用于查看；Workflow 会发布为可安装、可派生的完整画布能力。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="share-mode-tabs">
          <button
            type="button"
            className={mode === "workflow" ? "is-active" : ""}
            onClick={() => {
              setMode("workflow");
              setShareUrl("");
            }}
          >
            <Layers3 size={15} /> 发布 Workflow
          </button>
          <button
            type="button"
            className={mode === "read_only" ? "is-active" : ""}
            onClick={() => {
              setMode("read_only");
              setShareUrl("");
            }}
          >
            <Share2 size={15} /> 只读链接
          </button>
        </div>

        {mode === "workflow" && !shareUrl && (
          <div className="workflow-publish-form">
            <label>
              <span>Workflow 名称</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="span-two">
              <span>说明</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="说明目标、输入素材要求和最终结果。"
              />
            </label>
            <label>
              <span>分类</span>
              <input value={category} onChange={(event) => setCategory(event.target.value)} />
            </label>
            <label>
              <span>可见范围</span>
              <select
                value={visibility}
                onChange={(event) =>
                  setVisibility(event.target.value as WorkflowVisibility)
                }
              >
                <option value="public">公开能力商城</option>
                <option value="workspace">所在企业</option>
                <option value="link">仅持链接用户</option>
                <option value="private">仅自己可见</option>
              </select>
            </label>
            <label className="span-two">
              <span>标签（逗号分隔）</span>
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="短视频, 营销, 批处理"
              />
            </label>
            <div className="workflow-privacy-note span-two">
              <Sparkles size={16} />
              <p>
                发布时会移除 API Key、密钥、模型连接 ID、账号信息和私有素材地址。
                素材会转换为占位卡片，结果会恢复为空占位。
              </p>
            </div>
          </div>
        )}

        {mode === "read_only" && !shareUrl && (
          <div className="workflow-privacy-note">
            <Share2 size={16} />
            <p>生成 30 天有效的只读快照链接，不允许安装、修改或运行。</p>
          </div>
        )}

        {shareUrl && (
          <div className="share-result">
            <Check size={22} />
            <div>
              <b>{mode === "workflow" ? "Workflow 已发布" : "只读链接已创建"}</b>
              <p>链接已尝试复制到剪贴板，也可以在下方手动复制。</p>
            </div>
            <input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} />
          </div>
        )}

        {error && (
          <div className="modal-error">
            <CircleAlert size={14} /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {shareUrl ? "完成" : "取消"}
          </button>
          {!shareUrl && (
            <button
              type="button"
              className="primary-button"
              disabled={busy || (mode === "workflow" && !title.trim())}
              onClick={() => void submit()}
            >
              {busy ? <Sparkles size={15} /> : <Share2 size={15} />}
              {mode === "workflow" ? "发布到能力商城" : "创建只读链接"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
