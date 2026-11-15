import type { AssetKind } from "../types";

export interface SupportedFileFormat {
  kind: AssetKind;
  label: string;
  extensions: readonly string[];
  canonicalMimeType: string;
  mimeAliases?: readonly string[];
  preview: "text" | "image" | "video" | "audio" | "pdf" | "office" | "download";
}

export const SUPPORTED_FILE_FORMATS: readonly SupportedFileFormat[] = [
  {
    kind: "text",
    label: "纯文本",
    extensions: [
      "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml",
      "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx",
      "py", "java", "c", "cpp", "h", "hpp", "go", "rs", "sql", "log", "ini",
      "toml",
    ],
    canonicalMimeType: "text/plain;charset=utf-8",
    mimeAliases: [
      "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
      "application/json", "application/ld+json", "application/x-ndjson",
      "application/yaml", "application/x-yaml", "text/yaml", "application/xml",
      "text/xml", "text/html", "text/css", "text/javascript",
      "application/javascript", "application/typescript", "text/x-python",
      "text/x-java-source", "text/x-c", "text/x-c++", "text/x-go", "text/x-rust",
      "application/sql", "application/toml", "application/vnd.ms-excel",
    ],
    preview: "text",
  },
  {
    kind: "document",
    label: "PDF",
    extensions: ["pdf"],
    canonicalMimeType: "application/pdf",
    preview: "pdf",
  },
  {
    kind: "document",
    label: "Word",
    extensions: ["docx"],
    canonicalMimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    preview: "office",
  },
  {
    kind: "document",
    label: "Word 旧格式",
    extensions: ["doc"],
    canonicalMimeType: "application/msword",
    preview: "download",
  },
  {
    kind: "document",
    label: "Excel",
    extensions: ["xlsx"],
    canonicalMimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    preview: "office",
  },
  {
    kind: "document",
    label: "Excel 旧格式",
    extensions: ["xls"],
    canonicalMimeType: "application/vnd.ms-excel",
    preview: "download",
  },
  {
    kind: "document",
    label: "PowerPoint",
    extensions: ["pptx"],
    canonicalMimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    preview: "office",
  },
  {
    kind: "document",
    label: "PowerPoint 旧格式",
    extensions: ["ppt"],
    canonicalMimeType: "application/vnd.ms-powerpoint",
    preview: "download",
  },
  {
    kind: "image",
    label: "PNG",
    extensions: ["png"],
    canonicalMimeType: "image/png",
    preview: "image",
  },
  {
    kind: "image",
    label: "JPEG",
    extensions: ["jpg", "jpeg"],
    canonicalMimeType: "image/jpeg",
    preview: "image",
  },
  {
    kind: "image",
    label: "WebP",
    extensions: ["webp"],
    canonicalMimeType: "image/webp",
    preview: "image",
  },
  {
    kind: "image",
    label: "GIF",
    extensions: ["gif"],
    canonicalMimeType: "image/gif",
    preview: "image",
  },
  {
    kind: "image",
    label: "AVIF",
    extensions: ["avif"],
    canonicalMimeType: "image/avif",
    preview: "image",
  },
  {
    kind: "image",
    label: "BMP",
    extensions: ["bmp"],
    canonicalMimeType: "image/bmp",
    mimeAliases: ["image/x-ms-bmp"],
    preview: "image",
  },
  {
    kind: "video",
    label: "MP4 / M4V",
    extensions: ["mp4", "m4v"],
    canonicalMimeType: "video/mp4",
    mimeAliases: ["video/x-m4v"],
    preview: "video",
  },
  {
    kind: "video",
    label: "WebM / MKV",
    extensions: ["webm", "mkv"],
    canonicalMimeType: "video/webm",
    mimeAliases: ["video/x-matroska"],
    preview: "video",
  },
  {
    kind: "video",
    label: "QuickTime",
    extensions: ["mov"],
    canonicalMimeType: "video/quicktime",
    preview: "video",
  },
  {
    kind: "video",
    label: "Ogg Video",
    extensions: ["ogv"],
    canonicalMimeType: "video/ogg",
    preview: "video",
  },
  {
    kind: "audio",
    label: "MP3",
    extensions: ["mp3"],
    canonicalMimeType: "audio/mpeg",
    preview: "audio",
  },
  {
    kind: "audio",
    label: "WAV",
    extensions: ["wav"],
    canonicalMimeType: "audio/wav",
    mimeAliases: ["audio/x-wav"],
    preview: "audio",
  },
  {
    kind: "audio",
    label: "FLAC",
    extensions: ["flac"],
    canonicalMimeType: "audio/flac",
    preview: "audio",
  },
  {
    kind: "audio",
    label: "Ogg Audio",
    extensions: ["ogg", "oga"],
    canonicalMimeType: "audio/ogg",
    preview: "audio",
  },
  {
    kind: "audio",
    label: "M4A",
    extensions: ["m4a"],
    canonicalMimeType: "audio/mp4",
    mimeAliases: ["audio/x-m4a"],
    preview: "audio",
  },
  {
    kind: "audio",
    label: "AAC",
    extensions: ["aac"],
    canonicalMimeType: "audio/aac",
    mimeAliases: ["audio/x-aac"],
    preview: "audio",
  },
  {
    kind: "archive",
    label: "ZIP",
    extensions: ["zip"],
    canonicalMimeType: "application/zip",
    mimeAliases: ["application/x-zip-compressed"],
    preview: "download",
  },
];

const formatByExtension = new Map(
  SUPPORTED_FILE_FORMATS.flatMap((format) =>
    format.extensions.map((extension) => [extension, format] as const),
  ),
);

const formatByCanonicalMimeType = new Map(
  SUPPORTED_FILE_FORMATS.map(
    (format) => [format.canonicalMimeType, format] as const,
  ),
);

export function formatForMimeType(mimeType: string) {
  return formatByCanonicalMimeType.get(mimeType) ?? null;
}

export const SUPPORTED_FILE_ACCEPT = SUPPORTED_FILE_FORMATS.flatMap((format) =>
  format.extensions.map((extension) => `.${extension}`),
).join(",");

export const SUPPORTED_FILE_GROUPS = [
  {
    label: "文本",
    extensions: ["TXT", "MD", "CSV", "TSV", "JSON", "YAML", "XML", "HTML", "代码文件"],
  },
  {
    label: "图片",
    extensions: ["PNG", "JPG", "WEBP", "GIF", "AVIF", "BMP"],
  },
  {
    label: "视频",
    extensions: ["MP4", "M4V", "WEBM", "MKV", "MOV", "OGV"],
  },
  {
    label: "音频",
    extensions: ["MP3", "WAV", "FLAC", "OGG", "M4A", "AAC"],
  },
  {
    label: "文档",
    extensions: ["PDF", "DOC/DOCX", "XLS/XLSX", "PPT/PPTX"],
  },
  {
    label: "压缩包",
    extensions: ["ZIP"],
  },
] as const;

export function fileExtension(name: string) {
  const base = name.trim().toLowerCase();
  const index = base.lastIndexOf(".");
  return index > -1 ? base.slice(index + 1) : "";
}

export function supportedFormatForName(name: string) {
  return formatByExtension.get(fileExtension(name)) ?? null;
}

export function canonicalUploadMimeType(
  name: string,
  declaredMimeType?: string | null,
) {
  const format = supportedFormatForName(name);
  if (!format) return null;
  const declared = declaredMimeType?.split(";")[0]?.trim().toLowerCase();
  const knownAliases = new Set([
    format.canonicalMimeType.split(";")[0].toLowerCase(),
    ...(format.mimeAliases ?? []).map((value) => value.toLowerCase()),
  ]);
  return {
    format,
    mimeType: format.canonicalMimeType,
    declaredMimeRecognized:
      !declared ||
      declared === "application/octet-stream" ||
      knownAliases.has(declared),
  };
}
