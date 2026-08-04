"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  coreCapabilities,
  initialModels,
} from "../data";
import type {
  AppView,
  CanvasEdge,
  CanvasGroup,
  CanvasNode,
  CanvasSummary,
  Capability,
  ChatAttachment,
  ChatMessage,
  FileSystemAsset,
  InstalledPackage,
  IntentPlan,
  KernelNodeOutput,
  ModelProviderTemplate,
  ModelConnectionDraft,
  NodeKind,
  PackageInstallResult,
  GithubPackageImportResult,
  ProjectSummary,
  RegistryEvent,
  RegistrySnapshot,
  RunState,
  UserPreferences,
} from "../types";
import { messageTime } from "../lib/intent-plan";
import {
  compatibleInputPorts,
  defaultOutputPort,
  portForNode,
  sanitizeCanvasEdges,
  validatePortCardinality,
} from "../lib/node-ports";
import {
  compileWorkflow,
  wouldCreateCycle,
} from "../lib/workflow-kernel";
import { roleForNode } from "../lib/node-role";
import {
  modelMatchesCapability,
  nodeCapabilitySnapshot,
  preferredCapability,
  preferredModel,
  snapshotCapability,
} from "../lib/capability-sync";
import { useAppDialog } from "../components/app-dialog";
import { assetUploadRequestInit } from "../lib/asset-upload";
import { arrangeNodesWithoutOverlap } from "../lib/node-layout";
import {
  normalizeModelInputConstraints,
  validateModelInputAssets,
} from "../lib/model-input-constraints";
import { resolveProfessionalGeneratorRules } from "../lib/professional-generator-rules";

interface CanvasHistoryEntry {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
  selectedNodeIds: string[];
  arrangeMode: "free" | "time" | "type";
}

type NodePreset = Partial<
  Pick<
    CanvasNode,
    | "title"
    | "prompt"
    | "role"
    | "capabilityId"
    | "modelId"
    | "result"
    | "parameters"
  >
> & {
  inputAttachments?: ChatAttachment[];
};

interface ActiveKernelRun {
  id: string;
  paused: boolean;
  canceled: boolean;
  controllers: Map<string, AbortController>;
}

const GROUP_NODE_WIDTH = 264;
const GROUP_NODE_HEIGHT = 220;
const GROUP_PADDING = 48;
const DEFAULT_CANVAS_ZOOM = 100;

type StoredKernelNodeOutput = KernelNodeOutput & { result?: string };

function hasKernelOutputValue(output: StoredKernelNodeOutput | null) {
  if (!output) return false;
  if (typeof output.result === "string" && output.result.trim()) return true;
  if (typeof output.text === "string" && output.text.trim()) return true;
  if (typeof output.assetUrl === "string" && output.assetUrl.trim()) return true;
  return output.data !== undefined && output.data !== null;
}

function nodeBelongsToGroup(node: CanvasNode, group: CanvasGroup) {
  const centerX = node.x + GROUP_NODE_WIDTH / 2;
  const centerY = node.y + GROUP_NODE_HEIGHT / 2;
  return (
    centerX >= group.x &&
    centerX <= group.x + group.width &&
    centerY >= group.y &&
    centerY <= group.y + group.height
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const bodyIsFormData =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !bodyIsFormData
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    issues?: string[];
  } & T;
  if (!response.ok) {
    if (response.status === 413) {
      throw new Error("上传内容超过传输上限，单个文件最大支持 100 MB");
    }
    throw new Error(
      payload.issues?.length
        ? `${payload.error ?? "请求失败"}：${payload.issues.join("；")}`
        : payload.error ?? `请求失败（${response.status}）`,
    );
  }
  return payload;
}

export function useIntentOS() {
  const dialog = useAppDialog();
  const [view, setView] = useState<AppView>("canvas");
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [capabilities, setCapabilities] =
    useState<Capability[]>(coreCapabilities);
  const [models, setModels] = useState(initialModels);
  const [modelProviders, setModelProviders] = useState<ModelProviderTemplate[]>(
    [],
  );
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [registryEvents, setRegistryEvents] = useState<RegistryEvent[]>([]);
  const [registryStatus, setRegistryStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [registryError, setRegistryError] = useState("");
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [activeCanvasId, setActiveCanvasIdState] = useState("");
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [collaborationSessionId] = useState(() => crypto.randomUUID());
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cloudStatus, setCloudStatus] = useState<
    "loading" | "ready" | "saving" | "saved" | "conflict" | "error"
  >("loading");
  const [cloudError, setCloudError] = useState("");
  const clearCloudError = useCallback(() => setCloudError(""), []);
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [canvasViewport, setCanvasViewportState] = useState({
    x: 0,
    y: 0,
    zoom: DEFAULT_CANVAS_ZOOM,
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [activeTool, setActiveTool] = useState("select");
  const [arrangeMode, setArrangeMode] = useState<"free" | "time" | "type">(
    "free",
  );
  const [zoom, setZoom] = useState(DEFAULT_CANVAS_ZOOM);
  const [runState, setRunState] = useState<RunState>("ready");
  const [preferences, setPreferences] = useState<UserPreferences>({
    canvasBackground: "day",
    gesturePreset: "figma",
    invertZoom: false,
    zoomSensitivity: "normal",
    keyboardShortcuts: true,
  });
  const [isPlanning, setIsPlanning] = useState(false);
  const [plan, setPlan] = useState<IntentPlan | null>(null);
  const [activePlanId, setActivePlanId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "msg_welcome",
      role: "assistant",
      content:
        "我已经读取当前画布。你可以直接描述目标，我会先生成可检查的计划，再写入画布。",
      time: "14:20",
    },
  ]);
  const activeRun = useRef<ActiveKernelRun | null>(null);
  const reconciledKernelRuns = useRef(new Set<string>());
  const pendingDirectRunNodeId = useRef<string | null>(null);
  const canvasHistory = useRef<CanvasHistoryEntry[]>([]);
  const canvasFuture = useRef<CanvasHistoryEntry[]>([]);
  const canvasClipboard = useRef<CanvasHistoryEntry | null>(null);
  const [canPaste, setCanPaste] = useState(false);
  const [historyDepth, setHistoryDepth] = useState(0);
  const revisions = useRef(new Map<string, number>());
  const saveSequence = useRef(Promise.resolve());
  const skipNextCloudSave = useRef(true);

  useEffect(() => {
    let active = true;
    void requestJson<{ preferences: UserPreferences }>("/api/v2/preferences")
      .then((payload) => {
        if (active) setPreferences(payload.preferences);
      })
      .catch(() => {
        // Defaults remain available when preferences have not been migrated yet.
      });
    return () => {
      active = false;
    };
  }, []);

  const applyCloudCanvas = useCallback(
    (canvas: {
      id: string;
      revision: number;
      arrangeMode: "free" | "time" | "type";
      viewport: { x?: number; y?: number; zoom?: number };
      groups: CanvasGroup[];
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    }) => {
      const viewport = {
        x: Number(canvas.viewport.x ?? 0),
        y: Number(canvas.viewport.y ?? 0),
        // Opening or refreshing a canvas always starts at the neutral scale.
        zoom: DEFAULT_CANVAS_ZOOM,
      };
      revisions.current.set(canvas.id, canvas.revision);
      setCanvasRevision(canvas.revision);
      setActiveCanvasIdState(canvas.id);
      const nextEdges = sanitizeCanvasEdges(canvas.nodes, canvas.edges);
      setNodes(canvas.nodes);
      setEdges(nextEdges);
      setGroups(canvas.groups ?? []);
      setArrangeMode(canvas.arrangeMode);
      setCanvasViewportState(viewport);
      setZoom(viewport.zoom);
      setSelectedNodeIdState(null);
      setSelectedNodeIds([]);
      canvasHistory.current = [];
      canvasFuture.current = [];
      setHistoryDepth(0);
      skipNextCloudSave.current = nextEdges.length === canvas.edges.length;
    },
    [],
  );

  const loadCanvasHome = useCallback(async () => {
    setCloudLoaded(false);
    setCloudStatus("loading");
    try {
      const payload = await requestJson<{
        dataScopeId: string;
        project: { id: string; name: string };
        projects: ProjectSummary[];
        canvases: CanvasSummary[];
        activeCanvas: {
          id: string;
          revision: number;
          arrangeMode: "free" | "time" | "type";
          viewport: { x?: number; y?: number; zoom?: number };
          groups: CanvasGroup[];
          nodes: CanvasNode[];
          edges: CanvasEdge[];
        };
      }>("/api/v2/bootstrap");
      setWorkspaceId(payload.dataScopeId);
      setProjectId(payload.project.id);
      setProjectName(payload.project.name);
      setProjects(payload.projects);
      setCanvases(payload.canvases);
      applyCloudCanvas(payload.activeCanvas);
      setCloudError("");
      setCloudStatus("ready");
      setCloudLoaded(true);
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : "云画布加载失败",
      );
      setCloudStatus("error");
    }
  }, [applyCloudCanvas]);

  async function switchProject(nextProjectId: string) {
    if (!nextProjectId || nextProjectId === projectId) return;
    const project = projects.find((item) => item.id === nextProjectId);
    const payload = await requestJson<{ canvases: CanvasSummary[] }>(
      `/api/v2/canvases?projectId=${encodeURIComponent(nextProjectId)}`,
    );
    if (!payload.canvases.length) throw new Error("项目中没有可打开的画布");
    setProjectId(nextProjectId);
    setProjectName(project?.name ?? "项目");
    setCanvases(payload.canvases);
    await setActiveCanvasId(payload.canvases[0].id);
  }

  async function createProject() {
    const name = (
      await dialog.prompt("为新项目设置一个名称。", {
        title: "新建项目",
        inputLabel: "项目名称",
        defaultValue: "新的项目",
        confirmText: "创建项目",
      })
    )?.trim();
    if (!name) return;
    const payload = await requestJson<{
      project: { id: string; name: string };
      canvasId: string;
    }>("/api/v2/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceId, name }),
    });
    const list = await requestJson<{ projects: ProjectSummary[] }>(
      `/api/v2/projects?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    setProjects(list.projects);
    setProjectId(payload.project.id);
    setProjectName(payload.project.name);
    const canvasesPayload = await requestJson<{ canvases: CanvasSummary[] }>(
      `/api/v2/canvases?projectId=${encodeURIComponent(payload.project.id)}`,
    );
    setCanvases(canvasesPayload.canvases);
    await setActiveCanvasId(payload.canvasId);
  }

  async function renameProject(id: string) {
    const current = projects.find((item) => item.id === id);
    const name = (
      await dialog.prompt("修改当前项目的显示名称。", {
        title: "修改项目名称",
        inputLabel: "项目名称",
        defaultValue: current?.name ?? "",
        confirmText: "保存名称",
      })
    )?.trim();
    if (!name || name === current?.name) return;
    await requestJson("/api/v2/projects", {
      method: "PATCH",
      body: JSON.stringify({ id, action: "update", name }),
    });
    setProjects((items) =>
      items.map((item) => (item.id === id ? { ...item, name } : item)),
    );
    if (id === projectId) setProjectName(name);
  }

  async function archiveProject(id: string) {
    if (projects.filter((item) => item.status === "active").length <= 1) {
      throw new Error("至少保留一个使用中的项目");
    }
    await requestJson("/api/v2/projects", {
      method: "PATCH",
      body: JSON.stringify({ id, action: "archive" }),
    });
    const remaining = projects.find(
      (item) => item.id !== id && item.status === "active",
    );
    setProjects((items) =>
      items.map((item) => (item.id === id ? { ...item, status: "archived" } : item)),
    );
    if (id === projectId && remaining) await switchProject(remaining.id);
  }

  const refreshRegistry = useCallback(async () => {
    if (!workspaceId) return;
    setRegistryStatus("loading");
    try {
      const snapshot = await requestJson<RegistrySnapshot>(
        `/api/v2/registry?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setPackages(snapshot.packages);
      setCapabilities([...coreCapabilities, ...snapshot.capabilities]);
      setModels(snapshot.models);
      setModelProviders(snapshot.modelProviders ?? []);
      setRegistryEvents(snapshot.events);
      setRegistryStatus("ready");
      setRegistryError("");
    } catch (error) {
      setRegistryStatus("error");
      setRegistryError(
        error instanceof Error ? error.message : "注册表加载失败",
      );
    }
  }, [workspaceId]);

  useEffect(() => {
    if (registryStatus !== "ready") return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const hasNoCapability = node.capabilityId === "none";
        const capability = hasNoCapability
          ? undefined
          : capabilities.find((item) => item.id === node.capabilityId);
        if (!capability && !hasNoCapability) return node;
        const pinned = nodeCapabilitySnapshot(node);
        const currentModel = models.find((item) => item.id === node.modelId);
        const compatibleModel =
          currentModel &&
          modelMatchesCapability(currentModel, capability, node.kind)
            ? currentModel
            : preferredModel(models, capability, node.kind);
        const modelId =
          capability?.executionMode === "remote"
            ? "skill-runtime"
            : (compatibleModel?.id ?? "unconfigured");
        if (
          (hasNoCapability ||
            (pinned?.packageVersion === capability?.packageVersion &&
              pinned?.id === capability?.id)) &&
          modelId === node.modelId
        ) {
          return node;
        }
        changed = true;
        const parameters = { ...node.parameters };
        if (capability) {
          parameters.capabilitySnapshot = snapshotCapability(capability);
        } else {
          delete parameters.capabilitySnapshot;
        }
        return {
          ...node,
          modelId,
          parameters,
        };
      });
      return changed ? next : current;
    });
  }, [capabilities, models, registryStatus]);

  useEffect(() => {
    if (!workspaceId) return;
    const timer = setTimeout(() => void refreshRegistry(), 0);
    return () => clearTimeout(timer);
  }, [refreshRegistry, workspaceId]);

  useEffect(() => {
    const timer = setTimeout(() => void loadCanvasHome(), 0);
    return () => clearTimeout(timer);
  }, [loadCanvasHome]);

  useEffect(() => {
    if (
      !activeCanvasId ||
      !cloudLoaded
    ) {
      return;
    }
    if (skipNextCloudSave.current) {
      skipNextCloudSave.current = false;
      return;
    }
    const canvasId = activeCanvasId;
    const sanitizedEdges = sanitizeCanvasEdges(nodes, edges);
    if (sanitizedEdges.length !== edges.length) {
      setEdges(sanitizedEdges);
    }
    const snapshot = {
      id: canvasId,
      arrangeMode,
      viewport: { ...canvasViewport, zoom },
      groups,
      nodes,
      edges: sanitizedEdges,
    };
    const timer = setTimeout(() => {
      saveSequence.current = saveSequence.current
        .catch(() => undefined)
        .then(async () => {
          const revision = revisions.current.get(canvasId);
          if (!revision) return;
          setCloudStatus("saving");
          try {
            const saved = await requestJson<{
              revision: number;
              savedAt: string;
            }>("/api/v2/canvases", {
              method: "PUT",
              headers: {
                "x-collaboration-session": collaborationSessionId,
              },
              body: JSON.stringify({ ...snapshot, revision }),
            });
            revisions.current.set(canvasId, saved.revision);
            setCanvasRevision(saved.revision);
            setCanvases((current) =>
              current.map((canvas) =>
                canvas.id === canvasId
                  ? {
                      ...canvas,
                      nodes: snapshot.nodes.length,
                      updatedAt: saved.savedAt,
                    }
                  : canvas,
              ),
            );
            setCloudError("");
            setCloudStatus("saved");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "保存画布失败";
            setCloudError(message);
            setCloudStatus(
              message.includes("其他位置更新") ? "conflict" : "error",
            );
          }
        });
    }, 450);
    return () => clearTimeout(timer);
  }, [
    activeCanvasId,
    arrangeMode,
    canvasViewport,
    cloudLoaded,
    edges,
    groups,
    nodes,
    zoom,
    collaborationSessionId,
  ]);

  const setCanvasViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      setCanvasViewportState(viewport);
      setZoom(viewport.zoom);
    },
    [],
  );

  async function loadCanvas(id: string) {
    if (!id) return;
    setCloudLoaded(false);
    setCloudStatus("loading");
    try {
      const payload = await requestJson<{
        canvas: {
          id: string;
          revision: number;
          arrangeMode: "free" | "time" | "type";
          viewport: { x?: number; y?: number; zoom?: number };
          groups: CanvasGroup[];
          nodes: CanvasNode[];
          edges: CanvasEdge[];
        };
      }>(`/api/v2/canvases?id=${encodeURIComponent(id)}`);
      applyCloudCanvas(payload.canvas);
      setCloudError("");
      setCloudStatus("ready");
      setCloudLoaded(true);
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : "切换画布失败",
      );
      setCloudStatus("error");
      setCloudLoaded(true);
    }
  }

  async function setActiveCanvasId(id: string) {
    if (!id || id === activeCanvasId) return;
    await loadCanvas(id);
  }

  async function reloadActiveCanvas() {
    if (!activeCanvasId) return;
    await loadCanvas(activeCanvasId);
  }

  async function refreshCanvases() {
    const payload = await requestJson<{ canvases: CanvasSummary[] }>(
      "/api/v2/canvases",
    );
    setCanvases(payload.canvases);
    return payload.canvases;
  }

  async function createCanvas(title = "未命名画布") {
    if (!projectId) return;
    const payload = await requestJson<{ canvas: CanvasSummary }>(
      "/api/v2/canvases",
      {
        method: "POST",
        body: JSON.stringify({ projectId, title }),
      },
    );
    setCanvases((current) => [payload.canvas, ...current]);
    await setActiveCanvasId(payload.canvas.id);
  }

  async function duplicateCanvas(id: string, title: string) {
    if (!projectId) return;
    const payload = await requestJson<{ canvas: CanvasSummary }>(
      "/api/v2/canvases",
      {
        method: "POST",
        body: JSON.stringify({
          projectId,
          sourceCanvasId: id,
          title,
        }),
      },
    );
    setCanvases((current) => [payload.canvas, ...current]);
    await setActiveCanvasId(payload.canvas.id);
  }

  async function restoreCanvas(id: string) {
    await requestJson("/api/v2/canvases", {
      method: "PATCH",
      body: JSON.stringify({ id, action: "restore" }),
    });
    const payload = await requestJson<{ canvases: CanvasSummary[] }>(
      "/api/v2/canvases",
    );
    setCanvases(payload.canvases);
  }

  async function patchCanvas(
    id: string,
    action: "rename" | "archive" | "star",
    extra: Record<string, unknown> = {},
  ) {
    await requestJson("/api/v2/canvases", {
      method: "PATCH",
      body: JSON.stringify({ id, action, ...extra }),
    });
    if (action === "rename") {
      setCanvases((current) =>
        current.map((canvas) =>
          canvas.id === id
            ? { ...canvas, title: String(extra.title ?? canvas.title) }
            : canvas,
        ),
      );
      return;
    }
    if (action === "star") {
      setCanvases((current) =>
        current.map((canvas) =>
          canvas.id === id
            ? { ...canvas, starred: Boolean(extra.starred) }
            : canvas,
        ),
      );
      return;
    }
    const remaining = canvases.filter((canvas) => canvas.id !== id);
    setCanvases(remaining);
    if (id === activeCanvasId && remaining[0]) {
      await loadCanvas(remaining[0].id);
    }
  }

  async function renameCanvas(id: string, title: string) {
    await patchCanvas(id, "rename", { title });
  }

  async function archiveCanvas(id: string) {
    await patchCanvas(id, "archive");
  }

  async function toggleCanvasStar(id: string, starred: boolean) {
    await patchCanvas(id, "star", { starred });
  }

  async function deleteCanvas(id: string) {
    await requestJson(`/api/v2/canvases?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const remaining = canvases.filter((canvas) => canvas.id !== id);
    setCanvases(remaining);
    if (id === activeCanvasId && remaining[0]) {
      await loadCanvas(remaining[0].id);
    }
  }

  async function createCanvasSnapshot(label?: string) {
    if (!activeCanvasId) return;
    await requestJson("/api/v2/canvases/snapshots", {
      method: "POST",
      body: JSON.stringify({ canvasId: activeCanvasId, label }),
    });
  }

  async function restoreCanvasSnapshot(snapshotId: string) {
    if (!activeCanvasId) return;
    await requestJson("/api/v2/canvases/snapshots", {
      method: "PATCH",
      body: JSON.stringify({ canvasId: activeCanvasId, snapshotId }),
    });
    await loadCanvas(activeCanvasId);
  }

  useEffect(
    () => () => {
      activeRun.current?.controllers.forEach((controller) =>
        controller.abort(),
      );
    },
    [],
  );

  useEffect(() => {
    if (!activeCanvasId || !cloudLoaded) return;
    let disposed = false;
    void requestJson<{
      messages: Array<{
        id: string;
        role: "user" | "assistant" | "system";
        content: string;
        metadataJson: string;
        createdAt: string;
      }>;
      plan: { id: string; status: string; planJson: string } | null;
    }>(
      `/api/v2/intent/messages?canvasId=${encodeURIComponent(activeCanvasId)}`,
    )
      .then((state) => {
        if (disposed) return;
        const restored = state.messages
          .filter(
            (message): message is typeof message & {
              role: "user" | "assistant";
            } => message.role === "user" || message.role === "assistant",
          )
          .map((message) => {
            let attachments: ChatAttachment[] = [];
            try {
              const metadata = JSON.parse(message.metadataJson) as {
                attachments?: ChatAttachment[];
              };
              if (Array.isArray(metadata.attachments)) {
                attachments = metadata.attachments;
              }
            } catch {
              attachments = [];
            }
            return {
              id: message.id,
              role: message.role,
              content: message.content,
              time: messageTime(),
              ...(attachments.length ? { attachments } : {}),
            };
          });
        if (restored.length) setMessages(restored);
        if (state.plan?.status === "awaiting_confirmation") {
          try {
            setPlan(JSON.parse(state.plan.planJson) as IntentPlan);
            setActivePlanId(state.plan.id);
            setRunState("awaiting_confirmation");
          } catch {
            setPlan(null);
            setActivePlanId("");
          }
        } else {
          setPlan(null);
          setActivePlanId("");
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [activeCanvasId, cloudLoaded]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  function rememberCanvas() {
    canvasHistory.current = [
      ...canvasHistory.current.slice(-39),
      { nodes, edges, groups, selectedNodeIds, arrangeMode },
    ];
    canvasFuture.current = [];
    setHistoryDepth(canvasHistory.current.length);
  }

  function setSelectedNodeId(id: string | null) {
    setSelectedNodeIdState(id);
    setSelectedNodeIds(id ? [id] : []);
  }

  function selectNode(id: string, additive = false) {
    if (!additive && activeTool !== "multi-select") {
      setSelectedNodeIdState(id);
      setSelectedNodeIds([id]);
      return;
    }
    setSelectedNodeIds((current) => {
      const next = current.includes(id)
        ? current.filter((nodeId) => nodeId !== id)
        : [...current, id];
      setSelectedNodeIdState(next.at(-1) ?? null);
      return next;
    });
  }

  function selectNodes(ids: string[]) {
    const valid = [...new Set(ids)].filter((id) =>
      nodes.some((node) => node.id === id),
    );
    setSelectedNodeIds(valid);
    setSelectedNodeIdState(valid.at(-1) ?? null);
  }

  function beginNodeMove() {
    rememberCanvas();
    setArrangeMode("free");
  }

  function moveNode(id: string, x: number, y: number) {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, x, y } : node)),
    );
  }

  function addGroup(position?: { x: number; y: number }) {
    rememberCanvas();
    const selected = nodes.filter((node) => selectedNodeIds.includes(node.id));
    const colors: CanvasGroup["color"][] = [
      "indigo",
      "emerald",
      "amber",
      "rose",
    ];
    const id = `group_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const bounds = selected.length
      ? {
          minX: Math.min(...selected.map((node) => node.x)),
          minY: Math.min(...selected.map((node) => node.y)),
          maxX: Math.max(
            ...selected.map((node) => node.x + GROUP_NODE_WIDTH),
          ),
          maxY: Math.max(
            ...selected.map((node) => node.y + GROUP_NODE_HEIGHT),
          ),
        }
      : null;
    const group: CanvasGroup = {
      id,
      title: `节点群 ${groups.length + 1}`,
      x: bounds ? bounds.minX - GROUP_PADDING : (position?.x ?? 240),
      y: bounds ? bounds.minY - GROUP_PADDING : (position?.y ?? 180),
      width: bounds
        ? Math.max(360, bounds.maxX - bounds.minX + GROUP_PADDING * 2)
        : 680,
      height: bounds
        ? Math.max(260, bounds.maxY - bounds.minY + GROUP_PADDING * 2)
        : 420,
      color: colors[groups.length % colors.length],
      createdAt: Date.now(),
    };
    setGroups((current) => [...current, group]);
    setArrangeMode("free");
    return id;
  }

  function beginGroupChange() {
    rememberCanvas();
    setArrangeMode("free");
  }

  function moveGroupBy(
    id: string,
    deltaX: number,
    deltaY: number,
    memberNodeIds: string[],
  ) {
    const memberSet = new Set(memberNodeIds);
    setGroups((current) =>
      current.map((group) =>
        group.id === id
          ? { ...group, x: group.x + deltaX, y: group.y + deltaY }
          : group,
      ),
    );
    if (memberSet.size) {
      setNodes((current) =>
        current.map((node) =>
          memberSet.has(node.id)
            ? { ...node, x: node.x + deltaX, y: node.y + deltaY }
            : node,
        ),
      );
    }
  }

  function resizeGroupBy(id: string, deltaWidth: number, deltaHeight: number) {
    setGroups((current) =>
      current.map((group) =>
        group.id === id
          ? {
              ...group,
              width: Math.min(4_000, Math.max(320, group.width + deltaWidth)),
              height: Math.min(
                4_000,
                Math.max(220, group.height + deltaHeight),
              ),
            }
          : group,
      ),
    );
  }

  function updateGroup(id: string, patch: Partial<CanvasGroup>) {
    rememberCanvas();
    setGroups((current) =>
      current.map((group) =>
        group.id === id ? { ...group, ...patch, id: group.id } : group,
      ),
    );
  }

  function deleteGroup(id: string) {
    if (!groups.some((group) => group.id === id)) return;
    rememberCanvas();
    setGroups((current) => current.filter((group) => group.id !== id));
  }

  function updateNode(id: string, patch: Partial<CanvasNode>) {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    );
  }

  function addNode(
    kind: NodeKind = "text",
    position?: { x: number; y: number },
    preset: NodePreset = {},
    connection?: { targetId: string; targetPortId?: string },
  ) {
    rememberCanvas();
    const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const inferredRole =
      preset.role ??
      (preset.parameters?.source === "asset-kernel"
        ? "material"
        : preset.parameters?.packageId && preset.parameters?.runtimeType
          ? "plugin"
          : preset.parameters?.resultSlot === true
            ? "result"
            : "execution");
    const explicitlyWithoutCapability = preset.capabilityId === "none";
    const capability =
      inferredRole === "execution" && !explicitlyWithoutCapability
        ? capabilities.find((item) => item.id === preset.capabilityId) ??
          preferredCapability(
            capabilities.filter((item) => item.category === "SKILL"),
            kind,
          )
        : undefined;
    const requestedModel = models.find(
      (item) =>
        item.id === preset.modelId &&
        modelMatchesCapability(item, capability, kind),
    );
    const model =
      inferredRole === "execution"
        ? requestedModel ?? preferredModel(models, capability, kind)
        : undefined;
    const next: CanvasNode = {
      id,
      title:
        preset.title ??
        (kind === "image"
          ? "新图片节点"
          : kind === "video"
            ? "新视频节点"
            : kind === "audio"
              ? "新音频节点"
              : kind === "document"
                ? "新文档节点"
                : "新文本节点"),
      prompt: preset.prompt ?? "在这里描述这个节点需要完成的任务。",
      kind,
      role: inferredRole,
      status: "draft",
      capabilityId:
        inferredRole === "execution"
          ? preset.capabilityId ?? capability?.id ?? "none"
          : inferredRole === "plugin"
            ? preset.capabilityId ?? "core.plugin.runner"
            : inferredRole === "result"
              ? "core.result.placeholder"
              : "core.material.source",
      modelId:
        inferredRole === "plugin"
          ? "plugin-runtime"
          : inferredRole !== "execution"
            ? "none"
            : capability?.executionMode === "remote"
              ? "skill-runtime"
              : (preset.modelId ?? model?.id ?? "unconfigured"),
      x: position?.x ?? 320 + (nodes.length % 3) * 72,
      y: position?.y ?? 250 + (nodes.length % 2) * 110,
      createdAt: Date.now(),
      result: preset.result,
      parameters: {
        ...(preset.parameters ?? {}),
        nodeRole: inferredRole,
        ...(capability
          ? { capabilitySnapshot: snapshotCapability(capability) }
          : {}),
      },
    };
    const supplementalNodes: CanvasNode[] = [];
    const inputSourceNodes: CanvasNode[] = [];
    const seenInputSources = new Set<string>();
    for (const [index, attachment] of (preset.inputAttachments ?? []).entries()) {
      let sourceNode =
        (attachment.sourceNodeId
          ? nodes.find((node) => node.id === attachment.sourceNodeId)
          : undefined) ??
        nodes.find((node) => node.parameters?.assetId === attachment.id);
      if (!sourceNode) {
        const sourceId = `node_asset_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
        const sourceKind: NodeKind =
          attachment.kind === "image" ||
          attachment.kind === "video" ||
          attachment.kind === "audio"
            ? attachment.kind
            : "document";
        sourceNode = {
          id: sourceId,
          title: attachment.name,
          prompt: `输入素材：${attachment.name}`,
          kind: sourceKind,
          role: "material",
          status: "succeeded",
          capabilityId: "core.material.source",
          modelId: "none",
          x: next.x - 420 - Math.floor(index / 4) * 380,
          y: next.y + (index % 4) * 150,
          createdAt: Date.now() + index,
          result: "已加入画布输入素材",
          parameters: {
            nodeRole: "material",
            source: "asset-kernel",
            assetId: attachment.id,
            assetUri: attachment.uri,
            assetContentUrl: attachment.previewUrl ?? attachment.uri,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
            sourceType: "intent-attachment",
          },
        };
        supplementalNodes.push(sourceNode);
      }
      if (!seenInputSources.has(sourceNode.id)) {
        seenInputSources.add(sourceNode.id);
        inputSourceNodes.push(sourceNode);
      }
    }
    const inputEdges = inputSourceNodes.flatMap((sourceNode, index) => {
      const sourcePort = defaultOutputPort(sourceNode);
      const targetPort =
        portForNode(next, "reference", "input") ??
        sourcePort.dataTypes
          .flatMap((dataType) => compatibleInputPorts(next, dataType))
          .at(0);
      const dataType = sourcePort.dataTypes.find((candidate) =>
        targetPort?.dataTypes.includes(candidate),
      );
      if (!targetPort || !dataType) return [];
      return [
        {
          id: `edge_direct_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
          source: sourceNode.id,
          target: next.id,
          sourcePort: sourcePort.id,
          targetPort: targetPort.id,
          dataType,
        } satisfies CanvasEdge,
      ];
    });
    if (connection) {
      const targetNode = nodes.find((node) => node.id === connection.targetId);
      const sourcePort = defaultOutputPort(next);
      const dataType = sourcePort?.dataTypes[0];
      const targetPort =
        targetNode && dataType
          ? connection.targetPortId
            ? portForNode(targetNode, connection.targetPortId, "input")
            : compatibleInputPorts(targetNode, dataType)[0]
          : undefined;
      if (targetNode && sourcePort && dataType && targetPort) {
        setEdges((current) => [
          ...current,
          {
            id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            source: id,
            target: targetNode.id,
            sourcePort: sourcePort.id,
            targetPort: targetPort.id,
            dataType,
          },
        ]);
      } else {
        setCloudError("上传素材已加入画布，但目标节点没有兼容的输入端口");
      }
    }
    if (inputEdges.length) {
      setEdges((current) => [
        ...current,
        ...inputEdges.filter(
          (edge) =>
            !current.some(
              (existing) =>
                existing.source === edge.source &&
                existing.target === edge.target &&
                existing.targetPort === edge.targetPort,
            ),
        ),
      ]);
    }
    setArrangeMode("free");
    setNodes((current) => [...current, ...supplementalNodes, next]);
    setSelectedNodeIdState(id);
    setSelectedNodeIds([id]);
    return id;
  }

  function addAssetToCanvas(
    asset: FileSystemAsset,
    position?: { x: number; y: number },
  ) {
    const kind: NodeKind =
      asset.kind === "image" ||
      asset.kind === "video" ||
      asset.kind === "audio" ||
      asset.kind === "text"
        ? asset.kind
        : "document";
    const sizeLabel =
      asset.size >= 1_048_576
        ? `${(asset.size / 1_048_576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(asset.size / 1024))} KB`;
    setView("canvas");
    return addNode(kind, position, {
      role: "material",
      title: asset.name,
      prompt: asset.description || `使用资产 ${asset.name} 继续创作。`,
      result: `已引用 AI 文件系统资产 · ${sizeLabel}`,
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
    });
  }

  async function deleteSelected() {
    const ids = selectedNodeIds.length
      ? selectedNodeIds
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    if (!ids.length) return;
    const selectedIds = new Set(ids);
    const downstream = new Set(
      edges
        .filter(
          (edge) =>
            selectedIds.has(edge.source) && !selectedIds.has(edge.target),
        )
        .map((edge) => edge.target),
    );
    if (
      downstream.size &&
      !(await dialog.confirm(
        `删除后会断开 ${downstream.size} 个下游节点的输入，是否继续？`,
        {
          title: "删除所选节点",
          confirmText: "继续删除",
          tone: "danger",
        },
      ))
    ) {
      return;
    }
    rememberCanvas();
    setNodes((current) => current.filter((node) => !selectedIds.has(node.id)));
    setEdges((current) =>
      current.filter(
        (edge) =>
          !selectedIds.has(edge.source) && !selectedIds.has(edge.target),
      ),
    );
    setSelectedNodeIdState(null);
    setSelectedNodeIds([]);
  }

  async function deleteNode(id: string) {
    const downstream = new Set(
      edges.filter((edge) => edge.source === id).map((edge) => edge.target),
    );
    if (
      downstream.size &&
      !(await dialog.confirm(
        `删除后会断开 ${downstream.size} 个下游节点的输入，是否继续？`,
        {
          title: "删除节点",
          confirmText: "继续删除",
          tone: "danger",
        },
      ))
    ) {
      return;
    }
    rememberCanvas();
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) =>
      current.filter((edge) => edge.source !== id && edge.target !== id),
    );
    setSelectedNodeIdState((current) => (current === id ? null : current));
    setSelectedNodeIds((current) => current.filter((nodeId) => nodeId !== id));
  }

  function connectNodes(
    source: string,
    target: string,
    sourcePortId?: string,
    targetPortId?: string,
  ) {
    const sourceNode = nodes.find((node) => node.id === source);
    const targetNode = nodes.find((node) => node.id === target);
    const sourcePort = sourceNode
      ? sourcePortId
        ? portForNode(sourceNode, sourcePortId, "output")
        : defaultOutputPort(sourceNode)
      : undefined;
    const dataType = sourcePort?.dataTypes[0];
    const targetPort =
      targetNode && dataType
        ? targetPortId
          ? portForNode(targetNode, targetPortId, "input")
          : compatibleInputPorts(targetNode, dataType)[0]
        : undefined;
    if (
      source === target ||
      !sourceNode ||
      !targetNode ||
      !sourcePort ||
      !targetPort ||
      !dataType ||
      !targetPort.dataTypes.includes(dataType) ||
      edges.some((edge) => edge.source === source && edge.target === target)
    ) {
      setCloudError(
        source === target
          ? "节点不能连接自身"
          : !targetPort
            ? "目标节点没有兼容的输入端口"
            : "这条连接已经存在",
      );
      return false;
    }
    const cardinalityError = validatePortCardinality(
      {
        target,
        targetPort: targetPort.id,
      },
      edges,
      targetNode,
    );
    if (cardinalityError) {
      setCloudError(cardinalityError);
      return false;
    }
    if (wouldCreateCycle(nodes, edges, source, target)) {
      setCloudError("该连接会形成循环依赖，已阻止创建");
      return false;
    }
    rememberCanvas();
    setCloudError("");
    setEdges((current) => [
      ...current,
      {
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        source,
        target,
        sourcePort: sourcePort.id,
        targetPort: targetPort.id,
        dataType,
      },
    ]);
    return true;
  }

  function deleteEdge(id: string) {
    if (!edges.some((edge) => edge.id === id)) return;
    rememberCanvas();
    setEdges((current) => current.filter((edge) => edge.id !== id));
  }

  function undoCanvas() {
    const previous = canvasHistory.current.pop();
    if (!previous) return;
    canvasFuture.current.push({
      nodes,
      edges,
      groups,
      selectedNodeIds,
      arrangeMode,
    });
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setGroups(previous.groups);
    setSelectedNodeIds(previous.selectedNodeIds);
    setSelectedNodeIdState(previous.selectedNodeIds.at(-1) ?? null);
    setArrangeMode(previous.arrangeMode);
    setHistoryDepth(canvasHistory.current.length);
  }

  function redoCanvas() {
    const next = canvasFuture.current.pop();
    if (!next) return;
    canvasHistory.current.push({
      nodes,
      edges,
      groups,
      selectedNodeIds,
      arrangeMode,
    });
    setNodes(next.nodes);
    setEdges(next.edges);
    setGroups(next.groups);
    setSelectedNodeIds(next.selectedNodeIds);
    setSelectedNodeIdState(next.selectedNodeIds.at(-1) ?? null);
    setArrangeMode(next.arrangeMode);
    setHistoryDepth(canvasHistory.current.length);
  }

  function copySelected(
    target: { groupId?: string | null; edgeId?: string | null } = {},
  ) {
    let ids = new Set(
      selectedNodeIds.length
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [],
    );
    let copiedGroups: CanvasGroup[] = [];
    let copiedEdges: CanvasEdge[] = [];

    if (target.groupId) {
      const group = groups.find((item) => item.id === target.groupId);
      if (group) {
        copiedGroups = [group];
        ids = new Set(
          nodes
            .filter((node) => nodeBelongsToGroup(node, group))
            .map((node) => node.id),
        );
      }
    } else if (target.edgeId) {
      const edge = edges.find((item) => item.id === target.edgeId);
      if (edge) {
        ids = new Set([edge.source, edge.target]);
        copiedEdges = [edge];
      }
    }

    if (!ids.size && !copiedGroups.length) return false;
    if (!copiedEdges.length) {
      copiedEdges = edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      );
    }
    canvasClipboard.current = {
      nodes: nodes.filter((node) => ids.has(node.id)),
      edges: copiedEdges,
      groups: copiedGroups,
      selectedNodeIds: [...ids],
      arrangeMode: "free",
    };
    setCanPaste(true);
    return true;
  }

  function pasteCopied() {
    const copied = canvasClipboard.current;
    if (!copied || (!copied.nodes.length && !copied.groups.length)) return false;
    rememberCanvas();
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const idMap = new Map(
      copied.nodes.map((node, index) => [
        node.id,
        `${node.id}_copy_${suffix}_${index}`,
      ]),
    );
    const pastedNodes = copied.nodes.map((node) => ({
      ...node,
      id: idMap.get(node.id) as string,
      title: `${node.title} 副本`,
      x: node.x + 36,
      y: node.y + 36,
      createdAt: Date.now(),
      status: "draft" as const,
      progress: undefined,
    }));
    const pastedEdges = copied.edges.map((edge, index) => ({
      ...edge,
      id: `edge_copy_${suffix}_${index}`,
      source: idMap.get(edge.source) as string,
      target: idMap.get(edge.target) as string,
    }));
    const pastedGroups = copied.groups.map((group, index) => ({
      ...group,
      id: `${group.id}_copy_${suffix}_${index}`,
      title: `${group.title} 副本`,
      x: group.x + 36,
      y: group.y + 36,
      createdAt: Date.now(),
    }));
    const nextSelection = pastedNodes.map((node) => node.id);
    setNodes((current) => [...current, ...pastedNodes]);
    setEdges((current) => [...current, ...pastedEdges]);
    setGroups((current) => [...current, ...pastedGroups]);
    setSelectedNodeIds(nextSelection);
    setSelectedNodeIdState(nextSelection.at(-1) ?? null);
    setArrangeMode("free");
    return true;
  }

  function arrangeNodes(
    mode: "free" | "time" | "type",
    measuredHeights: Record<string, number> = {},
  ) {
    setArrangeMode(mode);
    if (mode === "free" || nodes.length < 2) return;
    rememberCanvas();
    setNodes((current) =>
      arrangeNodesWithoutOverlap(current, mode, measuredHeights),
    );
  }

  async function uploadIntentAttachments(files: File[]) {
    const uploaded: ChatAttachment[] = [];
    for (const file of files.slice(0, 100)) {
      const asset = await uploadAsset(file, {
        sourceType: "intent-attachment",
        sourceRef: activeCanvasId,
        tags: ["Intent 附件"],
      });
      uploaded.push({
        id: asset.id,
        uri: asset.uri,
        name: asset.name,
        kind: asset.kind,
        mimeType: asset.mimeType,
        previewUrl: asset.contentUrl,
      });
    }
    return uploaded;
  }

  async function submitIntentServer(
    value: string,
    attachments: ChatAttachment[] = [],
    preferredCapabilityId?: string,
    preferredModelId?: string,
  ) {
    const intent = value.trim();
    if (!intent || isPlanning || !activeCanvasId) return;
    setMessages((current) => [
      ...current,
      {
        id: `msg_${Date.now()}`,
        role: "user",
        content: intent,
        time: messageTime(),
        attachments,
      },
    ]);
    setIsPlanning(true);
    setPlan(null);
    setActivePlanId("");
    setRunState("idle");
    try {
      const response = await fetch("/api/v2/intent/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          canvasId: activeCanvasId,
          content: intent,
          attachments,
          preferredCapabilityId,
          preferredModelId,
        }),
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Intent Planner 请求失败");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const lines = block.split("\n");
          const name = lines
            .find((line) => line.startsWith("event: "))
            ?.slice(7);
          const dataText = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!name || !dataText) continue;
          const data = JSON.parse(dataText) as Record<string, unknown>;
          if (name === "message.created") {
            const message = data as unknown as {
              id: string;
              role: "assistant";
              content: string;
            };
            setMessages((current) => [
              ...current,
              {
                id: message.id,
                role: "assistant",
                content: message.content,
                time: messageTime(),
              },
            ]);
          } else if (name === "plan.ready") {
            setPlan(data.plan as IntentPlan);
            setActivePlanId(String(data.id ?? ""));
            setRunState("awaiting_confirmation");
          } else if (name === "planner.questions") {
            setRunState("idle");
          } else if (name === "error") {
            throw new Error(String(data.error ?? "Intent Planner 执行失败"));
          }
        }
      }
    } catch (error) {
      setRunState("failed");
      setMessages((current) => [
        ...current,
        {
          id: `msg_error_${Date.now()}`,
          role: "assistant",
          content:
            error instanceof Error ? error.message : "Intent Planner 执行失败",
          time: messageTime(),
        },
      ]);
    } finally {
      setIsPlanning(false);
    }
  }

  function applyPlanToCanvas() {
    if (!plan) return;
    rememberCanvas();
    const startX = 122;
    const levelByTask = new Map<string, number>();
    const resolveLevel = (taskId: string, stack = new Set<string>()): number => {
      if (levelByTask.has(taskId)) return levelByTask.get(taskId) ?? 0;
      if (stack.has(taskId)) return 0;
      stack.add(taskId);
      const task = plan.tasks.find((item) => item.id === taskId);
      const level = task?.dependsOn.length
        ? 1 + Math.max(...task.dependsOn.map((id) => resolveLevel(id, stack)))
        : 0;
      stack.delete(taskId);
      levelByTask.set(taskId, level);
      return level;
    };
    plan.tasks.forEach((task) => resolveLevel(task.id));
    const rowByLevel = new Map<number, number>();
    const timestamp = Date.now();
    const nodeIdByTask = new Map<string, string>();
    const plannedNodes: CanvasNode[] = plan.tasks.map((task, index) => {
      const kind: NodeKind = task.kind;
      const cap =
        capabilities.find(
          (item) =>
            item.enabled &&
            item.category === "SKILL" &&
            item.title === task.capability,
        ) ??
        preferredCapability(
          capabilities.filter((item) => item.category === "SKILL"),
          kind,
        );
      const model = preferredModel(models, cap, kind);
      const level = levelByTask.get(task.id) ?? 0;
      const row = rowByLevel.get(level) ?? 0;
      rowByLevel.set(level, row + 1);
      const nodeId = `planned_${task.id}_${timestamp}`;
      nodeIdByTask.set(task.id, nodeId);
      return {
        id: nodeId,
        title: task.title,
        prompt: `${plan.goal}｜${task.title}`,
        kind,
        role: "execution",
        status: "queued",
        capabilityId: cap?.id ?? "none",
        modelId:
          cap?.executionMode === "remote"
            ? "skill-runtime"
            : (model?.id ?? "unconfigured"),
        x: startX + level * 360,
        y: 140 + row * 260,
        createdAt: timestamp + index,
        progress: 0,
        parameters: {
          ...(task.parameters ?? {}),
          nodeRole: "execution",
          ...(cap ? { capabilitySnapshot: snapshotCapability(cap) } : {}),
        },
        layer: index,
      };
    });
    const nodeById = new Map(plannedNodes.map((node) => [node.id, node]));
    const plannedEdges = plan.tasks.flatMap((task) => {
      const targetId = nodeIdByTask.get(task.id);
      const target = targetId ? nodeById.get(targetId) : undefined;
      if (!target) return [];
      return task.dependsOn.flatMap((dependencyId, index) => {
        const sourceId = nodeIdByTask.get(dependencyId);
        const source = sourceId ? nodeById.get(sourceId) : undefined;
        if (!source) return [];
        const output = defaultOutputPort(source);
        const input = compatibleInputPorts(target, output.dataTypes[0])[0];
        if (!input) return [];
        return [{
          id: `planned_edge_${dependencyId}_${task.id}_${index}`,
          source: source.id,
          target: target.id,
          sourcePort: output.id,
          targetPort: input.id,
          dataType: output.dataTypes[0],
        }];
      });
    });
    setNodes(plannedNodes);
    setEdges(plannedEdges);
    setSelectedNodeIdState(plannedNodes[0]?.id ?? null);
    setSelectedNodeIds(plannedNodes[0] ? [plannedNodes[0].id] : []);
    setPlan(null);
    setRunState("ready");
  }

  async function confirmPlan() {
    if (!plan) return;
    if (activePlanId) {
      await requestJson("/api/v2/intent/plans", {
        method: "PATCH",
        body: JSON.stringify({
          canvasId: activeCanvasId,
          planId: activePlanId,
          action: "confirm",
        }),
      });
    }
    applyPlanToCanvas();
    setActivePlanId("");
  }

  async function updatePlan(nextPlan: IntentPlan) {
    if (!activePlanId) return;
    await requestJson("/api/v2/intent/plans", {
      method: "PATCH",
      body: JSON.stringify({
        canvasId: activeCanvasId,
        planId: activePlanId,
        action: "update",
        plan: nextPlan,
      }),
    });
    setPlan(nextPlan);
  }

  async function rejectPlan() {
    if (activePlanId) {
      await requestJson("/api/v2/intent/plans", {
        method: "PATCH",
        body: JSON.stringify({
          canvasId: activeCanvasId,
          planId: activePlanId,
          action: "reject",
        }),
      });
    }
    setPlan(null);
    setActivePlanId("");
    setRunState("idle");
    setMessages((current) => [
      ...current,
      {
        id: `msg_${Date.now()}`,
        role: "assistant",
        content: "计划已取消。你可以修改目标后重新生成。",
        time: messageTime(),
      },
    ]);
  }

  function graphForTarget(targetNodeId?: string) {
    if (!targetNodeId) return { nodes, edges };
    const included = new Set([targetNodeId]);

    // A node-level run is expected to fill its connected result card. Result
    // slots are passive sinks, so include them without pulling in arbitrary
    // downstream execution branches (those remain the explicit branch action).
    let addedResult = true;
    while (addedResult) {
      addedResult = false;
      edges.forEach((edge) => {
        const target = nodes.find((node) => node.id === edge.target);
        if (
          included.has(edge.source) &&
          target &&
          roleForNode(target) === "result" &&
          !included.has(edge.target)
        ) {
          included.add(edge.target);
          addedResult = true;
        }
      });
    }

    let changed = true;
    while (changed) {
      changed = false;
      edges.forEach((edge) => {
        if (included.has(edge.target) && !included.has(edge.source)) {
          included.add(edge.source);
          changed = true;
        }
      });
    }
    return {
      nodes: nodes.filter((node) => included.has(node.id)),
      edges: edges.filter(
        (edge) => included.has(edge.source) && included.has(edge.target),
      ),
    };
  }

  function graphForBranch(sourceNodeId: string) {
    const descendants = new Set([sourceNodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      edges.forEach((edge) => {
        if (descendants.has(edge.source) && !descendants.has(edge.target)) {
          descendants.add(edge.target);
          changed = true;
        }
      });
    }
    const included = new Set(descendants);
    changed = true;
    while (changed) {
      changed = false;
      edges.forEach((edge) => {
        if (included.has(edge.target) && !included.has(edge.source)) {
          included.add(edge.source);
          changed = true;
        }
      });
    }
    return {
      nodes: nodes.filter((node) => included.has(node.id)),
      edges: edges.filter(
        (edge) => included.has(edge.source) && included.has(edge.target),
      ),
    };
  }

  function graphForGroup(groupId: string) {
    const group = groups.find((item) => item.id === groupId);
    if (!group) return { nodes: [], edges: [] };
    const included = new Set(
      nodes
        .filter((node) => nodeBelongsToGroup(node, group))
        .map((node) => node.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      edges.forEach((edge) => {
        if (included.has(edge.target) && !included.has(edge.source)) {
          included.add(edge.source);
          changed = true;
        }
      });
    }
    return {
      nodes: nodes.filter((node) => included.has(node.id)),
      edges: edges.filter(
        (edge) => included.has(edge.source) && included.has(edge.target),
      ),
    };
  }

  async function readRunState(runId: string) {
    const result = await requestJson<{
      run: { status: RunState; error?: string | null };
      tasks: Array<{
        nodeId: string;
        status: CanvasNode["status"];
        outputJson: string | null;
        executor: string | null;
        error: string | null;
      }>;
    }>(`/api/v2/kernel/runs?runId=${encodeURIComponent(runId)}`);
    const taskMap = new Map(result.tasks.map((task) => [task.nodeId, task]));
    setNodes((current) =>
      current.map((node) => {
        const task = taskMap.get(node.id);
        if (!task) return node;
        let output: StoredKernelNodeOutput | null = null;
        try {
          output = task.outputJson
            ? (JSON.parse(task.outputJson) as StoredKernelNodeOutput)
            : null;
        } catch {
          output = null;
        }
        const missingResultOutput =
          roleForNode(node) === "result" &&
          task.status === "succeeded" &&
          !hasKernelOutputValue(output);
        const blockedByFailedRun =
          result.run.status === "failed" &&
          ["queued", "waiting", "running"].includes(task.status);
        const nextStatus = missingResultOutput
          ? "failed"
          : blockedByFailedRun
            ? "skipped"
            : task.status;
        const nextError = missingResultOutput
          ? "上游节点已完成，但没有返回可写入占位卡片的结果"
          : blockedByFailedRun
            ? result.run.error || "上游节点执行失败，结果未生成"
            : task.error;
        const nextParameters = { ...node.parameters };
        delete nextParameters.kernelOutput;
        delete nextParameters.kernelExecutor;
        if (output && !missingResultOutput) {
          nextParameters.kernelOutput = output;
        }
        if (task.executor) nextParameters.kernelExecutor = task.executor;
        nextParameters.kernelRunId = runId;

        const outputResult =
          (typeof output?.result === "string" && output.result.trim()) ||
          (typeof output?.text === "string" && output.text.trim()) ||
          undefined;
        return {
          ...node,
          status: nextStatus,
          progress:
            ["succeeded", "failed", "skipped", "canceled"].includes(nextStatus)
              ? 100
              : 0,
          result: outputResult ?? (nextError ? `执行失败：${nextError}` : undefined),
          parameters: nextParameters,
        };
      }),
    );
    setRunState(result.run.status);
    return result;
  }

  useEffect(() => {
    const recoverableRunIds = new Set(
      nodes
        .filter((node) =>
          ["queued", "waiting", "running"].includes(node.status),
        )
        .map((node) => node.parameters?.kernelRunId)
        .filter((runId): runId is string => typeof runId === "string"),
    );

    recoverableRunIds.forEach((runId) => {
      if (reconciledKernelRuns.current.has(runId)) return;
      reconciledKernelRuns.current.add(runId);
      void readRunState(runId).catch(() => {
        reconciledKernelRuns.current.delete(runId);
      });
    });
  }, [nodes]);

  async function waitForRun(
    runId: string,
    initial: Awaited<ReturnType<typeof readRunState>>,
  ) {
    let result = initial;
    let queuedPolls = 0;
    while (["queued", "running", "waiting"].includes(result.run.status)) {
      const active = activeRun.current;
      if (!active || active.id !== runId || active.canceled || active.paused) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      result = await readRunState(runId);
      if (result.run.status === "queued") {
        queuedPolls += 1;
        if (queuedPolls === 4) {
          // Recovery path for development sessions started without the
          // standalone Runtime Worker. The normal local launcher starts it.
          await requestJson("/api/v2/kernel/dispatch", {
            method: "POST",
            body: JSON.stringify({ runId }),
          });
          result = await readRunState(runId);
        }
      }
    }
    return result;
  }

  async function startRunServer(
    targetNodeId?: string,
    mode: "target" | "branch" | "group" = "target",
  ) {
    setCloudError("");
    const current = activeRun.current;
    if (current?.paused) {
      current.paused = false;
      setRunState("running");
      await requestJson("/api/v2/kernel/runs", {
        method: "PATCH",
        body: JSON.stringify({ runId: current.id, action: "resume" }),
      });
      const resumed = await readRunState(current.id);
      const completed = await waitForRun(current.id, resumed);
      if (!["paused", "waiting"].includes(completed.run.status)) {
        activeRun.current = null;
      }
      return;
    }
    if (current || !nodes.length || !activeCanvasId) return;
    const graph =
      targetNodeId && mode === "branch"
        ? graphForBranch(targetNodeId)
        : targetNodeId && mode === "group"
          ? graphForGroup(targetNodeId)
          : graphForTarget(targetNodeId);
    if (!graph.nodes.length) {
      setCloudError(
        mode === "group"
          ? "该节点群区域内没有可执行节点"
          : "没有可执行节点",
      );
      return;
    }
    try {
      compileWorkflow(graph.nodes, graph.edges);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "工作流编译失败";
      setRunState("failed");
      setCloudError(message);
      setMessages((messages) => [
        ...messages,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: message,
          time: messageTime(),
        },
      ]);
      return;
    }
    const idempotencyKey = `${activeCanvasId}:${Date.now()}:${crypto.randomUUID()}`;
    try {
      const created = await requestJson<{ runId: string }>(
        "/api/v2/kernel/runs",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({
            ...graph,
            canvasId: activeCanvasId,
          }),
        },
      );
      activeRun.current = {
        id: created.runId,
        paused: false,
        canceled: false,
        controllers: new Map(),
      };
      const included = new Set(graph.nodes.map((node) => node.id));
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (!included.has(node.id)) return node;
          const parameters = { ...node.parameters };
          delete parameters.kernelOutput;
          delete parameters.kernelExecutor;
          delete parameters.kernelRunId;
          return {
            ...node,
            status: "queued",
            progress: 0,
            result: undefined,
            parameters,
          };
        }),
      );
      setRunState("running");
      const initialDispatch = await readRunState(created.runId);
      const dispatched = await waitForRun(
        created.runId,
        initialDispatch,
      );
      if (dispatched.run.status === "succeeded") {
        setMessages((messages) => [
          ...messages,
          {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content: targetNodeId
              ? "目标节点及其依赖已经执行完成。"
              : `工作流执行完成：${graph.nodes.length} 个节点已由服务端内核调度。`,
            time: messageTime(),
          },
        ]);
      } else if (dispatched.run.status === "failed") {
        const message =
          dispatched.run.error ||
          dispatched.tasks.find((task) => task.error)?.error ||
          "节点运行失败";
        setCloudError(message);
      }
      if (!["paused", "waiting"].includes(dispatched.run.status)) {
        activeRun.current = null;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "工作流执行失败";
      setRunState("failed");
      activeRun.current = null;
      setCloudError(message);
      setMessages((messages) => [
        ...messages,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: message,
          time: messageTime(),
        },
      ]);
    }
  }

  function generateDirectly(
    value: string,
    kind: Extract<NodeKind, "text" | "image" | "video">,
    requestedCapabilityId?: string,
    requestedModelId?: string,
    attachments: ChatAttachment[] = [],
  ) {
    const prompt = value.trim();
    if (!prompt || isPlanning || activeRun.current) return;
    const rules = resolveProfessionalGeneratorRules({
      capabilities,
      models,
      kind,
      requestedCapabilityId,
      requestedModelId,
    });
    if (!rules.model && !rules.usesSkillRuntime) {
      setCloudError(`当前没有可用的${kind === "text" ? "文本" : kind === "image" ? "图片" : "视频"}模型`);
      return;
    }
    const inputConstraints = normalizeModelInputConstraints(
      rules.model?.inputConstraints,
      kind,
      rules.model?.protocol,
    );
    const inputValidation = validateModelInputAssets(
      inputConstraints,
      attachments.map((attachment) => ({
        kind:
          attachment.kind === "image" ||
          attachment.kind === "video" ||
          attachment.kind === "audio"
            ? attachment.kind
            : "document",
      })),
    );
    if (!inputValidation.valid) {
      setCloudError(inputValidation.errors.join("；"));
      return;
    }
    const title =
      kind === "image"
        ? "专业图片生成"
        : kind === "video"
          ? "专业视频生成"
          : "专业文本生成";
    const nodeId = addNode(kind, undefined, {
      title,
      prompt,
      capabilityId: rules.capability?.id ?? "none",
      modelId: rules.usesSkillRuntime
        ? "skill-runtime"
        : (rules.model?.id ?? "unconfigured"),
      inputAttachments: attachments,
      parameters: {
        directGenerator: true,
        failurePolicy: "stop",
      },
    });
    pendingDirectRunNodeId.current = nodeId;
    setMessages((current) => [
      ...current,
      {
        id: `msg_${Date.now()}`,
        role: "user",
        content: prompt,
        time: messageTime(),
      },
      {
        id: `msg_${Date.now()}_generator`,
        role: "assistant",
        content: `已创建${title}节点，正在使用 ${rules.usesSkillRuntime ? `${rules.capability?.title ?? "Skill"} 内置服务` : rules.model?.name ?? "模型"} 直接生成。`,
        time: messageTime(),
      },
    ]);
  }

  useEffect(() => {
    const nodeId = pendingDirectRunNodeId.current;
    if (!nodeId || !nodes.some((node) => node.id === nodeId)) return;
    pendingDirectRunNodeId.current = null;
    void startRunServer(nodeId);
  }, [nodes]);

  function rerunBranchServer(nodeId: string) {
    return startRunServer(nodeId, "branch");
  }

  function startGroupRun(groupId: string) {
    return startRunServer(groupId, "group");
  }

  async function pauseRunServer() {
    const run = activeRun.current;
    if (!run || run.paused || run.canceled) return;
    run.paused = true;
    setRunState("paused");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" ? { ...node, status: "paused" } : node,
      ),
    );
    await requestJson("/api/v2/kernel/runs", {
      method: "PATCH",
      body: JSON.stringify({ runId: run.id, action: "pause" }),
    });
  }

  async function cancelRunServer() {
    const run = activeRun.current;
    if (!run) return;
    run.canceled = true;
    setRunState("canceled");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" ||
        node.status === "queued" ||
        node.status === "paused"
          ? { ...node, status: "canceled" }
          : node,
      ),
    );
    await requestJson("/api/v2/kernel/runs", {
      method: "PATCH",
      body: JSON.stringify({ runId: run.id, action: "cancel" }),
    });
    activeRun.current = null;
  }

  function toggleCapability(id: string) {
    setCapabilities((current) =>
      current.map((capability) =>
        capability.id === id
          ? { ...capability, enabled: !capability.enabled }
          : capability,
      ),
    );
  }

  async function testModel(id: string) {
    setModels((current) =>
      current.map((model) =>
        model.id === id ? { ...model, state: "checking" } : model,
      ),
    );
    try {
      const payload = await requestJson<{
        model: (typeof models)[number];
        probe: { ok: boolean; message: string; catalogCount?: number };
      }>("/api/v2/models/test", {
        method: "POST",
        body: JSON.stringify({ id, workspaceId }),
      });
      await refreshRegistry();
      return {
        ok: payload.probe.ok,
        message: payload.probe.catalogCount
          ? `${payload.probe.message}，已同步 ${payload.probe.catalogCount} 个可用模型。`
          : payload.probe.message,
      };
    } catch (error) {
      setModels((current) =>
        current.map((model) =>
          model.id === id ? { ...model, state: "attention" } : model,
        ),
      );
      throw error;
    }
  }

  async function installPackage(raw: string) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("文件不是有效的 JSON Package");
    }
    const result = await requestJson<PackageInstallResult>("/api/v2/packages", {
      method: "POST",
      body: JSON.stringify({ workspaceId, manifest: payload }),
    });
    await refreshRegistry();
    return result;
  }

  async function installPackageArchive(
    file: File,
    accessScope?: "personal" | "workspace" | "marketplace",
  ) {
    const form = new FormData();
    form.set("workspaceId", workspaceId);
    form.set("file", file);
    if (accessScope) form.set("accessScope", accessScope);
    const result = await requestJson<PackageInstallResult>(
      "/api/v2/packages/import/archive",
      {
        method: "POST",
        body: form,
      },
    );
    await refreshRegistry();
    return result;
  }

  async function installPackageFromGithub(input: {
    url: string;
    ref?: string;
    accessScope?: "personal" | "workspace" | "marketplace";
  }) {
    const result = await requestJson<GithubPackageImportResult>(
      "/api/v2/packages/import/github",
      {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          url: input.url,
          ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
          ...(input.accessScope ? { accessScope: input.accessScope } : {}),
        }),
      },
    );
    if (result.status !== "needs_adaptation") {
      await refreshRegistry();
    }
    return result;
  }

  async function installWorkflow(
    listingId: string,
    version?: number,
    token?: string,
  ) {
    if (!projectId) throw new Error("请先选择项目");
    const result = await requestJson<{
      canvas: CanvasSummary;
      missing: {
        skills: string[];
        plugins: string[];
        models: string[];
      };
    }>("/api/v2/workflows/install", {
      method: "POST",
      body: JSON.stringify({
        listingId,
        projectId,
        ...(version ? { version } : {}),
        ...(token ? { token } : {}),
      }),
    });
    const canvasPayload = await requestJson<{ canvases: CanvasSummary[] }>(
      `/api/v2/canvases?projectId=${encodeURIComponent(projectId)}`,
    );
    setCanvases(canvasPayload.canvases);
    await loadCanvas(result.canvas.id);
    setView("canvas");
    return result;
  }

  async function setPackageEnabled(id: string, enabled: boolean) {
    await requestJson("/api/v2/packages", {
      method: "PATCH",
      body: JSON.stringify({ id, enabled, workspaceId }),
    });
    await refreshRegistry();
  }

  async function setPackageAccessScope(
    id: string,
    accessScope: "personal" | "marketplace",
  ) {
    const result = await requestJson<{ package: InstalledPackage }>(
      "/api/v2/packages",
      {
        method: "PATCH",
        body: JSON.stringify({ id, accessScope, workspaceId }),
      },
    );
    await refreshRegistry();
    return result.package;
  }

  async function uninstallPackage(id: string) {
    await requestJson(
      `/api/v2/packages?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
    await refreshRegistry();
  }

  async function testPlugin(id: string) {
    return requestJson<{ ok: boolean; message: string; previewUrl?: string }>(
      "/api/v2/plugins/test",
      { method: "POST", body: JSON.stringify({ id, workspaceId }) },
    );
  }

  async function createModel(draft: ModelConnectionDraft) {
    const result = await requestJson<{ model: (typeof models)[number] }>(
      "/api/v2/models",
      {
        method: "POST",
        body: JSON.stringify({ ...draft, workspaceId }),
      },
    );
    await refreshRegistry();
    return result.model;
  }

  async function updateModel(id: string, draft: ModelConnectionDraft) {
    const result = await requestJson<{ model: (typeof models)[number] }>(
      "/api/v2/models",
      {
        method: "PATCH",
        body: JSON.stringify({ id, ...draft, workspaceId }),
      },
    );
    await refreshRegistry();
    return result.model;
  }

  async function setModelEnabled(id: string, enabled: boolean) {
    await requestJson<{ model: (typeof models)[number] }>("/api/v2/models", {
      method: "PATCH",
      body: JSON.stringify({ id, enabled, workspaceId }),
    });
    await refreshRegistry();
  }

  async function updatePreferences(next: UserPreferences) {
    const previous = preferences;
    setPreferences(next);
    try {
      const payload = await requestJson<{ preferences: UserPreferences }>(
        "/api/v2/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({ preferences: next }),
        },
      );
      setPreferences(payload.preferences);
      return payload.preferences;
    } catch (error) {
      setPreferences(previous);
      throw error;
    }
  }

  async function uploadAsset(
    file: File,
    metadata: {
      sourceType?: string;
      sourceRef?: string | null;
      tags?: string[];
    } = {},
  ) {
    const result = await requestJson<{ asset: FileSystemAsset }>(
      `/api/v2/files?workspaceId=${encodeURIComponent(workspaceId)}`,
      assetUploadRequestInit(file, metadata),
    );
    return result.asset;
  }

  async function deleteModel(id: string) {
    await requestJson(
      `/api/v2/models?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
    await refreshRegistry();
  }

  return {
    view,
    setView,
    nodes,
    edges,
    groups,
    capabilities,
    models,
    modelProviders,
    packages,
    registryEvents,
    registryStatus,
    registryError,
    selectedNode,
    selectedNodeId,
    selectedNodeIds,
    setSelectedNodeId,
    selectNode,
    selectNodes,
    activeCanvasId,
    canvasRevision,
    collaborationSessionId,
    canvases,
    workspaceId,
    projectId,
    projectName,
    projects,
    switchProject,
    createProject,
    renameProject,
    archiveProject,
    cloudStatus,
    cloudError,
    clearCloudError,
    canvasViewport,
    setCanvasViewport,
    setActiveCanvasId,
    reloadActiveCanvas,
    refreshCanvases,
    createCanvas,
    duplicateCanvas,
    restoreCanvas,
    renameCanvas,
    archiveCanvas,
    toggleCanvasStar,
    deleteCanvas,
    createCanvasSnapshot,
    restoreCanvasSnapshot,
    drawerOpen,
    setDrawerOpen,
    consoleOpen,
    setConsoleOpen,
    activeTool,
    setActiveTool,
    arrangeMode,
    zoom,
    setZoom,
    runState,
    preferences,
    isPlanning,
    plan,
    messages,
    canUndo: historyDepth > 0,
    canRedo: canvasFuture.current.length > 0,
    canPaste,
    beginNodeMove,
    moveNode,
    addGroup,
    beginGroupChange,
    moveGroupBy,
    resizeGroupBy,
    updateGroup,
    deleteGroup,
    updateNode,
    addNode,
    addAssetToCanvas,
    deleteSelected,
    deleteNode,
    connectNodes,
    deleteEdge,
    undoCanvas,
    redoCanvas,
    copySelected,
    pasteCopied,
    arrangeNodes,
    submitIntent: submitIntentServer,
    generateDirectly,
    uploadIntentAttachments,
    confirmPlan,
    updatePlan,
    rejectPlan,
    startRun: startRunServer,
    startGroupRun,
    rerunBranch: rerunBranchServer,
    pauseRun: pauseRunServer,
    cancelRun: cancelRunServer,
    toggleCapability,
    testModel,
    refreshRegistry,
    installPackage,
    installPackageArchive,
    installPackageFromGithub,
    installWorkflow,
    setPackageEnabled,
    setPackageAccessScope,
    uninstallPackage,
    testPlugin,
    createModel,
    updateModel,
    setModelEnabled,
    deleteModel,
    updatePreferences,
    uploadAsset,
  };
}

export type IntentOSController = ReturnType<typeof useIntentOS>;
