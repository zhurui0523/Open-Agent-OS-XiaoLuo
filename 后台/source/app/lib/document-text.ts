import { inflateRawSync } from "node:zlib";

// 服务端文档素材文本提取：txt 系直接解码；Office Open XML（docx/pptx/xlsx）
// 按 zip 中央目录逐条目 inflate 解析。提取逻辑与客户端 asset-content-preview
// 保持一致，保证“预览看到的内容”与“喂进提示词的内容”相同。
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 120_000;

const PLAIN_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "text",
  "yml",
  "yaml",
]);

const OFFICE_EXTENSIONS = new Set(["docx", "pptx", "xlsx"]);

export function extractableDocumentName(name: string, mimeType?: string | null) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (PLAIN_TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension)) {
    return true;
  }
  const mime = (mimeType ?? "").toLowerCase();
  return mime.startsWith("text/") || mime.includes("json");
}

export function extractDocumentText(
  bytes: ArrayBuffer,
  name: string,
  mimeType?: string | null,
): string | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = (mimeType ?? "").toLowerCase();
  const plainText =
    PLAIN_TEXT_EXTENSIONS.has(extension) ||
    (!OFFICE_EXTENSIONS.has(extension) &&
      (mime.startsWith("text/") || mime.includes("json")));
  if (plainText) {
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes)
      .replace(/\u0000/g, "")
      .trim();
    return text ? text.slice(0, MAX_EXTRACTED_CHARS) : null;
  }
  if (!OFFICE_EXTENSIONS.has(extension)) return null;
  let entries: Array<{ name: string; text: string }>;
  try {
    entries = unzipXmlEntries(bytes, (entry) => {
      if (extension === "docx") return entry === "word/document.xml";
      if (extension === "pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(entry);
      return (
        entry === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(entry)
      );
    });
  } catch {
    return null;
  }
  const content = entries
    .map((entry) => decodeXmlText(entry.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return content ? content.slice(0, MAX_EXTRACTED_CHARS) : null;
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

function unzipXmlEntries(
  bytes: ArrayBuffer,
  include: (name: string) => boolean,
) {
  const view = new DataView(bytes);
  let eocd = -1;
  for (
    let index = Math.max(0, view.byteLength - 65_557);
    index <= view.byteLength - 22;
    index += 1
  ) {
    if (uint32(view, index) === 0x06054b50) eocd = index;
  }
  if (eocd < 0) throw new Error("不是有效的 Office Open XML 文件");
  const entries = uint16(view, eocd + 10);
  let offset = uint32(view, eocd + 16);
  const decoder = new TextDecoder();
  const output: Array<{ name: string; text: string }> = [];
  for (
    let index = 0;
    index < entries && offset + 46 <= view.byteLength;
    index += 1
  ) {
    if (uint32(view, offset) !== 0x02014b50) break;
    const method = uint16(view, offset + 10);
    const compressedSize = uint32(view, offset + 20);
    const fileNameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const fileName = decoder.decode(
      new Uint8Array(bytes, offset + 46, fileNameLength),
    );    if (include(fileName) && localOffset + 30 <= view.byteLength) {
      const localNameLength = uint16(view, localOffset + 26);
      const localExtraLength = uint16(view, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const available = Math.max(0, view.byteLength - dataOffset);
      const compressed = new Uint8Array(
        bytes,
        dataOffset,
        Math.min(compressedSize, available),
      );
      let text: string | null = null;
      if (method === 0) {
        if (compressed.byteLength <= MAX_OFFICE_ENTRY_BYTES) {
          text = decoder.decode(compressed);
        }
      } else if (
        method === 8 &&
        compressed.byteLength <= MAX_OFFICE_ENTRY_BYTES
      ) {
        try {
          const inflated = inflateRawSync(compressed);
          if (inflated.byteLength <= MAX_OFFICE_ENTRY_BYTES) {
            text = decoder.decode(inflated);
          }
        } catch {
          text = null;
        }
      }
      if (text !== null) output.push({ name: fileName, text });
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return output.sort((first, second) =>
    first.name.localeCompare(second.name, undefined, { numeric: true }),
  );
}