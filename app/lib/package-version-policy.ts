export interface PackageInstallSourceIdentity {
  kind?: unknown;
  repository?: unknown;
  commit?: unknown;
  archiveSha256?: unknown;
  generatedManifest?: unknown;
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedRepository(value: unknown) {
  return normalizedText(value)
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function normalizedDigest(value: unknown) {
  return normalizedText(value).toLowerCase();
}

export function packageInstallSourceFromDetailJson(
  detailJson: string | null | undefined,
) {
  if (!detailJson) return null;
  try {
    const detail = JSON.parse(detailJson) as { source?: unknown };
    return detail.source && typeof detail.source === "object"
      ? (detail.source as PackageInstallSourceIdentity)
      : null;
  } catch {
    return null;
  }
}

export function packageInstallSourceFromScanJson(
  scanJson: string | null | undefined,
) {
  if (!scanJson) return null;
  try {
    const scan = JSON.parse(scanJson) as { installSource?: unknown };
    return scan.installSource && typeof scan.installSource === "object"
      ? (scan.installSource as PackageInstallSourceIdentity)
      : null;
  } catch {
    return null;
  }
}

export function canRefreshGeneratedGithubManifest(input: {
  existingSource: PackageInstallSourceIdentity | null | undefined;
  incomingSource: PackageInstallSourceIdentity | null | undefined;
}) {
  const existing = input.existingSource;
  const incoming = input.incomingSource;
  if (
    existing?.kind !== "github" ||
    incoming?.kind !== "github" ||
    incoming.generatedManifest !== true
  ) {
    return false;
  }

  const existingRepository = normalizedRepository(existing.repository);
  const incomingRepository = normalizedRepository(incoming.repository);
  const existingCommit = normalizedDigest(existing.commit);
  const incomingCommit = normalizedDigest(incoming.commit);
  if (
    !existingRepository ||
    existingRepository !== incomingRepository ||
    !existingCommit ||
    existingCommit !== incomingCommit
  ) {
    return false;
  }

  const existingArchive = normalizedDigest(existing.archiveSha256);
  const incomingArchive = normalizedDigest(incoming.archiveSha256);
  return (
    !existingArchive ||
    !incomingArchive ||
    existingArchive === incomingArchive
  );
}
