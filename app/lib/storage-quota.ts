export const GIB_BYTES = 1024 ** 3;
export const DEFAULT_STORAGE_QUOTA_BYTES = 10 * GIB_BYTES;
export const MAX_STORAGE_INCREASE_GIB = 1024;
export const MAX_STORAGE_QUOTA_BYTES = 100 * 1024 ** 4;

export function defaultStorageQuotaBytes() {
  const parsed = Number(process.env.USER_STORAGE_QUOTA_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STORAGE_QUOTA_BYTES;
}

export function resolveStorageQuotaBytes(
  assigned: number | string | null | undefined,
) {
  const parsed = Number(assigned);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : defaultStorageQuotaBytes();
}

export function storageIncreaseBytes(increaseGiB: unknown) {
  const parsed = Number(increaseGiB);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_STORAGE_INCREASE_GIB
  ) {
    return null;
  }
  return parsed * GIB_BYTES;
}
