import type {
  CanvasEdge,
  CanvasNode,
  ModelProtocol,
  NodeKind,
  WorkflowMarketplaceItem,
} from "../types";
import { roleForNode } from "./node-role.ts";
import { compileWorkflow } from "./workflow-kernel.ts";

export interface WorkflowGraphSnapshot {
  title?: string;
  arrangeMode?: "free" | "time" | "type";
  viewport?: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type WorkflowRequirements = WorkflowMarketplaceItem["requirements"];

const secretKeyPattern =
  /(api.?key|secret|token|password|credential|authorization|cookie|session|cipher|private.?key)/i;
const privateAssetKeyPattern =
  /^(assetId|assetUri|assetContentUrl|assetDownloadUrl|sourceRef|kernelOutput)$/i;

function cleanValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => cleanValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKeyPattern.test(key) || privateAssetKeyPattern.test(key)) continue;
    result[key] = cleanValue(item, depth + 1);
  }
  return result;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function capabilitySnapshot(node: CanvasNode) {
  const snapshot = node.parameters?.capabilitySnapshot;
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : null;
}

export function workflowRequirements(
  nodes: CanvasNode[],
): WorkflowRequirements {
  const skills = new Map<string, { key: string; version?: string }>();
  const plugins = new Map<string, { key: string; version?: string }>();
  const models = new Map<
    string,
    {
      modality: NodeKind;
      protocols?: ModelProtocol[];
      capabilityTags?: string[];
    }
  >();

  nodes.forEach((node) => {
    const role = roleForNode(node);
    const snapshot = capabilitySnapshot(node);
    if (role === "execution") {
      const key = String(
        snapshot?.capabilityKey ?? node.parameters?.capabilityKey ?? "",
      );
      if (key) {
        skills.set(key, {
          key,
          ...(snapshot?.packageVersion
            ? { version: String(snapshot.packageVersion) }
            : {}),
        });
      }
      const requirements =
        snapshot?.modelRequirements &&
        typeof snapshot.modelRequirements === "object" &&
        !Array.isArray(snapshot.modelRequirements)
          ? (snapshot.modelRequirements as Record<string, unknown>)
          : {};
      const protocols = stringArray(requirements.protocols).filter(
        (item): item is ModelProtocol =>
          [
            "openai-compatible",
            "anthropic-compatible",
            "gemini",
            "ark",
            "async-video",
            "generic-rest",
          ].includes(item),
      );
      const capabilityTags = stringArray(requirements.capabilityTags);
      const modelKey = `${node.kind}:${protocols.join(",")}:${capabilityTags.join(",")}`;
      models.set(modelKey, {
        modality: node.kind,
        ...(protocols.length ? { protocols } : {}),
        ...(capabilityTags.length ? { capabilityTags } : {}),
      });
    }
    if (role === "plugin") {
      const key = String(
        node.parameters?.packageKey ?? snapshot?.packageKey ?? "",
      );
      if (key) {
        plugins.set(key, {
          key,
          ...(node.parameters?.packageVersion
            ? { version: String(node.parameters.packageVersion) }
            : snapshot?.packageVersion
              ? { version: String(snapshot.packageVersion) }
              : {}),
        });
      }
    }
  });
  return {
    skills: [...skills.values()],
    plugins: [...plugins.values()],
    models: [...models.values()],
  };
}

export function sanitizeWorkflowGraph(
  graph: WorkflowGraphSnapshot,
): {
  graph: WorkflowGraphSnapshot;
  requirements: WorkflowRequirements;
  counts: {
    nodeCount: number;
    materialCount: number;
    pluginCount: number;
    executionCount: number;
    resultCount: number;
  };
} {
  compileWorkflow(graph.nodes, graph.edges);
  let materialIndex = 0;
  const nodes = graph.nodes.map((node) => {
    const role = roleForNode(node);
    const cleanedParameters = cleanValue(node.parameters ?? {}) as Record<
      string,
      unknown
    >;
    const snapshot =
      cleanedParameters.capabilitySnapshot &&
      typeof cleanedParameters.capabilitySnapshot === "object" &&
      !Array.isArray(cleanedParameters.capabilitySnapshot)
        ? (cleanedParameters.capabilitySnapshot as Record<string, unknown>)
        : null;
    if (snapshot) {
      delete snapshot.id;
      delete snapshot.packageId;
    }
    if (role === "material") materialIndex += 1;
    const materialTitle =
      role === "material"
        ? `${{
            text: "文本",
            image: "图片",
            video: "视频",
            audio: "音频",
            document: "文件",
          }[node.kind]}素材 ${materialIndex}`
        : node.title;
    const materialParameters =
      role === "material"
        ? {
            nodeRole: "material",
            placeholder: true,
            accepts: [node.kind],
            source: "workflow-placeholder",
          }
        : cleanedParameters;
    return {
      ...node,
      title: materialTitle,
      prompt:
        role === "material"
          ? "安装后请从资产中心拖入或上传素材。"
          : role === "result"
            ? "等待上游执行完成后自动写入结果。"
            : node.prompt,
      role,
      status: role === "result" ? ("waiting" as const) : ("draft" as const),
      capabilityId:
        role === "execution"
          ? String(snapshot?.capabilityKey ?? "unconfigured-skill")
          : role === "plugin"
            ? "core.plugin.runner"
            : role === "result"
              ? "core.result.placeholder"
              : "core.material.source",
      modelId:
        role === "execution" &&
        snapshot?.executionMode === "remote"
          ? "skill-runtime"
          : role === "execution"
            ? "unconfigured"
            : role === "plugin"
              ? "plugin-runtime"
              : "none",
      progress: undefined,
      result: undefined,
      parameters: {
        ...materialParameters,
        nodeRole: role,
        ...(role === "result" ? { resultSlot: true } : {}),
      },
    };
  });
  const sanitized: WorkflowGraphSnapshot = {
    title: graph.title,
    arrangeMode: graph.arrangeMode ?? "free",
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 92 },
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
  compileWorkflow(sanitized.nodes, sanitized.edges);
  const roles = nodes.map(roleForNode);
  return {
    graph: sanitized,
    requirements: workflowRequirements(nodes),
    counts: {
      nodeCount: nodes.length,
      materialCount: roles.filter((role) => role === "material").length,
      pluginCount: roles.filter((role) => role === "plugin").length,
      executionCount: roles.filter((role) => role === "execution").length,
      resultCount: roles.filter((role) => role === "result").length,
    },
  };
}

export async function workflowIntegrity(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function workflowTokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function workflowCounts(nodes: CanvasNode[]) {
  const roles = nodes.map(roleForNode);
  return {
    nodeCount: nodes.length,
    materialCount: roles.filter((role) => role === "material").length,
    pluginCount: roles.filter((role) => role === "plugin").length,
    executionCount: roles.filter((role) => role === "execution").length,
    resultCount: roles.filter((role) => role === "result").length,
  };
}
