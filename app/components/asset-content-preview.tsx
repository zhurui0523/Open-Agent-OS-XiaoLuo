"use client";

import {
  Archive,
  AudioLines,
  Download,
  FileText,
  Image as ImageIcon,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { supportedFormatForName } from "../lib/file-formats";
import { AudioPlayer } from "./audio-player";
import { VideoPlayer } from "./video-player";
import type { AssetKind } from "../types";

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 4 * 1024 * 1024;

async function readTextPreview(url: string) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { range: `bytes=0-${MAX_TEXT_PREVIEW_BYTES - 1}` },
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`读取失败（${response.status}）`);
  }
  const bytes = await response.arrayBuffer();
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes)
    .replace(/\u0000/g, "")
    .slice(0, 120_000);
}

function decodeXmlText(xml: string) {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/row>/g, "\n")
    .replace(/<\/c>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uint16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new Error("文档内容过大，请下载后查看");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function unzipXmlEntries(
  bytes: ArrayBuffer,
  include: (name: string) => boolean,
) {
  const view = new DataView(bytes);
  let eocd = -1;
  for (let index = Math.max(0, view.byteLength - 65_557); index <= view.byteLength - 22; index += 1) {
    if (uint32(view, index) === 0x06054b50) eocd = index;
  }
  if (eocd < 0) throw new Error("不是有效的 Office Open XML 文件");
  const entries = uint16(view, eocd + 10);
  let offset = uint32(view, eocd + 16);
  const decoder = new TextDecoder();
  const output: Array<{ name: string; text: string }> = [];
  for (let index = 0; index < entries && offset + 46 <= view.byteLength; index += 1) {
    if (uint32(view, offset) !== 0x02014b50) break;
    const method = uint16(view, offset + 10);
    const compressedSize = uint32(view, offset + 20);
    const fileNameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const fileName = decoder.decode(
      new Uint8Array(bytes, offset + 46, fileNameLength),
    );
    if (include(fileName) && localOffset + 30 <= view.byteLength) {
      const localNameLength = uint16(view, localOffset + 26);
      const localExtraLength = uint16(view, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
      let content: ArrayBuffer;
      if (method === 0) {
        if (compressed.byteLength > MAX_OFFICE_ENTRY_BYTES) {
          throw new Error("文档内容过大，请下载后查看");
        }
        content = compressed;
      } else if (method === 8) {
        const stream = new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        content = await readStreamLimited(stream, MAX_OFFICE_ENTRY_BYTES);
      } else {
        offset += 46 + fileNameLength + extraLength + commentLength;
        continue;
      }
      output.push({ name: fileName, text: decoder.decode(content) });
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return output.sort((first, second) =>
    first.name.localeCompare(second.name, undefined, { numeric: true }),
  );
}

async function readOfficePreview(url: string, name: string) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`读取失败（${response.status}）`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 25 * 1024 * 1024) {
    throw new Error("文件超过 25 MB，请下载后查看");
  }
  const extension = name.split(".").pop()?.toLowerCase();
  const entries = await unzipXmlEntries(bytes, (entry) => {
    if (extension === "docx") return entry === "word/document.xml";
    if (extension === "pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(entry);
    if (extension === "xlsx") {
      return (
        entry === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)
      );
    }
    return false;
  });
  const content = entries
    .map((entry) => decodeXmlText(entry.text))
    .filter(Boolean)
    .join("\n\n");
  return content.slice(0, 120_000) || "文件中没有可提取的文本内容";
}

function TextPreview({
  url,
  name,
  office,
}: {
  url: string;
  name: string;
  office?: boolean;
}) {
  const [text, setText] = useState("正在读取内容…");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setFailed(false);
      setText("正在读取内容…");
      void (office ? readOfficePreview(url, name) : readTextPreview(url))
        .then((content) => {
          if (active) setText(content || "文件内容为空");
        })
        .catch((cause) => {
          if (!active) return;
          setFailed(true);
          setText(cause instanceof Error ? cause.message : "暂时无法读取内容");
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [name, office, url]);
  return (
    <div className={`asset-readable-preview${failed ? " is-error" : ""}`}>
      <pre>{text}</pre>
    </div>
  );
}

function FileFallback({
  kind,
  name,
  downloadUrl,
}: {
  kind: AssetKind;
  name: string;
  downloadUrl?: string;
}) {
  const Icon =
    kind === "archive"
      ? Archive
      : kind === "video"
        ? Video
        : kind === "audio"
          ? AudioLines
          : kind === "image"
            ? ImageIcon
            : FileText;
  return (
    <div className="asset-preview-fallback">
      <Icon size={34} />
      <strong>{name}</strong>
      <span>此格式已安全存储；当前浏览器不能直接预览时可下载查看。</span>
      {downloadUrl && (
        <a href={downloadUrl} download>
          <Download size={15} /> 下载文件
        </a>
      )}
    </div>
  );
}

export function AssetContentPreview({
  name,
  kind,
  mimeType,
  contentUrl,
  downloadUrl,
  compact = false,
}: {
  name: string;
  kind: AssetKind;
  mimeType: string;
  contentUrl: string;
  downloadUrl?: string;
  compact?: boolean;
}) {
  const format = supportedFormatForName(name);
  if (kind === "image") {
    // The URL is an authenticated same-origin Asset Kernel route.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={contentUrl}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
      />
    );
  }
  if (compact) {
    return <FileFallback kind={kind} name={name} />;
  }
  if (kind === "video") {
    // #t=0.1 让浏览器加载第一帧作为缩略图，避免预览一片漆黑
    return <VideoPlayer src={`${contentUrl}#t=0.1`} title={name} />;
  }
  if (kind === "audio") {
    return <AudioPlayer src={contentUrl} title={name} />;
  }
  if (kind === "text" || format?.preview === "text") {
    return <TextPreview url={contentUrl} name={name} />;
  }
  if (mimeType.split(";")[0] === "application/pdf") {
    return <iframe src={contentUrl} title={`${name} 预览`} />;
  }
  if (format?.preview === "office") {
    return <TextPreview url={contentUrl} name={name} office />;
  }
  return (
    <FileFallback
      kind={kind}
      name={name}
      downloadUrl={downloadUrl}
    />
  );
}
