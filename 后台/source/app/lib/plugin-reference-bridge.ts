import type { PluginAssetContext, PluginTextContext } from "../types";
import { pluginHostReadyPayload } from "./plugin-reference-context";

interface FrameSyncState {
  key: string;
  revision: number;
}

const frameSyncStates = new WeakMap<HTMLIFrameElement, FrameSyncState>();

const defaultMimeTypes: Partial<Record<PluginAssetContext["kind"], string>> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/octet-stream",
};

function acceptsAsset(input: HTMLInputElement, asset: PluginAssetContext) {
  const accept = input.accept
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (accept.length === 0) return true;

  const mimeType = (asset.mimeType ?? defaultMimeTypes[asset.kind] ?? "").toLowerCase();
  const extension = asset.title.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";

  return accept.some((rule) => {
    if (rule === "*/*") return true;
    if (rule.endsWith("/*")) return mimeType.startsWith(rule.slice(0, -1));
    if (rule.startsWith(".")) return extension === rule;
    return mimeType === rule;
  });
}

function referenceKey(
  assets: PluginAssetContext[],
  texts: PluginTextContext[],
) {
  return JSON.stringify({
    assets: assets.map((asset) => [
      asset.nodeId,
      asset.assetId ?? "",
      asset.url,
      asset.kind,
    ]),
    texts: texts.map((text) => [text.nodeId, text.content]),
  });
}

async function hydrateLegacyFileInput(
  frame: HTMLIFrameElement,
  assets: PluginAssetContext[],
  revision: number,
  attempt = 0,
) {
  if (assets.length === 0) return;

  let frameDocument: Document | null = null;
  let frameWindow: Window | null = null;
  try {
    frameDocument = frame.contentDocument;
    frameWindow = frame.contentWindow;
  } catch {
    // Cross-origin plugins use the postMessage contract above.
    return;
  }
  if (!frameDocument || !frameWindow) return;
  const frameRealm = frameWindow as unknown as typeof globalThis;

  const state = frameSyncStates.get(frame);
  if (!state || state.revision !== revision) return;

  const inputs = Array.from(
    frameDocument.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  );
  const input = inputs.find((candidate) =>
    assets.some((asset) => acceptsAsset(candidate, asset)),
  );

  if (!input) {
    if (attempt < 8) {
      frameRealm.setTimeout(() => {
        void hydrateLegacyFileInput(frame, assets, revision, attempt + 1);
      }, 250);
    }
    return;
  }

  const selectedAssets = input.multiple
    ? assets.filter((asset) => acceptsAsset(input, asset))
    : [assets.find((asset) => acceptsAsset(input, asset))].filter(
        (asset): asset is PluginAssetContext => Boolean(asset),
      );
  const inputKey = selectedAssets
    .map((asset) => `${asset.assetId ?? asset.nodeId}:${asset.url}`)
    .join("|");
  if (!inputKey || input.dataset.xiaoluoReferenceKey === inputKey) return;

  try {
    const files = await Promise.all(
      selectedAssets.map(async (asset) => {
        const response = await fetch(asset.downloadUrl ?? asset.url, {
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(`Unable to load plugin reference (${response.status})`);
        }
        const blob = await response.blob();
        const mimeType =
          asset.mimeType ||
          blob.type ||
          defaultMimeTypes[asset.kind] ||
          "application/octet-stream";
        const FrameFile = frameRealm.File;
        return new FrameFile([blob], asset.title || `reference-${asset.nodeId}`, {
          type: mimeType,
          lastModified: Date.now(),
        });
      }),
    );

    const latestState = frameSyncStates.get(frame);
    if (!latestState || latestState.revision !== revision) return;

    const transfer = new frameRealm.DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dataset.xiaoluoReferenceKey = inputKey;
    input.dispatchEvent(new frameRealm.Event("input", { bubbles: true }));
    input.dispatchEvent(new frameRealm.Event("change", { bubbles: true }));
  } catch {
    // A legacy adapter is best-effort. Modern or cross-origin plugins continue
    // to receive the same references through the standard host-ready message.
  }
}

export function syncPluginReferenceFrame(
  frame: HTMLIFrameElement | null,
  assets: PluginAssetContext[],
  texts: PluginTextContext[] = [],
) {
  if (!frame) return;

  frame.contentWindow?.postMessage(pluginHostReadyPayload(assets, texts), "*");

  const previous = frameSyncStates.get(frame);
  const key = referenceKey(assets, texts);
  const revision = (previous?.revision ?? 0) + 1;
  frameSyncStates.set(frame, { key, revision });

  // The adapter is intentionally attempted on every host sync. A preview may
  // be notified once while still on about:blank and again after its load event.
  void hydrateLegacyFileInput(frame, assets, revision);
}
