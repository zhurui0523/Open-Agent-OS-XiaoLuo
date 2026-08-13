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
  // 企业工作区（企业管理员空间）的存储用量
  storageUsedBytes: number;
  storageRemainingBytes: number;
}

export type NodeKind = "text" | "image" | "video" | "audio" | "document";

export type MediaPluginType = Extract<NodeKind, "image" | "video" | "audio">;

export interface PluginAssetContext {
  canvasId: string;
  nodeId: string;
  kind: ModelInputAssetKind;
  title: string;
  url: string;
  downloadUrl?: string;
  assetId?: string;
  mimeType?: string;
}

export interface PluginTextContext {
  canvasId: string;
  nodeId: string;
  kind: "text";
  title: string;
  content: string;
}

export type PortDataType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "json"
  | "asset"
  | "asset_list"
  | "collection";

export interface NodePort {
  id: string;
  label: string;
  direction: "input" | "output";
  dataTypes: PortDataType[];
  required?: boolean;
  cardinality?: "one" | "many";
  maxConnections?: number;
}

export type CanvasNodeRole = "material" | "plugin" | "execution" | "result";
export type NodeBatchMode = "combine" | "each" | "broadcast" | "aggregate";

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
  role?: CanvasNodeRole;
  status: NodeStatus;
  capabilityId: string;
  modelId: string;
  x: number;
  y: number;
  createdAt?: number;
  progress?: number;
  result?: string;
  parameters?: Record<string, unknown>;
  collapsed?: boolean;
  layer?: number;
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

export type CanvasGroupColor = "indigo" | "emerald" | "amber" | "rose";

export interface CanvasGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: CanvasGroupColor;
  createdAt?: number;
}

export interface CanvasSummary {
  id: string;
  title: string;
  project: string;
  nodes: number;
  updatedAt: string;
  starred?: boolean;
  enterpriseShared?: boolean;
  canManage?: boolean;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: "active" | "archived" | "trashed";
  createdAt: string;
  updatedAt: string;
}

export interface Capability {
  id: string;
  capabilityKey?: string;
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
  ports?: NodePort[];
  executionMode?: "model" | "remote" | "builtin";
  modelRequirements?: {
    required?: boolean;
    protocols?: ModelProtocol[];
    capabilityTags?: string[];
    modelIds?: string[];
  };
  instructions?: string;
}

export interface ModelConnection {
  id: string;
  name: string;
  provider: string;
  createdAt?: string;
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
  parameterSchema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  inputConstraints?: ModelInputConstraints;
  capabilityTags?: string[];
  createdBy?: string;
  ownerScope?: "personal" | "administrator";
  accessScope?: "personal" | "workspace";
  canManage?: boolean;
}

export type ModelInputAssetKind = "image" | "video" | "audio" | "document";

export interface ModelInputConstraints {
  maxTotal: number;
  maxByType: Record<ModelInputAssetKind, number>;
}

export interface CanvasAssetReference {
  sourceNodeId: string;
  assetId?: string;
  title: string;
  kind: ModelInputAssetKind;
  url?: string;
  mimeType?: string;
  status: NodeStatus;
}

export interface NodeInputAssetReference extends CanvasAssetReference {
  edgeId: string;
}

export type PackageType =
  | "skill"
  | "agent"
  | "workflow"
  | "plugin"
  | "model-provider"
  | "adapter";
export type PluginRuntimeType =
  | "declarative"
  | "sandbox-ui"
  | "remote-api"
  | "isolated-worker";
export type ModelProtocol =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-compatible"
  | "gemini"
  | "dall-e-3"
  | "runninghub-sparkvideo-mini-multimodal"
  | "runninghub-sparkvideo-multimodal"
  | "runninghub-minimax-h3"
  | "runninghub-seedance"
  | "runninghub-suno-v5"
  | "runninghub-rh-image-2"
  | "runninghub-nano-banana-2"
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
  trustState?: string;
  integritySha256?: string;
  installedAt: string;
  updatedAt: string;
  contributionCount: number;
  nodeContributions?: Array<{
    id: string;
    title: string;
    description: string;
    modality: NodeKind;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    uiSchema: Record<string, unknown>;
    ports: NodePort[];
  }>;
  runtimeLanguage?: "node" | "python" | "cli";
  createdBy?: string;
  ownerScope?: "personal" | "administrator";
  accessScope?: "personal" | "workspace" | "marketplace";
  availabilitySource?: "owned" | "added";
  canManage?: boolean;
  manifest?: Record<string, unknown>;
}

export interface PackageInstallResult {
  status?: "installed";
  package: InstalledPackage;
  action: "installed" | "updated";
  review?: {
    id: string;
    status: string;
    trustState: string;
    signatureVerified: boolean;
  };
  source?: {
    kind: "archive" | "github";
    archiveSha256: string;
    fileCount: number;
    checksumsVerified: boolean;
    fileName?: string;
    repository?: string;
    commit?: string;
    sourceKind?: "release" | "repository";
    runtimePreparation?: {
      prepared: boolean;
      reason: string;
    };
    generatedManifest?: boolean;
    executionReady?: boolean;
    compatibility?: GithubCompatibilityReport;
  };
}

export interface GithubCompatibilityReport {
  repository: string;
  commit: string;
  projectType:
    | "skill"
    | "static-web"
    | "frontend"
    | "node"
    | "python"
    | "mcp"
    | "openapi"
    | "docker"
    | "unknown";
  projectTypeLabel: string;
  adapterMode:
    | "declarative-skill"
    | "static-sandbox"
    | "isolated-build"
    | "remote-api"
    | "source-only";
  detectedEntrypoints: string[];
  detectedStack: string[];
  packageName: string | null;
  scripts: string[];
  hasServer: boolean;
  hasBuildOutput: boolean;
  issues: string[];
  requiredFiles: string[];
}

export type GithubPackageImportResult =
  | PackageInstallResult
  | {
      status: "needs_adaptation";
      compatibility: GithubCompatibilityReport;
      message: string;
    };

export interface MarketplacePackage {
  id: string;
  packageKey: string;
  name: string;
  version: string;
  description: string;
  packageType: "skill" | "plugin";
  runtimeType: PluginRuntimeType;
  permissions: string[];
  manifest: Record<string, unknown>;
  installed: boolean;
  publisher: {
    id: string;
    username: string;
    displayName: string;
    platformRole: "system_admin" | "user";
  };
  updatedAt: string;
}

export interface RegistryEvent {
  id: string;
  eventType: string;
  entityId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type WorkflowVisibility = "private" | "workspace" | "link" | "public";

export interface WorkflowMarketplaceItem {
  id: string;
  workflowKey: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  visibility: WorkflowVisibility;
  status: "draft" | "published" | "unlisted" | "archived";
  version: number;
  author: {
    id: string;
    username: string;
    displayName: string;
  };
  workspaceId: string;
  sourceCanvasId?: string | null;
  nodeCount: number;
  materialCount: number;
  pluginCount: number;
  executionCount: number;
  resultCount: number;
  installCount: number;
  requirements: {
    skills: Array<{ key: string; version?: string }>;
    plugins: Array<{ key: string; version?: string }>;
    models: Array<{
      modality: NodeKind;
      protocols?: ModelProtocol[];
      capabilityTags?: string[];
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RegistrySnapshot {
  packages: InstalledPackage[];
  capabilities: Capability[];
  models: ModelConnection[];
  modelProviders: ModelProviderTemplate[];
  events: RegistryEvent[];
}

export interface ModelProviderTemplate {
  id: string;
  packageId: string;
  packageVersion: string;
  title: string;
  protocol: ModelProtocol;
  baseUrl?: string;
  modalities: NodeKind[];
  parameterSchema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  inputConstraints?: ModelInputConstraints;
  capabilityTags?: string[];
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
  parameterSchema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  inputConstraints?: ModelInputConstraints;
  capabilityTags?: string[];
  accessScope?: "personal" | "workspace";
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
export type CanvasBackground = "day" | "night";

export interface UserPreferences {
  canvasBackground: CanvasBackground;
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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  mode?: "xiaoluo" | "quick_answer";
  attachments?: ChatAttachment[];
  resultNodeId?: string;
  resultKind?: NodeKind;
}

export interface ChatAttachment {
  id: string;
  uri: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  previewUrl?: string;
  sourceNodeId?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  capability: string;
  duration: string;
  kind: NodeKind;
  dependsOn: string[];
  parameters?: Record<string, unknown>;
}

export interface IntentGap {
  id: string;
  field: "deliverable" | "audience" | "duration" | "format" | "constraints";
  question: string;
  required: boolean;
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
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "succeeded"
  | "failed"
  | "canceled";
