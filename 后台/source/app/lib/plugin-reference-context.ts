import type {
  CanvasAssetReference,
  CanvasNode,
  KernelNodeOutput,
  PluginAssetContext,
  PluginTextContext,
} from "../types";

export function pluginAssetContextsFromReferences(
  canvasId: string,
  assets: CanvasAssetReference[],
) {
  const seen = new Set<string>();
  const contexts: PluginAssetContext[] = [];

  for (const asset of assets) {
    if (!asset.url) continue;
    const key = `${asset.sourceNodeId}:${asset.assetId ?? asset.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push({
      canvasId,
      nodeId: asset.sourceNodeId,
      kind: asset.kind,
      title: asset.title,
      url: asset.url,
      ...(asset.assetId ? { assetId: asset.assetId } : {}),
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    });
  }

  return contexts;
}

export function pluginTextContextsFromNodes(
  canvasId: string,
  nodes: CanvasNode[],
) {
  const seen = new Set<string>();
  const contexts: PluginTextContext[] = [];

  for (const node of nodes) {
    if (node.kind !== "text" || seen.has(node.id)) continue;
    const output = node.parameters?.kernelOutput as KernelNodeOutput | undefined;
    const content =
      output?.text?.trim() ||
      node.result?.trim() ||
      (typeof output?.data === "string" ? output.data.trim() : "") ||
      node.prompt.trim();
    if (!content) continue;
    seen.add(node.id);
    contexts.push({
      canvasId,
      nodeId: node.id,
      kind: "text",
      title: node.title,
      content,
    });
  }

  return contexts;
}

export function pluginHostReadyPayload(
  assetContexts: PluginAssetContext[],
  textContexts: PluginTextContext[] = [],
) {
  const assets = assetContexts;
  const texts = textContexts;
  const capabilities = [
    ...(assets.length ? ["asset-context", "asset-context-list"] : []),
    ...(texts.length ? ["text-context", "text-context-list"] : []),
  ];
  return {
    type: "xiaoluo:host-ready" as const,
    version: "2.0" as const,
    capabilities,
    // `asset` keeps compatibility with existing single-reference plugins.
    asset: assets[0] ?? null,
    // New plugins should consume the complete ordered reference list.
    assets,
    text: texts[0] ?? null,
    texts,
    references: [...texts, ...assets],
  };
}
