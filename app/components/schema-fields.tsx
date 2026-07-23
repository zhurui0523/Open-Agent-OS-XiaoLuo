"use client";

interface SchemaFieldsProps {
  schema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}

type FieldSchema = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  items?: FieldSchema;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function fieldUi(uiSchema: Record<string, unknown>, key: string) {
  return record(uiSchema[key]);
}

export function SchemaFields({
  schema,
  uiSchema = {},
  value,
  onChange,
}: SchemaFieldsProps) {
  const properties = record(schema?.properties) as Record<string, FieldSchema>;
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const configuredOrder = Array.isArray(uiSchema["ui:order"])
    ? uiSchema["ui:order"].filter(
        (item): item is string => typeof item === "string" && item !== "*",
      )
    : [];
  const keys = [
    ...configuredOrder.filter((key) => key in properties),
    ...Object.keys(properties).filter((key) => !configuredOrder.includes(key)),
  ];
  if (!keys.length) return null;

  function set(key: string, next: unknown) {
    onChange({ ...value, [key]: next });
  }

  return (
    <div className="schema-fields">
      <div className="schema-fields-heading">
        <span>Package 参数</span>
        <small>Schema 自动渲染</small>
      </div>
      {keys.map((key) => {
        const field = properties[key] ?? {};
        const ui = fieldUi(uiSchema, key);
        const label =
          (typeof ui["ui:title"] === "string" && ui["ui:title"]) ||
          field.title ||
          key;
        const placeholder =
          typeof ui["ui:placeholder"] === "string" ? ui["ui:placeholder"] : "";
        const widget =
          typeof ui["ui:widget"] === "string" ? ui["ui:widget"] : "";
        const current = value[key] ?? field.default ?? "";

        if (field.type === "boolean") {
          return (
            <label className="schema-boolean" key={key}>
              <input
                type="checkbox"
                checked={Boolean(current)}
                onChange={(event) => set(key, event.target.checked)}
              />
              <span>{label}{required.has(key) ? " *" : ""}</span>
            </label>
          );
        }

        if (Array.isArray(field.enum)) {
          return (
            <label key={key}>
              <span>{label}{required.has(key) ? " *" : ""}</span>
              <select
                value={String(current)}
                onChange={(event) => set(key, event.target.value)}
              >
                {!required.has(key) && <option value="">请选择</option>}
                {field.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        if (field.type === "number" || field.type === "integer") {
          return (
            <label key={key}>
              <span>{label}{required.has(key) ? " *" : ""}</span>
              <input
                type="number"
                value={typeof current === "number" ? current : ""}
                min={field.minimum}
                max={field.maximum}
                step={field.type === "integer" ? 1 : "any"}
                placeholder={placeholder}
                onChange={(event) =>
                  set(
                    key,
                    event.target.value === ""
                      ? ""
                      : field.type === "integer"
                        ? Number.parseInt(event.target.value, 10)
                        : Number(event.target.value),
                  )
                }
              />
            </label>
          );
        }

        if (field.type === "array") {
          const list = Array.isArray(current) ? current : [];
          return (
            <label key={key}>
              <span>{label}{required.has(key) ? " *" : ""}</span>
              <input
                value={list.join(", ")}
                placeholder={placeholder || "使用逗号分隔多个值"}
                onChange={(event) =>
                  set(
                    key,
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>
          );
        }

        if (field.type === "object") {
          return (
            <label key={key}>
              <span>{label}{required.has(key) ? " *" : ""}</span>
              <textarea
                className="schema-json-input"
                value={
                  typeof current === "object"
                    ? JSON.stringify(current, null, 2)
                    : String(current)
                }
                placeholder={placeholder || "{}"}
                onChange={(event) => {
                  try {
                    set(key, JSON.parse(event.target.value));
                  } catch {
                    set(key, event.target.value);
                  }
                }}
              />
            </label>
          );
        }

        const multiline =
          widget === "textarea" ||
          field.format === "multiline" ||
          field.format === "prompt";
        return (
          <label key={key}>
            <span>{label}{required.has(key) ? " *" : ""}</span>
            {multiline ? (
              <textarea
                value={String(current)}
                placeholder={placeholder}
                onChange={(event) => set(key, event.target.value)}
              />
            ) : (
              <input
                type={field.format === "uri" ? "url" : "text"}
                value={String(current)}
                placeholder={placeholder}
                onChange={(event) => set(key, event.target.value)}
              />
            )}
            {field.description && <small>{field.description}</small>}
          </label>
        );
      })}
    </div>
  );
}
