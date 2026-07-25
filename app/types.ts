export type AppView = "canvas" | "assets" | "capabilities";

export interface AccountUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
}

export interface OrganizationSummary {
  id: string;
  name: string;
  status: "pending" | "active" | "rejected" | "disabled";
  role: "admin" | "member" | null;
  membershipStatus: "active" | "disabled" | null;
  workspaceId: string | null;
  applicationStatus: "pending" | "approved" | "rejected" | null;
  createdAt: string;
}

export interface WorkspaceOption {
  id: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  kind: "personal" | "enterprise";
  organizationName: string | null;
  organizationRole: "admin" | "member" | null;
}

export type NodeKind = "text" | "image" | "video" | "audio" | "document";

export type PortDataType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "json";

export interface NodePort {
  id: string;
  label: string;
  direction: "input" | "output";
  dataTypes: PortDataType[];
  required?: boolean;
}

export type NodeStatus =
  | "draft"
  | "waiting"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled"
  | "skipped";

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
  createdAt?: number;
  progress?: number;
  result?: string;
  parameters?: Record<string, unknown>;
}

export interface KernelNodeOutput {
  type: "text" | "image" | "video" | "audio" | "document" | "json";
  text?: string;
  assetUrl?: string;
  data?: unknown;
  executor: string;
  preview?: boolean;
}

export interface KernelUpstreamInput {
  nodeId: string;
  title?: string;
  kind?: NodeKind;
  output: unknown;
}

export interface KernelExecuteResult {
  runId: string;
  nodeId: string;
  result: string;
  output: KernelNodeOutput;
  executor: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  dataType: PortDataType;
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
  category: "系统" | "SKILL" | "Agent" | "Workflow" | "插件";
  enabled: boolean;
  packageVersion: string;
  parameterHint: string;
  packageId?: string;
  contributionType?: "skill" | "agent" | "workflow" | "node";
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
  secretRefId?: string;
  priority: number;
  fallbackModelId?: string | null;
  maxConcurrency: number;
  retryLimit: number;
  circuitFailureThreshold: number;
  circuitCooldownSeconds: number;
  circuitState: "closed" | "open" | "half_open";
  activeRequests: number;
  catalogSyncedAt?: string | null;
  enabled?: boolean;
  lastCheckedAt?: string | null;
}

export type PackageType =
  | "skill"
  | "agent"
  | "workflow"
  | "plugin"
  | "model-provider"
  | "adapter";
export type PluginRuntimeType = "declarative" | "sandbox-ui" | "remote-api";
export type ModelProtocol =
  | "openai-compatible"
  | "anthropic-compatible"
  | "gemini"
  | "ark"
  | "async-video"
  | "generic-rest";

export interface InstalledPackage {
  id: string;
  packageKey?: string;
  name: string;
  version: string;
  description: string;
  packageType: PackageType;
  runtimeType: PluginRuntimeType;
  runtimeUrl?: string | null;
  permissions: string[];
  enabled: boolean;
  lifecycleState?: string;
  healthStatus?: string;
  integritySha256?: string;
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
  secretRefId?: string;
  secretValue?: string;
  secretName?: string;
  priority?: number;
  fallbackModelId?: string | null;
  maxConcurrency?: number;
  retryLimit?: number;
  circuitFailureThreshold?: number;
  circuitCooldownSeconds?: number;
}

export interface ModelUsageSummary {
  text: {
    total: number;
    success: number;
    failure: number;
  };
  image: {
    total: number;
    success: number;
    failure: number;
  };
  video: {
    total: number;
    success: number;
    failure: number;
  };
  retryCount: number;
  fallbackCount: number;
}

export type GesturePreset = "figma" | "trackpad" | "zoom-wheel";

export interface UserPreferences {
  gesturePreset: GesturePreset;
  invertZoom: boolean;
  zoomSensitivity: "slow" | "normal" | "fast";
  keyboardShortcuts: boolean;
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

export type AssetKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";

export interface FileSystemAsset {
  id: string;
  uri: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  size: number;
  folderId: string | null;
  tags: string[];
  description: string;
  sourceType: string;
  sourceRef: string | null;
  contentHash: string;
  favorite: boolean;
  currentVersion: number;
  versionCount: number;
  status: "ready" | "processing" | "failed" | "missing";
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contentUrl: string;
  downloadUrl: string;
}

export interface FileSystemFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  id: string;
  uri: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
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
  | "waiting"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled";
