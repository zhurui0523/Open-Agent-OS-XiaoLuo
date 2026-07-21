"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  coreCapabilities,
  initialEdges,
  initialModels,
  initialNodes,
} from "../data";
import type {
  AppView,
  CanvasNode,
  Capability,
  ChatMessage,
  IntentPlan,
  NodeKind,
  RunState,
} from "../types";
import { createIntentPlan, messageTime } from "../lib/intent-plan";

export function useIntentOS() {
  const [view, setView] = useState<AppView>("canvas");
  const [nodes, setNodes] = useState<CanvasNode[]>(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [capabilities, setCapabilities] =
    useState<Capability[]>(coreCapabilities);
  const [models, setModels] = useState(initialModels);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    "node_visual",
  );
  const [activeCanvasId, setActiveCanvasId] = useState("cv_campaign");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [activeTool, setActiveTool] = useState("select");
  const [zoom, setZoom] = useState(92);
  const [runState, setRunState] = useState<RunState>("running");
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

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

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

  function addNode(kind: NodeKind = "text") {
    const id = `node_${Date.now()}`;
    const modalityModels = models.filter((model) =>
      model.modalities.includes(kind),
    );
    const modalityCapabilities = capabilities.filter(
      (capability) => capability.enabled && capability.modality === kind,
    );
    const next: CanvasNode = {
      id,
      title: kind === "image" ? "新图片节点" : kind === "video" ? "新视频节点" : "新文本节点",
      prompt: "在这里描述这个节点需要完成的任务。",
      kind,
      status: "draft",
      capabilityId: modalityCapabilities[0]?.id ?? "manual.text",
      modelId: modalityModels[0]?.id ?? "unconfigured",
      x: 320 + (nodes.length % 3) * 72,
      y: 250 + (nodes.length % 2) * 110,
    };
    setNodes((current) => [...current, next]);
    setSelectedNodeId(id);
  }

  function deleteSelected() {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) =>
      current.filter(
        (edge) =>
          edge.source !== selectedNodeId && edge.target !== selectedNodeId,
      ),
    );
    setSelectedNodeId(null);
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
    setSelectedNodeId(plannedNodes[0]?.id ?? null);
    setPlan(null);
    setRunState("ready");
  }

  function startRun() {
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

  function pauseRun() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunState("paused");
    setNodes((current) =>
      current.map((node) =>
        node.status === "running" ? { ...node, status: "paused" } : node,
      ),
    );
  }

  function cancelRun() {
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

  function toggleCapability(id: string) {
    setCapabilities((current) =>
      current.map((capability) =>
        capability.id === id
          ? { ...capability, enabled: !capability.enabled }
          : capability,
      ),
    );
  }

  function testModel(id: string) {
    setModels((current) =>
      current.map((model) =>
        model.id === id ? { ...model, state: "checking" } : model,
      ),
    );
    timers.current.push(
      setTimeout(() => {
        setModels((current) =>
          current.map((model) =>
            model.id === id
              ? { ...model, state: "healthy", latency: "926 ms" }
              : model,
          ),
        );
      }, 900),
    );
  }

  return {
    view,
    setView,
    nodes,
    edges,
    capabilities,
    models,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    activeCanvasId,
    setActiveCanvasId,
    drawerOpen,
    setDrawerOpen,
    consoleOpen,
    setConsoleOpen,
    activeTool,
    setActiveTool,
    zoom,
    setZoom,
    runState,
    isPlanning,
    plan,
    messages,
    moveNode,
    updateNode,
    addNode,
    deleteSelected,
    submitIntent,
    confirmPlan,
    startRun,
    pauseRun,
    cancelRun,
    toggleCapability,
    testModel,
  };
}

export type IntentOSController = ReturnType<typeof useIntentOS>;
