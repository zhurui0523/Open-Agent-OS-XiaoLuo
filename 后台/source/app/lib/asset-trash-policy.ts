export const ASSET_TRASH_RETENTION_HOURS = 72;
export const ASSET_TRASH_RETENTION_MS =
  ASSET_TRASH_RETENTION_HOURS * 60 * 60 * 1_000;

function parseTrashTimestamp(value: string) {
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.getTime();

  const normalized = new Date(value.replace(" ", "T"));
  return normalized.getTime();
}

export function assetTrashExpiresAt(trashedAt: string) {
  const timestamp = parseTrashTimestamp(trashedAt);
  return Number.isNaN(timestamp)
    ? null
    : new Date(timestamp + ASSET_TRASH_RETENTION_MS);
}

export function assetTrashRemainingLabel(
  trashedAt: string | null,
  now = Date.now(),
) {
  if (!trashedAt) return "";
  const expiresAt = assetTrashExpiresAt(trashedAt);
  if (!expiresAt) return "";
  const remaining = expiresAt.getTime() - now;
  if (remaining <= 0) return "即将自动永久删除";
  const hours = Math.ceil(remaining / (60 * 60 * 1_000));
  if (hours >= 24) {
    return `还剩 ${Math.ceil(hours / 24)} 天自动删除`;
  }
  if (hours >= 1) return `还剩 ${hours} 小时自动删除`;
  return "将在 1 小时内自动删除";
}
