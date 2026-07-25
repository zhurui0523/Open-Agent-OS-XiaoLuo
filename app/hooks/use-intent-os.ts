"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  coreCapabilities,
  initialModels,
} from "../data";
import type {
  AppView,
  CanvasEdge,
  CanvasNode,
  CanvasSummary,
  Capability,
  ChatAttachment,
  ChatMessage,
  FileSystemAsset,
  InstalledPackage,
  IntentPlan,
  KernelNodeOutput,
  ModelConnectionDraft,
  NodeKind,
  ProjectSummary,
  RegistryEvent,
  RegistrySnapshot,
  RunState,
  UserPreferences,
  WorkspaceOption,
} from "../types";
import { messageTime } from "../lib/intent-plan";
import {
  compatibleInputPorts,
  defaultOutputPort,
  portForNode,
} from "../lib/node-ports";
import {
  compileWorkflow,
  wouldCreateCycle,
} from "../lib/workflow-kernel";

interface CanvasHistoryEntry {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeIds: string[];
  arrangeMode: "free" | "time" | "type";
}

type NodePreset = Partial<
  Pick<
    CanvasNode,
    "title" | "prompt" | "capabilityId" | "modelId" | "result" | "parameters"
  >
>;

interface ActiveKernelRun {
  id: string;
  paused: boolean;
  canceled: boolean;
  controllers: Map<string, AbortController>;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    issues?: string[];
  } & T;
  if (!response.ok) {
    throw new Error(
      payload.issues?.length
        ? `${payload.error ?? "请求失败"}：${payload.issues.join("；")}`
        : payload.error ?? `请求失败（${response.status}）`,
    );
  }
  return payload;
}

export function useIntentOS() {
  const [view, setView] = useState<AppView>("canvas");
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [capabilities, setCapabilities] =
    useState<Capability[]>(coreCapabilities);
  const [models, setModels] = useState(initialModels);
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
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cloudStatus, setCloudStatus] = useState<
    "loading" | "ready" | "saving" | "saved" | "conflict" | "error"
  >("loading");
  const [cloudError, setCloudError] = useState("");
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [canvasViewport, setCanvasViewportState] = useState({
    x: 0,
    y: 0,
    zoom: 92,
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [activeTool, setActiveTool] = useState("select");
  const [arrangeMode, setArrangeMode] = useState<"free" | "time" | "type">(
    "free",
  );
  const [zoom, setZoom] = useState(92);
  const [runState, setRunState] = useState<RunState>("ready");
  const [preferences, setPreferences] = useState<UserPreferences>({
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
  const canvasHistory = useRef<CanvasHistoryEntry[]>([]);
  const canvasFuture = useRef<CanvasHistoryEntry[]>([]);
  const canvasClipboard = useRef<CanvasHistoryEntry | null>(null);
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
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    }) => {
      const viewport = {
        x: Number(canvas.viewport.x ?? 0),
        y: Number(canvas.viewport.y ?? 0),
        zoom: Number(canvas.viewport.zoom ?? 92),
      };
      revisions.current.set(canvas.id, canvas.revision);
      setCanvasRevision(canvas.revision);
      setActiveCanvasIdState(canvas.id);
      setNodes(canvas.nodes);
      setEdges(canvas.edges);
      setArrangeMode(canvas.arrangeMode);
      setCanvasViewportState(viewport);
      setZoom(viewport.zoom);
      setSelectedNodeIdState(null);
      setSelectedNodeIds([]);
      canvasHistory.current = [];
      canvasFuture.current = [];
      setHistoryDepth(0);
      skipNextCloudSave.current = true;
    },
    [],
  );

  const loadCloudWorkspace = useCallback(async (preferredWorkspaceId = "") => {
    setCloudLoaded(false);
    setCloudStatus("loading");
    try {
      const payload = await requestJson<{
        workspace: { id: string; name: string };
        workspaces: WorkspaceOption[];
        project: { id: string; name: string };
        projects: ProjectSummary[];
        canvases: CanvasSummary[];
        activeCanvas: {
          id: string;
          revision: number;
          arrangeMode: "free" | "time" | "type";
          viewport: { x?: number; y?: number; zoom?: number };
          nodes: CanvasNode[];
          edges: CanvasEdge[];
        };
      }>(
        preferredWorkspaceId
          ? `/api/v2/bootstrap?workspaceId=${encodeURIComponent(preferredWorkspaceId)}`
          : "/api/v2/bootstrap",
      );
      setWorkspaceId(payload.workspace.id);
      setWorkspaceName(payload.workspace.name);
      setWorkspaces(payload.workspaces);
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

  const switchWorkspace = useCallback(
    async (nextWorkspaceId: string) => {
      if (!nextWorkspaceId || nextWorkspaceId === workspaceId) return;
      await loadCloudWorkspace(nextWorkspaceId);
    },
    [loadCloudWorkspace, workspaceId],
  );

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
    const name = window.prompt("新项目名称", "新的项目")?.trim();
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
    const name = window.prompt("项目名称", current?.name ?? "")?.trim();
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
    if (!workspaceId) return;
    const timer = setTimeout(() => void refreshRegistry(), 0);
    return () => clearTimeout(timer);
  }, [refreshRegistry, workspaceId]);

  useEffect(() => {
    const timer = setTimeout(() => void loadCloudWorkspace(), 0);
    return () => clearTimeout(timer);
  }, [loadCloudWorkspace]);

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
    const snapshot = {
      id: canvasId,
      arrangeMode,
      viewport: { ...canvasViewport, zoom },
      nodes,
      edges,
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
    if (!projectId) return;
    await requestJson("/api/v2/canvases", {
      method: "PATCH",
      body: JSON.stringify({ id, projectId, action: "restore" }),
    });
    const payload = await requestJson<{ canvases: CanvasSummary[] }>(
      `/api/v2/canvases?projectId=${encodeURIComponent(projectId)}`,
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
      { nodes, edges, selectedNodeIds, arrangeMode },
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

  function updateNode(id: string, patch: Partial<CanvasNode>) {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    );
  }

  function addNode(
    kind: NodeKind = "text",
    position?: { x: number; y: number },
    preset: NodePreset = {},
  ) {
    rememberCanvas();
    const id = `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const modalityModels = models.filter((model) =>
      model.modalities.includes(kind),
    );
    const modalityCapabilities = capabilities.filter(
      (capability) => capability.enabled && capability.modality === kind,
    );
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
      status: "draft",
      capabilityId:
        preset.capabilityId ??
        modalityCapabilities[0]?.id ??
        "manual.text",
      modelId: preset.modelId ?? modalityModels[0]?.id ?? "unconfigured",
      x: position?.x ?? 320 + (nodes.length % 3) * 72,
      y: position?.y ?? 250 + (nodes.length % 2) * 110,
      createdAt: Date.now(),
      result: preset.result,
      parameters: preset.parameters,
    };
    setArrangeMode("free");
    setNodes((current) => [...current, next]);
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

  function deleteSelected() {
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
      !window.confirm(
        `删除后会断开 ${downstream.size} 个下游节点的输入，是否继续？`,
      )
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
      selectedNodeIds,
      arrangeMode,
    });
    setNodes(previous.nodes);
    setEdges(previous.edges);
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
      selectedNodeIds,
      arrangeMode,
    });
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeIds(next.selectedNodeIds);
    setSelectedNodeIdState(next.selectedNodeIds.at(-1) ?? null);
    setArrangeMode(next.arrangeMode);
    setHistoryDepth(canvasHistory.current.length);
  }

  function copySelected() {
    const ids = new Set(
      selectedNodeIds.length
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [],
    );
    if (!ids.size) return false;
    canvasClipboard.current = {
      nodes: nodes.filter((node) => ids.has(node.id)),
      edges: edges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      ),
      selectedNodeIds: [...ids],
      arrangeMode: "free",
    };
    return true;
  }

  function pasteCopied() {
    const copied = canvasClipboard.current;
    if (!copied?.nodes.length) return false;
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
    const nextSelection = pastedNodes.map((node) => node.id);
    setNodes((current) => [...current, ...pastedNodes]);
    setEdges((current) => [...current, ...pastedEdges]);
    setSelectedNodeIds(nextSelection);
    setSelectedNodeIdState(nextSelection.at(-1) ?? null);
    setArrangeMode("free");
    return true;
  }

  function arrangeNodes(mode: "free" | "time" | "type") {
    setArrangeMode(mode);
    if (mode === "free" || nodes.length < 2) return;
    rememberCanvas();
    const startX = Math.min(...nodes.map((node) => node.x));
    const startY = Math.min(...nodes.map((node) => node.y));
    setNodes((current) => {
      if (mode === "type") {
        const kindOrder: Record<NodeKind, number> = {
          text: 0,
          image: 1,
          video: 2,
          audio: 3,
          document: 4,
        };
        const typeIndex: Record<NodeKind, number> = {
          text: 0,
          image: 0,
          video: 0,
          audio: 0,
          document: 0,
        };
        return current.map((node) => {
          const row = typeIndex[node.kind]++;
          return {
            ...node,
            x: startX + kindOrder[node.kind] * 324,
            y: startY + row * 250,
          };
        });
      }
      const sourceOrder = new Map(
        current.map((node, index) => [node.id, index]),
      );
      return [...current]
        .sort(
          (first, second) =>
            (first.createdAt ?? sourceOrder.get(first.id) ?? 0) -
            (second.createdAt ?? sourceOrder.get(second.id) ?? 0),
        )
        .map((node, index) => ({
          ...node,
          x: startX + (index % 4) * 324,
          y: startY + Math.floor(index / 4) * 250,
        }));
    });
  }

  async function uploadIntentAttachments(files: File[]) {
    const uploaded: ChatAttachment[] = [];
    for (const file of files.slice(0, 8)) {
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
      });
    }
    return uploaded;
  }

  async function submitIntentServer(
    value: string,
    attachments: ChatAttachment[] = [],
    preferredCapabilityId?: string,
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
      const cap = capabilities.find((item) => item.title === task.capability);
      const model = models.find((item) => item.modalities.includes(kind));
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
        status: "queued",
        capabilityId: cap?.id ?? `core.capability.${kind}`,
        modelId: model?.id ?? "unconfigured",
        x: startX + level * 360,
        y: 140 + row * 260,
        createdAt: timestamp + index,
        progress: 0,
        parameters: task.parameters ?? {},
        layer: index,
      };
    });
    setNodes(plannedNodes);
    const nodeById = new Map(plannedNodes.map((node) => [node.id, node]));
    setEdges(plan.tasks.flatMap((task) => {
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
    }));
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
        let output: (KernelNodeOutput & { result?: string }) | null = null;
        try {
          output = task.outputJson
            ? (JSON.parse(task.outputJson) as KernelNodeOutput & {
                result?: string;
              })
            : null;
        } catch {
          output = null;
        }
        return {
          ...node,
          status: task.status,
          progress:
            task.status === "succeeded" || task.status === "failed" ? 100 : 0,
          ...(output?.result || output?.text
            ? { result: output.result ?? output.text }
            : task.error
              ? { result: `执行失败：${task.error}` }
              : {}),
          parameters: {
            ...node.parameters,
            ...(output ? { kernelOutput: output } : {}),
            ...(task.executor ? { kernelExecutor: task.executor } : {}),
            kernelRunId: runId,
          },
        };
      }),
    );
    setRunState(result.run.status);
    return result;
  }

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
    mode: "target" | "branch" = "target",
  ) {
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
        : graphForTarget(targetNodeId);
    try {
      compileWorkflow(graph.nodes, graph.edges);
    } catch (error) {
      setRunState("failed");
      setMessages((messages) => [
        ...messages,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content:
            error instanceof Error ? error.message : "工作流编译失败",
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
        currentNodes.map((node) =>
          included.has(node.id)
            ? { ...node, status: "queued", progress: 0 }
            : node,
        ),
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
      }
      if (!["paused", "waiting"].includes(dispatched.run.status)) {
        activeRun.current = null;
      }
    } catch (error) {
      setRunState("failed");
      activeRun.current = null;
      setMessages((messages) => [
        ...messages,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content:
            error instanceof Error ? error.message : "工作流执行失败",
          time: messageTime(),
        },
      ]);
    }
  }

  function rerunBranchServer(nodeId: string) {
    return startRunServer(nodeId, "branch");
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
        probe: { message: string; catalogCount?: number };
      }>("/api/v2/models/test", {
        method: "POST",
        body: JSON.stringify({ id, workspaceId }),
      });
      setModels((current) =>
        current.map((model) => (model.id === id ? payload.model : model)),
      );
      return payload.probe.catalogCount
        ? `${payload.probe.message}，已同步 ${payload.probe.catalogCount} 个可用模型。`
        : payload.probe.message;
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
    const result = await requestJson<{
      package: InstalledPackage;
      action: "installed" | "updated";
    }>("/api/v2/packages", {
      method: "POST",
      body: JSON.stringify({ workspaceId, manifest: payload }),
    });
    await refreshRegistry();
    return result;
  }

  async function setPackageEnabled(id: string, enabled: boolean) {
    await requestJson("/api/v2/packages", {
      method: "PATCH",
      body: JSON.stringify({ id, enabled, workspaceId }),
    });
    await refreshRegistry();
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
      folderId?: string | null;
      sourceType?: string;
      sourceRef?: string | null;
      tags?: string[];
    } = {},
  ) {
    const form = new FormData();
    form.set("file", file);
    if (metadata.folderId) form.set("folderId", metadata.folderId);
    if (metadata.sourceType) form.set("sourceType", metadata.sourceType);
    if (metadata.sourceRef) form.set("sourceRef", metadata.sourceRef);
    if (metadata.tags?.length) form.set("tags", metadata.tags.join(","));
    const result = await requestJson<{ asset: FileSystemAsset }>(
      `/api/v2/files?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "POST", body: form },
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
    capabilities,
    models,
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
    workspaceName,
    workspaceId,
    workspaces,
    switchWorkspace,
    projectId,
    projectName,
    projects,
    switchProject,
    createProject,
    renameProject,
    archiveProject,
    cloudStatus,
    cloudError,
    canvasViewport,
    setCanvasViewport,
    setActiveCanvasId,
    reloadActiveCanvas,
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
    beginNodeMove,
    moveNode,
    updateNode,
    addNode,
    addAssetToCanvas,
    deleteSelected,
    connectNodes,
    deleteEdge,
    undoCanvas,
    redoCanvas,
    copySelected,
    pasteCopied,
    arrangeNodes,
    submitIntent: submitIntentServer,
    uploadIntentAttachments,
    confirmPlan,
    updatePlan,
    rejectPlan,
    startRun: startRunServer,
    rerunBranch: rerunBranchServer,
    pauseRun: pauseRunServer,
    cancelRun: cancelRunServer,
    toggleCapability,
    testModel,
    refreshRegistry,
    installPackage,
    setPackageEnabled,
    uninstallPackage,
    testPlugin,
    createModel,
    updateModel,
    deleteModel,
    updatePreferences,
    uploadAsset,
  };
}

export type IntentOSController = ReturnType<typeof useIntentOS>;
