"use client";

import { Plus, Trash2 } from "lucide-react";

interface SchemaOptionBuilderProps {
  title: string;
  schema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  onChange: (
    schema: Record<string, unknown>,
    uiSchema: Record<string, unknown>,
  ) => void;
}

type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "image"
  | "video"
  | "audio"
  | "file";

interface FieldRow {
  key: string;
  title: string;
  type: FieldType;
  options: string;
  required: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rowsFromSchema(schema?: Record<string, unknown>): FieldRow[] {
  const properties = record(schema?.properties);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  return Object.entries(properties).map(([key, raw]) => {
    const field = record(raw);
    const format = typeof field.format === "string" ? field.format : "";
    const enumeration = Array.isArray(field.enum) ? field.enum : [];
    const type: FieldType = ["image", "video", "audio", "file"].includes(format)
      ? (format as FieldType)
      : enumeration.length
        ? "select"
        : field.type === "number" ||
            field.type === "integer" ||
            field.type === "boolean"
          ? field.type
          : "string";
    return {
      key,
      title: typeof field.title === "string" ? field.title : key,
      type,
      options: enumeration.map(String).join(", "),
      required: required.has(key),
    };
  });
}

function schemasFromRows(rows: FieldRow[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const field: Record<string, unknown> = { title: row.title.trim() || key };
    if (["image", "video", "audio", "file"].includes(row.type)) {
      field.type = "string";
      field.format = row.type;
    } else if (row.type === "select") {
      field.type = "string";
      field.enum = row.options
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      field.type = row.type;
    }
    properties[key] = field;
    if (row.required) required.push(key);
  }
  return {
    schema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    },
    uiSchema: {},
  };
}

export function SchemaOptionBuilder({
  title,
  schema,
  onChange,
}: SchemaOptionBuilderProps) {
  const rows = rowsFromSchema(schema);

  function update(nextRows: FieldRow[]) {
    const next = schemasFromRows(nextRows);
    onChange(next.schema, next.uiSchema);
  }

  return (
    <fieldset className="schema-option-builder">
      <legend>{title}</legend>
      <p>这些选项会自动同步到使用该 Skill 或模型的画布节点。</p>
      <div className="schema-option-list">
        {rows.map((row, index) => (
          <div className="schema-option-row" key={`${row.key}-${index}`}>
            <input
              aria-label="参数标识"
              value={row.key}
              placeholder="参数标识"
              onChange={(event) =>
                update(
                  rows.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          key: event.target.value
                            .replace(/[^A-Za-z0-9_-]/g, "")
                            .slice(0, 48),
                        }
                      : item,
                  ),
                )
              }
            />
            <input
              aria-label="显示名称"
              value={row.title}
              placeholder="显示名称"
              onChange={(event) =>
                update(
                  rows.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, title: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <select
              aria-label="参数类型"
              value={row.type}
              onChange={(event) =>
                update(
                  rows.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, type: event.target.value as FieldType }
                      : item,
                  ),
                )
              }
            >
              <option value="string">文本</option>
              <option value="select">选项</option>
              <option value="number">数字</option>
              <option value="integer">整数</option>
              <option value="boolean">开关</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
              <option value="file">文件</option>
            </select>
            {row.type === "select" ? (
              <input
                aria-label="可选值"
                value={row.options}
                placeholder="选项 A, 选项 B"
                onChange={(event) =>
                  update(
                    rows.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, options: event.target.value }
                        : item,
                    ),
                  )
                }
              />
            ) : (
              <label className="schema-required-toggle">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(event) =>
                    update(
                      rows.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, required: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                必填
              </label>
            )}
            <button
              type="button"
              aria-label={`删除 ${row.title || row.key}`}
              onClick={() =>
                update(rows.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="schema-option-add"
        onClick={() =>
          update([
            ...rows,
            {
              key: `parameter_${rows.length + 1}`,
              title: `参数 ${rows.length + 1}`,
              type: "string",
              options: "",
              required: false,
            },
          ])
        }
      >
        <Plus size={14} /> 添加节点选项
      </button>
    </fieldset>
  );
}
