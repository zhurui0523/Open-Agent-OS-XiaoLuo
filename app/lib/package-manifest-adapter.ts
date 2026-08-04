function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function packageManifestRecord(payload: unknown) {
  if (!isRecord(payload)) return null;
  return isRecord(payload.manifest) ? payload.manifest : payload;
}

export function needsDefaultSandboxPanel(payload: unknown) {
  const manifest = packageManifestRecord(payload);
  if (!manifest) return false;
  const runtime = isRecord(manifest.runtime) ? manifest.runtime : {};
  const contributes = isRecord(manifest.contributes)
    ? manifest.contributes
    : {};
  return (
    runtime.type === "sandbox-ui" &&
    (!Array.isArray(contributes.panels) || contributes.panels.length === 0)
  );
}

export function withDefaultSandboxPanel(input: {
  payload: unknown;
  runtimeEntry: string;
}) {
  const root = isRecord(input.payload) ? input.payload : {};
  const manifest = packageManifestRecord(root);
  if (!manifest) throw new Error("Package Manifest 必须是 JSON 对象");
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!id || !name) {
    throw new Error("自动生成默认面板前需要有效的 Package ID 与名称");
  }
  const contributes = isRecord(manifest.contributes)
    ? manifest.contributes
    : {};
  const adaptedManifest = {
    ...manifest,
    runtime: {
      ...(isRecord(manifest.runtime) ? manifest.runtime : {}),
      type: "sandbox-ui",
      entry: input.runtimeEntry,
    },
    contributes: {
      ...contributes,
      panels: [
        {
          id: `${id}.panel`,
          title: name,
        },
      ],
    },
  };
  return isRecord(root.manifest)
    ? { ...root, manifest: adaptedManifest }
    : adaptedManifest;
}
