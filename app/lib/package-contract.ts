import type {
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
}

export interface PanelContribution {
  id: string;
  title: string;
  entry?: string;
}

export interface ModelProviderContribution {
  id: string;
  title: string;
  protocol: "openai-compatible" | "anthropic-compatible" | "generic-rest";
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
    healthPath?: string;
    invokePath?: string;
  };
  permissions?: string[];
  contributes?: {
    skills?: CapabilityContribution[];
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
const allowedModalities = new Set(["text", "image", "video"]);
const exactPermissions = new Set([
  "assets:read",
  "assets:write",
  "canvas:read",
  "canvas:write",
  "tasks:read",
  "tasks:write",
  "models:list",
  "models:invoke",
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
    issues.push(`${path}.modality 只支持 text、image 或 video`);
  }
  for (const key of ["inputSchema", "outputSchema", "uiSchema"]) {
    if (value[key] !== undefined && !isRecord(value[key])) {
      issues.push(`${path}.${key} 必须是 JSON 对象`);
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
  const contributes = isRecord(maybeEnvelope.contributes)
    ? maybeEnvelope.contributes
    : {};

  if (schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    issues.push(`schemaVersion 必须是 ${PACKAGE_SCHEMA_VERSION}`);
  }
  if (!packageIdPattern.test(id)) issues.push("id 必须是稳定的反向域名或命名空间标识");
  if (!name) issues.push("name 不能为空");
  if (!semverPattern.test(version)) issues.push("version 必须使用 SemVer，例如 1.0.0");
  if (!["skill", "plugin", "model-provider"].includes(type)) {
    issues.push("type 只支持 skill、plugin 或 model-provider");
  }
  if (!["declarative", "sandbox-ui", "remote-api"].includes(runtimeType)) {
    issues.push("runtime.type 只支持 declarative、sandbox-ui 或 remote-api");
  }
  if (type === "skill" && runtimeType !== "declarative") {
    issues.push("Skill Package 默认无代码执行权，runtime.type 必须是 declarative");
  }
  if (runtimeType !== "declarative" && !validRemoteUrl(runtimeEntry)) {
    issues.push("沙盒 UI 或远程 API 必须提供安全的 HTTPS runtime.entry");
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

  const skills = Array.isArray(contributes.skills) ? contributes.skills : [];
  const nodes = Array.isArray(contributes.nodes) ? contributes.nodes : [];
  skills.forEach((item, index) =>
    validateContribution(item, `contributes.skills[${index}]`, issues),
  );
  nodes.forEach((item, index) =>
    validateContribution(item, `contributes.nodes[${index}]`, issues),
  );
  [...skills, ...nodes].forEach((item) => {
    if (isRecord(item) && !safeString(item.id).startsWith(`${id}.`)) {
      issues.push(`贡献项 ${safeString(item.id)} 必须使用 Package ID 作为命名空间`);
    }
  });
  if (type === "skill" && skills.length === 0) {
    issues.push("Skill Package 至少需要声明一个 contributes.skills 项");
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
      !["openai-compatible", "anthropic-compatible", "generic-rest"].includes(
        safeString(item.protocol),
      )
    ) {
      issues.push(`contributes.modelProviders[${index}] 定义无效`);
    } else if (!safeString(item.id).startsWith(`${id}.`)) {
      issues.push(`模型 Provider ${safeString(item.id)} 必须使用 Package ID 作为命名空间`);
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
    (contributes.nodes?.length ?? 0) +
    (contributes.panels?.length ?? 0) +
    (contributes.modelProviders?.length ?? 0)
  );
}
