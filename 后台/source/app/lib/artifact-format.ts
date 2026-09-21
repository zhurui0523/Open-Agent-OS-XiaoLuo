import type { NodeKind } from "../types";

const defaults: Record<NodeKind, { extension: string; mimeType: string }> = {
  text: { extension: "txt", mimeType: "text/plain;charset=utf-8" },
  image: { extension: "png", mimeType: "image/png" },
  video: { extension: "mp4", mimeType: "video/mp4" },
  audio: { extension: "mp3", mimeType: "audio/mpeg" },
  document: { extension: "pdf", mimeType: "application/pdf" },
};

const extensionsByMime: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

export function artifactFormat(kind: NodeKind, contentType?: string | null) {
  const normalizedMime =
    contentType?.split(";")[0]?.trim().toLowerCase() || defaults[kind].mimeType;
  return {
    mimeType: contentType?.trim() || defaults[kind].mimeType,
    extension: extensionsByMime[normalizedMime] ?? defaults[kind].extension,
  };
}

export function artifactName(
  title: string,
  kind: NodeKind,
  contentType?: string | null,
) {
  return `${title}.${artifactFormat(kind, contentType).extension}`;
}
