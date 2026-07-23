"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  coreCapabilities,
  initialEdges,
  initialModels,
  initialNodes,
} from "../data";
import type {
  AppView,
  CanvasEdge,
  CanvasNode,
  Capability,
  ChatMessage,
  InstalledPackage,
  IntentPlan,
  KernelExecuteResult,
  ModelConnectionDraft,
  NodeKind,
  RegistryEvent,
  RegistrySnapshot,
  RunState,
} from "../types";
import { createIntentPlan, messageTime } from "../lib/intent-plan";
import {
  compileWorkflow,
  type CompiledWorkflow,
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
  resume?: () => void;
  controllers: Map<string, AbortController>;
  workflow: CompiledWorkflow;
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
  const [nodes, setNodes] = useState<CanvasNode[]>(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [capabilities, setCapabilities] =
    useState<Capability[]>(coreCapabilities);
  const [models, setModels] = useState(initialModels);
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [registryEvents, setRegistryEvents] = useState<RegistryEvent[]>([]);
  const [registryStatus, setRegistryStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [registryError, setRegistryError] = useState("");
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(
    "node_visual",
  );
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([
    "node_visual",
  ]);
  const [activeCanvasId, setActiveCanvasId] = useState("cv_campaign");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [activeTool, setActiveTool] = useState("select");
  const [arrangeMode, setArrangeMode] = useState<"free" | "time" | "type">(
    "free",
  );
  const [zoom, setZoom] = useState(92);
  const [runState, setRunState] = useState<RunState>("ready");
  const [isPlanning, setIsPlanning] = useState(false);
  const [plan, setPlan] = useState<IntentPlan | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "msg_welcome",
      role: "assistant",
      content:
        "我已经读取当前画布。你可以直接描述目标，我会先生成可检查的计划，再写入画布。",
      time: "14:20",
    },
  ]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const activeRun = useRef<ActiveKernelRun | null>(null);
  const canvasHistory = useRef<CanvasHistoryEntry[]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);

  const refreshRegistry = useCallback(async () => {
    setRegistryStatus("loading");
    try {
      const snapshot = await requestJson<RegistrySnapshot>("/api/v2/registry");
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
  }, []);

  useEffect(() => {
    void refreshRegistry();
  }, [refreshRegistry]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      activeRun.current?.controllers.forEach((controller) =>
        controller.abort(),
      );
    },
    [],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  function rememberCanvas() {
    canvasHistory.current = [
      ...canvasHistory.current.slice(-39),
      { nodes, edges, selectedNodeIds, arrangeMode },
    ];
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

  function deleteSelected() {
    const ids = selectedNodeIds.length
      ? selectedNodeIds
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    if (!ids.length) return;
    rememberCanvas();
    const selectedIds = new Set(ids);
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

  function connectNodes(source: string, target: string) {
    if (
      source === target ||
      !nodes.some((node) => node.id === source) ||
      !nodes.some((node) => node.id === target) ||
      edges.some((edge) => edge.source === source && edge.target === target)
    ) {
      return false;
    }
    rememberCanvas();
    setEdges((current) => [
      ...current,
      {
        id: `edge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        source,
        target,
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
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNodeIds(previous.selectedNodeIds);
    setSelectedNodeIdState(previous.selectedNodeIds.at(-1) ?? null);
    setArrangeMode(previous.arrangeMode);
    setHistoryDepth(canvasHistory.current.length);
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
        };
        const typeIndex: Record<NodeKind, number> = {
          text: 0,
          image: 0,
          video: 0,
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

  function submitIntent(value: string) {
    const intent = value.trim();
    if (!intent || isPlanning) return;
    setMessages((current) => [
      ...current,
      { id: `msg_${Date.now()}`, role: "user", content: intent, time: messageTime() },
    ]);
    setIsPlanning(true);
    setPlan(null);
    setRunState("idle");
    timers.current.push(
      setTimeout(() => {
        setPlan(createIntentPlan(intent));
        setRunState("awaiting_confirmation");
        setIsPlanning(false);
        setMessages((current) => [
          ...current,
          {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content:
              "计划已经生成。我优先保留了可编辑的脚本和视觉节点，并把耗时较长的视频生成放在最后。",
            time: messageTime(),
          },
        ]);
      }, 850),
    );
  }

  function confirmPlan() {
    if (!plan) return;
    rememberCanvas();
    const startX = 122;
    const plannedNodes: CanvasNode[] = plan.tasks.map((task, index) => {
      const kind: NodeKind = index === 2 ? "image" : index === 3 ? "video" : "text";
      const cap = capabilities.find((item) => item.title === task.capability);
      const model = models.find((item) => item.modalities.includes(kind));
      return {
        id: `planned_${index}_${Date.now()}`,
        title: task.title,
        prompt: `${plan.goal}｜${task.title}`,
        kind,
        status: "queued",
        capabilityId: cap?.id ?? "manual.text",
        modelId: model?.id ?? "unconfigured",
        x: startX + index * 285,
        y: index % 2 === 0 ? 160 : 330,
        createdAt: Date.now() + index,
        progress: 0,
      };
    });
    setNodes(plannedNodes);
    setEdges(
      plannedNodes.slice(0, -1).map((node, index) => ({
        id: `planned_edge_${index}`,
        source: node.id,
        target: plannedNodes[index + 1].id,
      })),
    );
    setSelectedNodeIdState(plannedNodes[0]?.id ?? null);
    setSelectedNodeIds(plannedNodes[0] ? [plannedNodes[0].id] : []);
    setPlan(null);
    setRunState("ready");
  }

  function startSimulatedRun() {
    if (!nodes.length) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunState("running");
    setNodes((current) =>
      current.map((node, index) => ({
        ...node,
        status: index === 0 ? "running" : "queued",
        progress: index === 0 ? 18 : 0,
      })),
    );
    nodes.forEach((node, index) => {
      timers.current.push(
        setTimeout(() => {
          setNodes((current) =>
            current.map((item, itemIndex) => {
              if (itemIndex < index) return { ...item, status: "succeeded", progress: 100 };
              if (itemIndex === index) return { ...item, status: "running", progress: 62 };
              return { ...item, status: "queued", progress: 0 };
            }),
          );
        }, 900 + index * 900),
      );
    });
    timers.current.push(
      setTimeout(() => {
        setNodes((current) =>
          current.map((node) => ({ ...node, status: "succeeded", progress: 100 })),
        );
        setRunState("succeeded");
        setMessages((current) => [
          ...current,
          {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content: "工作流已完成，4 个结果已进入资产库，并保留了画布、模型和能力来源。",
            time: messageTime(),
          },
        ]);
      }, 900 + nodes.length * 900),
    );
  }

  function pauseSimulatedRun() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunState("paused");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" ? { ...node, status: "paused" } : node,
      ),
    );
  }

  function cancelSimulatedRun() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunState("canceled");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" || node.status === "queued"
          ? { ...node, status: "canceled" }
          : node,
      ),
    );
  }

  async function updateKernelRun(
    runId: string,
    status: RunState | "queued",
    error?: string,
  ) {
    try {
      await requestJson("/api/v2/kernel/runs", {
        method: "PATCH",
        body: JSON.stringify({ runId, status, error }),
      });
    } catch {
      // The node execution result remains visible even if an audit update fails.
    }
  }

  async function waitForKernelResume(run: ActiveKernelRun) {
    if (!run.paused) return;
    await new Promise<void>((resolve) => {
      run.resume = resolve;
    });
    run.resume = undefined;
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

  async function startRun(targetNodeId?: string) {
    const currentRun = activeRun.current;
    if (currentRun?.paused) {
      currentRun.paused = false;
      currentRun.resume?.();
      setRunState("running");
      setNodes((current) =>
        current.map((node) =>
          node.status === "paused"
            ? { ...node, status: "running", progress: Math.max(18, node.progress ?? 0) }
            : node,
        ),
      );
      void updateKernelRun(currentRun.id, "running");
      return;
    }
    if (currentRun || !nodes.length) return;

    const graph = graphForTarget(targetNodeId);
    let workflow: CompiledWorkflow;
    try {
      workflow = compileWorkflow(graph.nodes, graph.edges);
    } catch (error) {
      const message = error instanceof Error ? error.message : "工作流编译失败";
      setRunState("failed");
      setMessages((current) => [
        ...current,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: `微内核拒绝执行：${message}`,
          time: messageTime(),
        },
      ]);
      return;
    }

    try {
      const created = await requestJson<{
        runId: string;
        levels: string[][];
      }>("/api/v2/kernel/runs", {
        method: "POST",
        body: JSON.stringify(graph),
      });
      const run: ActiveKernelRun = {
        id: created.runId,
        paused: false,
        canceled: false,
        controllers: new Map(),
        workflow,
      };
      activeRun.current = run;
      const includedIds = new Set(graph.nodes.map((node) => node.id));
      setRunState("running");
      setNodes((current) =>
        current.map((node) =>
          includedIds.has(node.id)
            ? { ...node, status: "queued", progress: 0 }
            : node,
        ),
      );
      await updateKernelRun(run.id, "running");

      for (const level of workflow.levels) {
        await waitForKernelResume(run);
        if (run.canceled) return;
        const levelIds = new Set(level);
        setNodes((current) =>
          current.map((node) =>
            levelIds.has(node.id)
              ? { ...node, status: "running", progress: 24 }
              : node,
          ),
        );

        const settled = await Promise.allSettled(
          level.map(async (nodeId) => {
            const controller = new AbortController();
            run.controllers.set(nodeId, controller);
            try {
              const response = await requestJson<KernelExecuteResult>(
                "/api/v2/kernel/execute",
                {
                  method: "POST",
                  body: JSON.stringify({ runId: run.id, nodeId }),
                  signal: controller.signal,
                },
              );
              setNodes((current) =>
                current.map((node) =>
                  node.id === nodeId
                    ? {
                        ...node,
                        status: "succeeded",
                        progress: 100,
                        result: response.result,
                        parameters: {
                          ...node.parameters,
                          kernelOutput: response.output,
                          kernelExecutor: response.executor,
                          kernelRunId: run.id,
                        },
                      }
                    : node,
                ),
              );
              return response;
            } catch (error) {
              if (run.canceled) throw error;
              const message =
                error instanceof Error ? error.message : "节点执行失败";
              setNodes((current) =>
                current.map((node) =>
                  node.id === nodeId
                    ? {
                        ...node,
                        status: "failed",
                        progress: 100,
                        result: `执行失败：${message}`,
                      }
                    : node,
                ),
              );
              throw error;
            } finally {
              run.controllers.delete(nodeId);
            }
          }),
        );
        const failed = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed) throw failed.reason;
      }

      if (!run.canceled) {
        setRunState("succeeded");
        await updateKernelRun(run.id, "succeeded");
        setMessages((current) => [
          ...current,
          {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content: targetNodeId
              ? "目标节点及其上游依赖已由 AI 微内核执行完成。"
              : `工作流执行完成：${graph.nodes.length} 个节点已按依赖关系运行，上游结果已传递给下游。`,
            time: messageTime(),
          },
        ]);
      }
    } catch (error) {
      const run = activeRun.current;
      if (run?.canceled) return;
      const message = error instanceof Error ? error.message : "工作流执行失败";
      setRunState("failed");
      if (run) await updateKernelRun(run.id, "failed", message);
      setNodes((current) =>
        current.map((node) =>
          node.status === "queued"
            ? { ...node, status: "canceled", progress: 0 }
            : node,
        ),
      );
      setMessages((current) => [
        ...current,
        {
          id: `msg_${Date.now()}`,
          role: "assistant",
          content: `工作流已停止：${message}`,
          time: messageTime(),
        },
      ]);
    } finally {
      const run = activeRun.current;
      run?.controllers.forEach((controller) => controller.abort());
      activeRun.current = null;
    }
  }

  function pauseRun() {
    const run = activeRun.current;
    if (!run || run.paused || run.canceled) return;
    run.paused = true;
    setRunState("paused");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" ? { ...node, status: "paused" } : node,
      ),
    );
    void updateKernelRun(run.id, "paused");
  }

  function cancelRun() {
    const run = activeRun.current;
    if (!run) return;
    run.canceled = true;
    run.controllers.forEach((controller) => controller.abort());
    run.resume?.();
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
    void updateKernelRun(run.id, "canceled");
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
        probe: { message: string };
      }>("/api/v2/models/test", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      setModels((current) =>
        current.map((model) => (model.id === id ? payload.model : model)),
      );
      return payload.probe.message;
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
      body: JSON.stringify(payload),
    });
    await refreshRegistry();
    return result;
  }

  async function setPackageEnabled(id: string, enabled: boolean) {
    await requestJson("/api/v2/packages", {
      method: "PATCH",
      body: JSON.stringify({ id, enabled }),
    });
    await refreshRegistry();
  }

  async function uninstallPackage(id: string) {
    await requestJson(`/api/v2/packages?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await refreshRegistry();
  }

  async function testPlugin(id: string) {
    return requestJson<{ ok: boolean; message: string; previewUrl?: string }>(
      "/api/v2/plugins/test",
      { method: "POST", body: JSON.stringify({ id }) },
    );
  }

  async function createModel(draft: ModelConnectionDraft) {
    const result = await requestJson<{ model: (typeof models)[number] }>(
      "/api/v2/models",
      { method: "POST", body: JSON.stringify(draft) },
    );
    await refreshRegistry();
    return result.model;
  }

  async function deleteModel(id: string) {
    await requestJson(`/api/v2/models?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
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
    activeCanvasId,
    setActiveCanvasId,
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
    isPlanning,
    plan,
    messages,
    canUndo: historyDepth > 0,
    beginNodeMove,
    moveNode,
    updateNode,
    addNode,
    deleteSelected,
    connectNodes,
    deleteEdge,
    undoCanvas,
    arrangeNodes,
    submitIntent,
    confirmPlan,
    startRun,
    pauseRun,
    cancelRun,
    toggleCapability,
    testModel,
    refreshRegistry,
    installPackage,
    setPackageEnabled,
    uninstallPackage,
    testPlugin,
    createModel,
    deleteModel,
  };
}

export type IntentOSController = ReturnType<typeof useIntentOS>;
