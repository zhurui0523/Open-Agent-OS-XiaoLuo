"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

interface SchemaOptionBuilderProps {
  title: string;
  schema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  onChange: (
    schema: Record<string, unknown>,
    uiSchema: Record<string, unknown>,
  ) => void;
}

interface DropdownRow {
  key: string;
  title: string;
  options: string;
  defaultValue: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rowsFromSchema(schema?: Record<string, unknown>): DropdownRow[] {
  const properties = record(schema?.properties);
  return Object.entries(properties).map(([key, raw]) => {
    const field = record(raw);
    const enumeration = Array.isArray(field.enum) ? field.enum : [];
    return {
      key,
      title: typeof field.title === "string" ? field.title : key,
      options: enumeration.map(String).join(", "),
      defaultValue:
        field.default === undefined ? "" : String(field.default),
    };
  });
}

function schemasFromRows(rows: DropdownRow[]) {
  const properties: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const options = row.options
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    properties[key] = {
      type: "string",
      title: row.title.trim() || key,
      enum: options,
      ...(row.defaultValue.trim() && options.includes(row.defaultValue.trim())
        ? { default: row.defaultValue.trim() }
        : {}),
    };
  }
  return {
    schema: { type: "object", properties },
    uiSchema: {},
  };
}

export function SchemaOptionBuilder({
  title,
  schema,
  onChange,
}: SchemaOptionBuilderProps) {
  const [rows, setRows] = useState<DropdownRow[]>(() =>
    rowsFromSchema(schema),
  );

  function update(nextRows: DropdownRow[]) {
    setRows(nextRows);
    const next = schemasFromRows(nextRows);
    onChange(next.schema, next.uiSchema);
  }

  return (
    <fieldset className="schema-option-builder">
      <legend>{title}（选填）</legend>
      <p>
        为此模型配置画布节点中的默认下拉选项，名称、候选值和默认值均可修改。
      </p>
      <button
        type="button"
        className="schema-option-add"
        onClick={() =>
          update([
            ...rows,
            {
              key: `parameter_${crypto.randomUUID().slice(0, 8)}`,
              title: "",
              options: "",
              defaultValue: "",
            },
          ])
        }
      >
        <Plus size={14} /> 添加下拉配置组
      </button>
      <div className="schema-option-list">
        {rows.map((row, index) => (
          <div className="schema-option-row" key={row.key}>
            <input
              aria-label="参数名称"
              value={row.title}
              placeholder="参数名称，例如：生成范围"
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
            <input
              aria-label="候选值"
              value={row.options}
              placeholder="候选值（逗号隔开，如：震撼, 欢快, 悬疑）"
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
            <select
              aria-label="默认值"
              value={row.defaultValue}
              onChange={(event) =>
                update(
                  rows.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, defaultValue: event.target.value }
                      : item,
                  ),
                )
              }
            >
              <option value="">请选择默认值</option>
              {row.options
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean)
                .map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
            </select>
            <button
              type="button"
              aria-label={`删除 ${row.title || row.key}`}
              onClick={() =>
                update(rows.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
