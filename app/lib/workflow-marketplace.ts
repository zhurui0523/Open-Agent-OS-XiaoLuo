import { and, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "../../db";
import { assets, assetVersions } from "../../db/schema";
import type {
  CanvasEdge,
  CanvasGroup,
  CanvasNode,
  ModelProtocol,
  NodeKind,
  WorkflowMarketplaceItem,
} from "../types";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  sha256Hex,
  storeAsset,
} from "./asset-kernel";
import { roleForNode } from "./node-role.ts";
import { compileWorkflow } from "./workflow-kernel.ts";

type Database = Awaited<ReturnType<typeof getDb>>;

export interface WorkflowGraphSnapshot {
  title?: string;
  arrangeMode?: "free" | "time" | "type";
  viewport?: { x: number; y: number; zoom: number };
  groups?: CanvasGroup[];
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
            "openai-responses",
            "anthropic-compatible",
            "gemini",
            "dall-e-3",
            "runninghub-sparkvideo-mini-multimodal",
            "runninghub-sparkvideo-multimodal",
            "runninghub-minimax-h3",
            "runninghub-seedance",
            "runninghub-suno-v5",
            "runninghub-rh-image-2",
            "runninghub-nano-banana-2",
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
      parameters: (() => {
        const next: Record<string, unknown> = {
          ...materialParameters,
          nodeRole: role,
          ...(role === "result" ? { resultSlot: true } : {}),
        };
        delete next.kernelRunId;
        return next;
      })(),
    };
  });
  const sanitized: WorkflowGraphSnapshot = {
    title: graph.title,
    arrangeMode: graph.arrangeMode ?? "free",
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 100 },
    groups: (graph.groups ?? []).map((group) => ({
      ...group,
      title: group.title.trim().slice(0, 120) || "节点群",
    })),
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


export interface WorkflowAssetBundle {
  nodeId: string;
  title?: string;
  prompt?: string;
  kind?: "material" | "result";
  text?: string;
  name: string;
  mimeType: string;
  size: number;
  contentHash: string;
  blobKey: string;
}

const MAX_BUNDLED_ASSETS = 64;
const MAX_RESULT_TEXT_CHARS = 40_000;
const MAX_REMOTE_RESULT_BYTES = 40 * 1024 * 1024;

function bundleTextResult(node: CanvasNode): string {
  const kernelOutput =
    node.parameters?.kernelOutput &&
    typeof node.parameters.kernelOutput === "object"
      ? (node.parameters.kernelOutput as {
          text?: unknown;
          data?: unknown;
        })
      : null;
  const kernelText =
    typeof kernelOutput?.text === "string" ? kernelOutput.text.trim() : "";
  const nodeText = typeof node.result === "string" ? node.result.trim() : "";
  if (kernelText) return kernelText.slice(0, MAX_RESULT_TEXT_CHARS);
  if (nodeText) return nodeText.slice(0, MAX_RESULT_TEXT_CHARS);
  if (kernelOutput && kernelOutput.data !== undefined && kernelOutput.data !== null) {
    if (typeof kernelOutput.data === "string") {
      return kernelOutput.data.slice(0, MAX_RESULT_TEXT_CHARS);
    }
    try {
      return JSON.stringify(kernelOutput.data, null, 2).slice(
        0,
        MAX_RESULT_TEXT_CHARS,
      );
    } catch {
      return String(kernelOutput.data).slice(0, MAX_RESULT_TEXT_CHARS);
    }
  }
  return "";
}

async function downloadRemoteResultAsset(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_REMOTE_RESULT_BYTES) {
      return null;
    }
    const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim();
    return {
      bytes,
      mimeType: mimeType || "application/octet-stream",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectWorkflowAssetBundles(
  db: Database,
  workspaceId: string,
  nodes: CanvasNode[],
): Promise<WorkflowAssetBundle[]> {
  const bundles: WorkflowAssetBundle[] = [];
  const materialNodes = nodes.filter(
    (node) =>
      roleForNode(node) === "material" &&
      typeof node.parameters?.assetId === "string" &&
      Boolean(node.parameters.assetId),
  );
  const assetIds = [
    ...new Set(
      materialNodes
        .map((node) => String(node.parameters?.assetId))
        .filter(Boolean),
    ),
  ].slice(0, MAX_BUNDLED_ASSETS);
  if (assetIds.length) {
    const rows = await db
      .select({ asset: assets, version: assetVersions })
      .from(assets)
      .innerJoin(
        assetVersions,
        eq(assetVersions.id, assets.currentVersionId ?? ""),
      )
      .where(
        and(
          inArray(assets.id, assetIds),
          eq(assets.workspaceId, workspaceId),
          eq(assets.status, "ready"),
          isNull(assets.trashedAt),
        ),
      );
    const rowByAssetId = new Map(rows.map((row) => [row.asset.id, row]));
    for (const node of materialNodes.slice(0, MAX_BUNDLED_ASSETS)) {
      const row = rowByAssetId.get(String(node.parameters?.assetId));
      if (!row || row.version.size > MAX_FILE_BYTES) continue;
      bundles.push({
        nodeId: node.id,
        title: node.title,
        prompt: node.prompt,
        kind: "material",
        name: row.asset.name,
        mimeType: row.asset.mimeType,
        size: row.version.size,
        contentHash: row.version.contentHash,
        blobKey: row.version.blobKey,
      });
    }
  }

  for (const node of nodes) {
    if (bundles.length >= MAX_BUNDLED_ASSETS) break;
    if (roleForNode(node) !== "result" || node.status !== "succeeded") continue;
    if (node.kind === "text") {
      const text = bundleTextResult(node);
      if (!text) continue;
      bundles.push({
        nodeId: node.id,
        title: node.title,
        prompt: node.prompt,
        kind: "result",
        text,
        name: "",
        mimeType: "text/plain",
        size: 0,
        contentHash: "",
        blobKey: "",
      });
      continue;
    }
    if (!["image", "video", "audio", "document"].includes(node.kind)) continue;
    const kernelOutput =
      node.parameters?.kernelOutput &&
      typeof node.parameters.kernelOutput === "object"
        ? (node.parameters.kernelOutput as {
            assetUrl?: unknown;
            data?: unknown;
          })
        : null;
    const outputData =
      kernelOutput?.data && typeof kernelOutput.data === "object"
        ? (kernelOutput.data as Record<string, unknown>)
        : null;
    const mediaUrl =
      (typeof kernelOutput?.assetUrl === "string" && kernelOutput.assetUrl) ||
      (typeof node.parameters?.assetContentUrl === "string" &&
        node.parameters.assetContentUrl) ||
      "";
    const urlAssetIdMatch = mediaUrl.match(/[?&]assetId=([^&]+)/);
    const resultAssetId =
      (typeof outputData?.assetId === "string" && outputData.assetId) ||
      (urlAssetIdMatch ? decodeURIComponent(urlAssetIdMatch[1]) : "");
    if (resultAssetId) {
      const [row] = await db
        .select({ asset: assets, version: assetVersions })
        .from(assets)
        .innerJoin(
          assetVersions,
          eq(assetVersions.id, assets.currentVersionId ?? ""),
        )
        .where(
          and(
            eq(assets.id, resultAssetId),
            eq(assets.workspaceId, workspaceId),
            eq(assets.status, "ready"),
            isNull(assets.trashedAt),
          ),
        )
        .limit(1);
      if (!row || row.version.size > MAX_FILE_BYTES) continue;
      bundles.push({
        nodeId: node.id,
        title: node.title,
        prompt: node.prompt,
        kind: "result",
        name: row.asset.name,
        mimeType: row.asset.mimeType,
        size: row.version.size,
        contentHash: row.version.contentHash,
        blobKey: row.version.blobKey,
      });
      continue;
    }
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) continue;
    const downloaded = await downloadRemoteResultAsset(mediaUrl);
    if (!downloaded) continue;
    const hash = await sha256Hex(downloaded.bytes);
    const blobKey = `blobs/sha256/${hash}`;
    const bucket = await getFileBucket();
    try {
      const existing = await bucket.get(blobKey);
      if (!existing) {
        await bucket.put(blobKey, downloaded.bytes, {
          httpMetadata: { contentType: downloaded.mimeType },
          customMetadata: {
            sha256: hash,
            originalName: `${node.title || "生成结果"}.${downloaded.mimeType.split("/")[1] ?? "bin"}`,
          },
        });
      }
    } catch {
      continue;
    }
    bundles.push({
      nodeId: node.id,
      title: node.title,
      prompt: node.prompt,
      kind: "result",
      name: `${node.title || "生成结果"}.${downloaded.mimeType.split("/")[1] ?? "bin"}`,
      mimeType: downloaded.mimeType,
      size: downloaded.bytes.byteLength,
      contentHash: hash,
      blobKey,
    });
  }
  return bundles;
}

export async function applyWorkflowAssetBundles(options: {
  db: Database;
  workspaceId: string;
  nodes: CanvasNode[];
  bundles: WorkflowAssetBundle[];
  sourceRef?: string | null;
}): Promise<number> {
  const { db, workspaceId, nodes, bundles } = options;
  if (!bundles.length || !nodes.length) return 0;
  const bundleByNodeId = new Map(
    bundles.map((bundle) => [bundle.nodeId, bundle]),
  );
  const targetNodes = nodes.filter((node) => bundleByNodeId.has(node.id));
  if (!targetNodes.length) return 0;
  const bucket = await getFileBucket();
  let restored = 0;
  for (const node of targetNodes) {
    const bundle = bundleByNodeId.get(node.id);
    if (!bundle) continue;
    if (bundle.kind === "result" && bundle.text && !bundle.blobKey) {
      node.title = bundle.title || node.title;
      node.prompt = bundle.prompt ?? node.prompt;
      node.status = "succeeded";
      node.result = bundle.text;
      if (node.parameters && typeof node.parameters === "object") {
        const params = node.parameters as Record<string, unknown>;
        delete params.kernelRunId;
      }
      restored += 1;
      continue;
    }
    try {
      const object = await bucket.get(bundle.blobKey);
      if (!object?.body) continue;
      const bytes = await new Response(
        object.body as ReadableStream,
      ).arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength !== bundle.size) continue;
      const asset = await storeAsset(db, bucket, {
        workspaceId,
        name: bundle.name,
        mimeType: bundle.mimeType,
        bytes,
        sourceType: "workflow-install",
        sourceRef: options.sourceRef ?? null,
      });
      const isResult = bundle.kind === "result";
      node.title = bundle.title || node.title;
      node.prompt = bundle.prompt ?? node.prompt;
      node.status = "succeeded";
      node.result = isResult ? "已从共享画布还原生成结果" : "已从共享画布还原素材";
      node.parameters = {
        ...(node.parameters ?? {}),
        nodeRole: isResult ? "result" : "material",
        source: isResult ? "asset-kernel" : "workflow-install",
        assetId: asset.id,
        assetUri: asset.uri,
        assetContentUrl: asset.contentUrl,
        fileName: asset.name,
        mimeType: asset.mimeType,
      };
      if (isResult) {
        node.parameters.kernelOutput = {
          type: node.kind,
          assetUrl: asset.contentUrl,
          data: {
            assetId: asset.id,
            assetUri: asset.uri,
            source: "workflow-install",
          },
        };
      }
      if (node.parameters && typeof node.parameters === "object") {
        const params = node.parameters as Record<string, unknown>;
        delete params.placeholder;
        delete params.kernelRunId;
      }
      restored += 1;
    } catch {
      continue;
    }
  }
  return restored;
}
