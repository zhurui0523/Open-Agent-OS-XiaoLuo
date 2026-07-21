export type AppView = "canvas" | "assets" | "capabilities";

export type NodeKind = "text" | "image" | "video";

export type NodeStatus =
  | "draft"
  | "waiting"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled";

export interface CanvasNode {
  id: string;
  title: string;
  prompt: string;
  kind: NodeKind;
  status: NodeStatus;
  capabilityId: string;
  modelId: string;
  x: number;
  y: number;
  progress?: number;
  result?: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasSummary {
  id: string;
  title: string;
  project: string;
  nodes: number;
  updatedAt: string;
  starred?: boolean;
}

export interface Capability {
  id: string;
  title: string;
  description: string;
  modality: NodeKind;
  category: "系统" | "自定义";
  enabled: boolean;
  packageVersion: string;
  parameterHint: string;
}

export interface ModelConnection {
  id: string;
  name: string;
  provider: string;
  modalities: NodeKind[];
  state: "healthy" | "checking" | "attention";
  latency: string;
}

export interface AssetItem {
  id: string;
  title: string;
  kind: "text" | "image" | "video" | "document";
  color: string;
  source: string;
  model: string;
  createdAt: string;
  tags: string[];
  description: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
}

export interface PlanTask {
  id: string;
  title: string;
  capability: string;
  duration: string;
}

export interface IntentPlan {
  goal: string;
  tasks: PlanTask[];
  estimate: string;
  warning?: string;
}

export type RunState =
  | "idle"
  | "awaiting_confirmation"
  | "ready"
  | "running"
  | "paused"
  | "succeeded"
  | "canceled";
