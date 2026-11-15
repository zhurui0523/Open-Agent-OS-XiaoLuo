export const ASSET_UPLOAD_FILE_NAME_HEADER = "x-xiaoluo-file-name";
export const ASSET_UPLOAD_SOURCE_TYPE_HEADER = "x-xiaoluo-source-type";
export const ASSET_UPLOAD_SOURCE_REF_HEADER = "x-xiaoluo-source-ref";
export const ASSET_UPLOAD_TAGS_HEADER = "x-xiaoluo-tags";

export interface AssetUploadMetadata {
  sourceType?: string;
  sourceRef?: string | null;
  tags?: string[];
}

function encodeHeaderValue(value: string) {
  return encodeURIComponent(value);
}

export function decodeAssetUploadHeader(value: string | null) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function assetUploadRequestInit(
  file: File,
  metadata: AssetUploadMetadata = {},
): RequestInit {
  const headers: Record<string, string> = {
    "content-type": file.type || "application/octet-stream",
    [ASSET_UPLOAD_FILE_NAME_HEADER]: encodeHeaderValue(file.name),
  };
  if (metadata.sourceType) {
    headers[ASSET_UPLOAD_SOURCE_TYPE_HEADER] = encodeHeaderValue(
      metadata.sourceType,
    );
  }
  if (metadata.sourceRef) {
    headers[ASSET_UPLOAD_SOURCE_REF_HEADER] = encodeHeaderValue(
      metadata.sourceRef,
    );
  }
  if (metadata.tags?.length) {
    headers[ASSET_UPLOAD_TAGS_HEADER] = encodeHeaderValue(
      JSON.stringify(metadata.tags),
    );
  }
  return { method: "POST", headers, body: file };
}
