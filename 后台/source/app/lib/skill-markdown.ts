import type {
  NodeKind,
  PortDataType,
} from "../types";
import type { XiaoLuoPackageManifest } from "./package-contract";

const MAX_MARKDOWN_BYTES = 512 * 1024;

function unquote(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function slugify(value: string) {
  const ascii = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (ascii) return ascii;
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `imported-${(hash >>> 0).toString(36)}`;
}

function parseFrontmatter(markdown: string) {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {} as Record<string, string>, body: normalized.trim() };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    throw new Error("Skill Markdown 的 YAML Frontmatter 没有结束标记");
  }
  const attributes: Record<string, string> = {};
  const lines = normalized.slice(4, end).split("\n");
  let activeKey = "";
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) {
      activeKey = match[1].toLowerCase();
      attributes[activeKey] = unquote(match[2]);
      continue;
    }
    if (activeKey && /^\s+/.test(line)) {
      attributes[activeKey] = `${attributes[activeKey]} ${line.trim()}`.trim();
    }
  }
  return {
    attributes,
    body: normalized.slice(end + 4).trim(),
  };
}

function modalityOf(value: string): NodeKind {
  return ["text", "image", "video", "audio", "document"].includes(value)
    ? (value as NodeKind)
    : "text";
}

function skillPorts(modality: NodeKind) {
  const outputTypes: PortDataType[] = [modality];
  const inputTypes: PortDataType[] =
    modality === "text"
      ? ["text", "document", "json"]
      : ["text", "document", "json", "asset"];
  return [
    {
      id: "input",
      label: "输入素材",
      direction: "input" as const,
      dataTypes: inputTypes,
      cardinality: "many" as const,
      maxConnections: 10_000,
    },
    {
      id: "output",
      label: "执行结果",
      direction: "output" as const,
      dataTypes: outputTypes,
      cardinality: "many" as const,
      maxConnections: 10_000,
    },
  ];
}

export function skillManifestFromMarkdown(
  markdown: string,
  fileName = "skill.md",
  version = "1.0.0",
): XiaoLuoPackageManifest {
  const byteLength = new TextEncoder().encode(markdown).byteLength;
  if (!markdown.trim()) throw new Error("Skill Markdown 不能为空");
  if (byteLength > MAX_MARKDOWN_BYTES) {
    throw new Error("Skill Markdown 不能超过 512 KB");
  }
  const { attributes, body } = parseFrontmatter(markdown);
  if (!body) throw new Error("Skill Markdown 缺少执行规则正文");
  const fallbackName = fileName.replace(/\.md$/i, "");
  const rawName = attributes.name || fallbackName || "imported-skill";
  const slug = slugify(rawName);
  const packageId = `user.skill.${slug}`;
  const title =
    attributes.title ||
    body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
    rawName;
  const description =
    attributes.description ||
    body
      .split(/\n+/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ||
    "从 Markdown 导入的 Skill";
  const modality = modalityOf(attributes.modality?.toLowerCase() ?? "text");

  return {
    schemaVersion: "2.0",
    id: packageId,
    name: title.slice(0, 180),
    version,
    description: description.slice(0, 2_000),
    type: "skill",
    access: { scope: "personal" },
    runtime: { type: "declarative" },
    permissions: ["models:list", "models:invoke"],
    contributes: {
      skills: [
        {
          id: `${packageId}.main`,
          title: title.slice(0, 180),
          description: description.slice(0, 2_000),
          modality,
          executionMode: "model",
          ports: skillPorts(modality),
          inputSchema: {
            type: "object",
            "x-xiaoluo-instructions": body,
            properties: {
              input: {
                type: "string",
                title: "任务输入",
              },
            },
            required: ["input"],
          },
          outputSchema: {
            type: "object",
            properties:
              modality === "text"
                ? { text: { type: "string", title: "文本结果" } }
                : {
                    assetUrl: {
                      type: "string",
                      format: modality,
                      title: "生成结果",
                    },
                  },
          },
          uiSchema: {
            input: { "ui:widget": "textarea" },
          },
          modelRequirements: { required: true },
        },
      ],
    },
  };
}

export function skillInstructionsFromSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const instructions = (value as Record<string, unknown>)[
    "x-xiaoluo-instructions"
  ];
  return typeof instructions === "string" ? instructions.trim() : "";
}
