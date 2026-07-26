import type {
  ModelProtocol,
  NodePort,
  NodeKind,
  PackageType,
  PluginRuntimeType,
} from "../types";

export const PACKAGE_SCHEMA_VERSION = "2.0";

export type JsonSchema = Record<string, unknown>;

export interface CapabilityContribution {
  id: string;
  title: string;
  description?: string;
  modality: NodeKind;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  uiSchema?: JsonSchema;
  ports?: NodePort[];
  executionMode?: "model" | "remote";
  modelRequirements?: {
    required?: boolean;
    protocols?: ModelProtocol[];
    capabilityTags?: string[];
    modelIds?: string[];
  };
}

export interface PanelContribution {
  id: string;
  title: string;
  entry?: string;
}

export interface ModelProviderContribution {
  id: string;
  title: string;
  protocol: ModelProtocol;
  baseUrl?: string;
  modalities?: NodeKind[];
  parameterSchema?: JsonSchema;
  uiSchema?: JsonSchema;
  capabilityTags?: string[];
}

export interface XiaoLuoPackageManifest {
  schemaVersion: "2.0";
  id: string;
  name: string;
  version: string;
  description?: string;
  type: PackageType;
  runtime: {
    type: PluginRuntimeType;
    entry?: string;
    language?: "node" | "python" | "cli";
    healthPath?: string;
    invokePath?: string;
  };
  permissions?: string[];
  contributes?: {
    skills?: CapabilityContribution[];
    agents?: CapabilityContribution[];
    workflows?: CapabilityContribution[];
    nodes?: CapabilityContribution[];
    panels?: PanelContribution[];
    modelProviders?: ModelProviderContribution[];
  };
}

export class ManifestValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("；"));
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

const packageIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+){1,}$/;
const contributionIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const allowedModalities = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
]);
const allowedProtocols = new Set([
  "openai-compatible",
  "anthropic-compatible",
  "gemini",
  "ark",
  "async-video",
  "generic-rest",
]);
const allowedPortTypes = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "json",
  "asset",
  "asset_list",
  "collection",
]);
const exactPermissions = new Set([
  "assets:read",
  "assets:write",
  "canvas:read",
  "canvas:write",
  "tasks:read",
  "tasks:write",
  "models:list",
  "models:invoke",
  "worker:node",
  "worker:python",
  "worker:cli",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validRemoteUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function validPackageEntry(value: string) {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("..") &&
    !value.includes(":") &&
    /^[A-Za-z0-9_./-]+$/.test(value)
  );
}

function validateContribution(
  value: unknown,
  path: string,
  issues: string[],
): value is CapabilityContribution {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象`);
    return false;
  }
  const id = safeString(value.id);
  const title = safeString(value.title);
  if (!contributionIdPattern.test(id)) issues.push(`${path}.id 格式无效`);
  if (!title) issues.push(`${path}.title 不能为空`);
  if (!allowedModalities.has(safeString(value.modality))) {
    issues.push(
      `${path}.modality 只支持 text、image、video、audio 或 document`,
    );
  }
  for (const key of ["inputSchema", "outputSchema", "uiSchema"]) {
    if (value[key] !== undefined && !isRecord(value[key])) {
      issues.push(`${path}.${key} 必须是 JSON 对象`);
    }
  }
  if (
    value.executionMode !== undefined &&
    !["model", "remote"].includes(safeString(value.executionMode))
  ) {
    issues.push(`${path}.executionMode 只支持 model 或 remote`);
  }
  if (value.ports !== undefined) {
    if (!Array.isArray(value.ports) || value.ports.length > 24) {
      issues.push(`${path}.ports 必须是最多 24 项的数组`);
    } else {
      const portIds = new Set<string>();
      const directions = new Set<string>();
      value.ports.forEach((port, index) => {
        const portPath = `${path}.ports[${index}]`;
        if (!isRecord(port)) {
          issues.push(`${portPath} 必须是对象`);
          return;
        }
        const portId = safeString(port.id);
        if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(portId)) {
          issues.push(`${portPath}.id 格式无效`);
        } else if (portIds.has(portId)) {
          issues.push(`${portPath}.id 不能重复`);
        }
        portIds.add(portId);
        if (!safeString(port.label)) issues.push(`${portPath}.label 不能为空`);
        if (!["input", "output"].includes(safeString(port.direction))) {
          issues.push(`${portPath}.direction 只支持 input 或 output`);
        } else {
          directions.add(safeString(port.direction));
        }
        if (
          !Array.isArray(port.dataTypes) ||
          !port.dataTypes.length ||
          port.dataTypes.some((item) => !allowedPortTypes.has(safeString(item)))
        ) {
          issues.push(`${portPath}.dataTypes 包含不支持的数据类型`);
        }
        if (
          port.cardinality !== undefined &&
          !["one", "many"].includes(safeString(port.cardinality))
        ) {
          issues.push(`${portPath}.cardinality 只支持 one 或 many`);
        }
        if (
          port.maxConnections !== undefined &&
          (!Number.isInteger(port.maxConnections) ||
            Number(port.maxConnections) < 1 ||
            Number(port.maxConnections) > 10_000)
        ) {
          issues.push(`${portPath}.maxConnections 必须是 1-10000 的整数`);
        }
      });
      if (value.ports.length && !directions.has("input")) {
        issues.push(`${path}.ports 至少需要一个输入端口`);
      }
      if (value.ports.length && !directions.has("output")) {
        issues.push(`${path}.ports 至少需要一个输出端口`);
      }
    }
  }
  if (value.modelRequirements !== undefined) {
    if (!isRecord(value.modelRequirements)) {
      issues.push(`${path}.modelRequirements 必须是对象`);
    } else {
      const requirements = value.modelRequirements;
      if (
        requirements.protocols !== undefined &&
        (!Array.isArray(requirements.protocols) ||
          requirements.protocols.some(
            (item) => !allowedProtocols.has(safeString(item)),
          ))
      ) {
        issues.push(`${path}.modelRequirements.protocols 包含不支持的协议`);
      }
      for (const key of ["capabilityTags", "modelIds"]) {
        if (
          requirements[key] !== undefined &&
          (!Array.isArray(requirements[key]) ||
            requirements[key].some((item) => !safeString(item)))
        ) {
          issues.push(`${path}.modelRequirements.${key} 必须是字符串数组`);
        }
      }
    }
  }
  return true;
}

export function parsePackagePayload(payload: unknown): XiaoLuoPackageManifest {
  const maybeEnvelope = isRecord(payload) && isRecord(payload.manifest)
    ? payload.manifest
    : payload;
  if (!isRecord(maybeEnvelope)) {
    throw new ManifestValidationError(["Package 必须是 JSON 对象"]);
  }

  const issues: string[] = [];
  const schemaVersion = safeString(maybeEnvelope.schemaVersion);
  const id = safeString(maybeEnvelope.id).toLowerCase();
  const name = safeString(maybeEnvelope.name);
  const version = safeString(maybeEnvelope.version);
  const type = safeString(maybeEnvelope.type) as PackageType;
  const runtime = isRecord(maybeEnvelope.runtime) ? maybeEnvelope.runtime : {};
  const runtimeType = safeString(runtime.type) as PluginRuntimeType;
  const runtimeEntry = safeString(runtime.entry);
  const runtimeLanguage = safeString(runtime.language) as
    | "node"
    | "python"
    | "cli";
  const contributes = isRecord(maybeEnvelope.contributes)
    ? maybeEnvelope.contributes
    : {};

  if (schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    issues.push(`schemaVersion 必须是 ${PACKAGE_SCHEMA_VERSION}`);
  }
  if (!packageIdPattern.test(id)) issues.push("id 必须是稳定的反向域名或命名空间标识");
  if (!name) issues.push("name 不能为空");
  if (!semverPattern.test(version)) issues.push("version 必须使用 SemVer，例如 1.0.0");
  if (
    !["skill", "agent", "workflow", "plugin", "model-provider", "adapter"].includes(
      type,
    )
  ) {
    issues.push(
      "type 只支持 skill、agent、workflow、plugin、model-provider 或 adapter",
    );
  }
  if (
    ![
      "declarative",
      "sandbox-ui",
      "remote-api",
      "isolated-worker",
    ].includes(runtimeType)
  ) {
    issues.push(
      "runtime.type 只支持 declarative、sandbox-ui、remote-api 或 isolated-worker",
    );
  }
  if (
    ["skill", "agent", "workflow"].includes(type) &&
    runtimeType !== "declarative"
  ) {
    issues.push(
      "Skill、Agent 与 Workflow Package 默认无代码执行权，runtime.type 必须是 declarative",
    );
  }
  if (
    (runtimeType === "sandbox-ui" || runtimeType === "remote-api") &&
    !validRemoteUrl(runtimeEntry)
  ) {
    issues.push("沙盒 UI 或远程 API 必须提供安全的 HTTPS runtime.entry");
  }
  if (runtimeType === "isolated-worker") {
    if (!["plugin", "adapter"].includes(type)) {
      issues.push("isolated-worker 仅允许 plugin 或 adapter Package 使用");
    }
    if (!["node", "python", "cli"].includes(runtimeLanguage)) {
      issues.push("isolated-worker 必须声明 runtime.language");
    }
    if (!validPackageEntry(runtimeEntry)) {
      issues.push("isolated-worker runtime.entry 必须是安全的包内相对路径");
    }
  }

  const permissions = Array.isArray(maybeEnvelope.permissions)
    ? maybeEnvelope.permissions.map(safeString).filter(Boolean)
    : [];
  permissions.forEach((permission) => {
    if (
      !exactPermissions.has(permission) &&
      !(permission.startsWith("network:https://") && validRemoteUrl(permission.slice(8)))
    ) {
      issues.push(`不支持的权限：${permission}`);
    }
  });
  if (runtimeType === "remote-api") {
    const origin =
      runtimeEntry && validRemoteUrl(runtimeEntry)
        ? new URL(runtimeEntry).origin
        : "";
    if (origin && !permissions.includes(`network:${origin}`)) {
      issues.push(`远程 API 必须声明精确网络权限 network:${origin}`);
    }
  }
  if (
    runtimeType === "isolated-worker" &&
    runtimeLanguage &&
    !permissions.includes(`worker:${runtimeLanguage}`)
  ) {
    issues.push(
      `isolated-worker 必须声明执行权限 worker:${runtimeLanguage}`,
    );
  }

  const skills = Array.isArray(contributes.skills) ? contributes.skills : [];
  const agents = Array.isArray(contributes.agents) ? contributes.agents : [];
  const workflows = Array.isArray(contributes.workflows)
    ? contributes.workflows
    : [];
  const nodes = Array.isArray(contributes.nodes) ? contributes.nodes : [];
  skills.forEach((item, index) =>
    validateContribution(item, `contributes.skills[${index}]`, issues),
  );
  nodes.forEach((item, index) =>
    validateContribution(item, `contributes.nodes[${index}]`, issues),
  );
  agents.forEach((item, index) =>
    validateContribution(item, `contributes.agents[${index}]`, issues),
  );
  workflows.forEach((item, index) =>
    validateContribution(item, `contributes.workflows[${index}]`, issues),
  );
  [...skills, ...agents, ...workflows, ...nodes].forEach((item) => {
    if (isRecord(item) && !safeString(item.id).startsWith(`${id}.`)) {
      issues.push(`贡献项 ${safeString(item.id)} 必须使用 Package ID 作为命名空间`);
    }
  });
  if (type === "skill" && skills.length === 0) {
    issues.push("Skill Package 至少需要声明一个 contributes.skills 项");
  }
  if (type === "agent" && agents.length === 0) {
    issues.push("Agent Package 至少需要声明一个 contributes.agents 项");
  }
  if (type === "workflow" && workflows.length === 0) {
    issues.push("Workflow Package 至少需要声明一个 contributes.workflows 项");
  }

  const panels = Array.isArray(contributes.panels) ? contributes.panels : [];
  panels.forEach((item, index) => {
    if (!isRecord(item) || !safeString(item.id) || !safeString(item.title)) {
      issues.push(`contributes.panels[${index}] 缺少 id 或 title`);
    } else if (!safeString(item.id).startsWith(`${id}.`)) {
      issues.push(`面板 ${safeString(item.id)} 必须使用 Package ID 作为命名空间`);
    }
  });
  if (runtimeType === "sandbox-ui" && panels.length === 0) {
    issues.push("sandbox-ui 插件至少需要声明一个 contributes.panels 项");
  }

  const providers = Array.isArray(contributes.modelProviders)
    ? contributes.modelProviders
    : [];
  providers.forEach((item, index) => {
    if (
      !isRecord(item) ||
      !safeString(item.id) ||
      !safeString(item.title) ||
      !allowedProtocols.has(safeString(item.protocol))
    ) {
      issues.push(`contributes.modelProviders[${index}] 定义无效`);
    } else if (!safeString(item.id).startsWith(`${id}.`)) {
      issues.push(`模型 Provider ${safeString(item.id)} 必须使用 Package ID 作为命名空间`);
    }
  });

  if (runtimeType !== "remote-api") {
    (
      [
        ["skills", skills],
        ["agents", agents],
        ["workflows", workflows],
        ["nodes", nodes],
      ] as const
    ).forEach(([group, items]) => {
      items.forEach((item, index) => {
        if (isRecord(item) && safeString(item.executionMode) === "remote") {
          issues.push(
            `contributes.${group}[${index}].executionMode=remote 仅适用于 remote-api Runtime`,
          );
        }
      });
    });
  }

  providers.forEach((item, index) => {
    if (!isRecord(item)) return;
    if (
      item.baseUrl !== undefined &&
      safeString(item.baseUrl) &&
      !validRemoteUrl(safeString(item.baseUrl))
    ) {
      issues.push(
        `contributes.modelProviders[${index}].baseUrl 必须是安全 HTTPS 地址`,
      );
    }
    if (
      item.modalities !== undefined &&
      (!Array.isArray(item.modalities) ||
        item.modalities.some(
          (modality) => !allowedModalities.has(safeString(modality)),
        ))
    ) {
      issues.push(
        `contributes.modelProviders[${index}].modalities 包含不支持的模态`,
      );
    }
    for (const key of ["parameterSchema", "uiSchema"]) {
      if (item[key] !== undefined && !isRecord(item[key])) {
        issues.push(
          `contributes.modelProviders[${index}].${key} 必须是 JSON 对象`,
        );
      }
    }
    if (
      item.capabilityTags !== undefined &&
      (!Array.isArray(item.capabilityTags) ||
        item.capabilityTags.some((tag) => !safeString(tag)))
    ) {
      issues.push(
        `contributes.modelProviders[${index}].capabilityTags 必须是字符串数组`,
      );
    }
  });

  if (issues.length) throw new ManifestValidationError(issues);

  return {
    schemaVersion: "2.0",
    id,
    name,
    version,
    description: safeString(maybeEnvelope.description),
    type,
    runtime: {
      type: runtimeType,
      ...(runtimeEntry ? { entry: runtimeEntry } : {}),
      ...(runtimeLanguage ? { language: runtimeLanguage } : {}),
      ...(safeString(runtime.healthPath)
        ? { healthPath: safeString(runtime.healthPath) }
        : {}),
      ...(safeString(runtime.invokePath)
        ? { invokePath: safeString(runtime.invokePath) }
        : {}),
    },
    permissions: [...new Set(permissions)],
    contributes: {
      skills: skills as CapabilityContribution[],
      agents: agents as CapabilityContribution[],
      workflows: workflows as CapabilityContribution[],
      nodes: nodes as CapabilityContribution[],
      panels: panels as PanelContribution[],
      modelProviders: providers as ModelProviderContribution[],
    },
  };
}

export function packageContributionCount(manifest: XiaoLuoPackageManifest) {
  const contributes = manifest.contributes ?? {};
  return (
    (contributes.skills?.length ?? 0) +
    (contributes.agents?.length ?? 0) +
    (contributes.workflows?.length ?? 0) +
    (contributes.nodes?.length ?? 0) +
    (contributes.panels?.length ?? 0) +
    (contributes.modelProviders?.length ?? 0)
  );
}
