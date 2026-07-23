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
  parameters?: Record<string, unknown>;
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
  category: "系统" | "SKILL" | "插件";
  enabled: boolean;
  packageVersion: string;
  parameterHint: string;
  packageId?: string;
  contributionType?: "skill" | "node";
  inputSchema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
}

export interface ModelConnection {
  id: string;
  name: string;
  provider: string;
  modalities: NodeKind[];
  state: "healthy" | "checking" | "attention";
  latency: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
  modelName?: string;
  credentialRef?: string;
  enabled?: boolean;
  lastCheckedAt?: string | null;
}

export type PackageType = "skill" | "plugin" | "model-provider";
export type PluginRuntimeType = "declarative" | "sandbox-ui" | "remote-api";
export type ModelProtocol =
  | "openai-compatible"
  | "anthropic-compatible"
  | "generic-rest";

export interface InstalledPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  packageType: PackageType;
  runtimeType: PluginRuntimeType;
  runtimeUrl?: string | null;
  permissions: string[];
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  contributionCount: number;
}

export interface RegistryEvent {
  id: string;
  eventType: string;
  entityId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface RegistrySnapshot {
  packages: InstalledPackage[];
  capabilities: Capability[];
  models: ModelConnection[];
  events: RegistryEvent[];
}

export interface ModelConnectionDraft {
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  modelName: string;
  modalities: NodeKind[];
  credentialRef?: string;
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
