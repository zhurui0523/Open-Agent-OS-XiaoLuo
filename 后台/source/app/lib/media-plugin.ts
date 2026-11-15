import type {
  InstalledPackage,
  MediaPluginType,
  NodeKind,
} from "../types";

export const MEDIA_PLUGIN_TYPES: MediaPluginType[] = [
  "image",
  "video",
  "audio",
];

export function normalizeMediaPluginTypes(value: unknown): MediaPluginType[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (item): item is MediaPluginType =>
          typeof item === "string" &&
          MEDIA_PLUGIN_TYPES.includes(item as MediaPluginType),
      ),
    ),
  ];
}

export function mediaPluginTypes(
  item: Pick<InstalledPackage, "manifest">,
): MediaPluginType[] {
  return normalizeMediaPluginTypes(item.manifest?.assetTypes);
}

export function mediaPluginSupports(
  item: Pick<InstalledPackage, "manifest">,
  kind: NodeKind,
): kind is MediaPluginType {
  return (
    MEDIA_PLUGIN_TYPES.includes(kind as MediaPluginType) &&
    mediaPluginTypes(item).includes(kind as MediaPluginType)
  );
}
