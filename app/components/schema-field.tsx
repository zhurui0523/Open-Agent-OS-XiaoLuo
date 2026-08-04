"use client";

import { Plus, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import type { JsonSchema } from "../lib/json-schema";
import { assetUploadRequestInit } from "../lib/asset-upload";

interface SchemaFieldProps {
  fieldKey: string;
  schema: JsonSchema;
  ui: Record<string, unknown>;
  value: unknown;
  required?: boolean;
  workspaceId?: string;
  onChange: (value: unknown) => void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function labelFor(
  fieldKey: string,
  schema: JsonSchema,
  ui: Record<string, unknown>,
) {
  return (
    (typeof ui["ui:title"] === "string" && ui["ui:title"]) ||
    schema.title ||
    fieldKey
  );
}

function initialValue(schema: JsonSchema) {
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "object") return {};
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  return "";
}

export function SchemaField({
  fieldKey,
  schema,
  ui,
  value,
  required,
  workspaceId,
  onChange,
}: SchemaFieldProps) {
  const [uploading, setUploading] = useState(false);
  const label = labelFor(fieldKey, schema, ui);
  const widget =
    typeof ui["ui:widget"] === "string" ? ui["ui:widget"] : "";
  const placeholder =
    typeof ui["ui:placeholder"] === "string"
      ? ui["ui:placeholder"]
      : "";
  const title = (
    <span>
      {label}
      {required ? " *" : ""}
    </span>
  );

  if (schema.type === "object") {
    const object = record(value);
    const objectRequired = new Set(schema.required ?? []);
    return (
      <fieldset className="schema-object">
        <legend>{title}</legend>
        {schema.description && <small>{schema.description}</small>}
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <SchemaField
            key={key}
            fieldKey={key}
            schema={child}
            ui={record(ui[key])}
            value={object[key] ?? child.default}
            required={objectRequired.has(key)}
            workspaceId={workspaceId}
            onChange={(next) => onChange({ ...object, [key]: next })}
          />
        ))}
      </fieldset>
    );
  }

  if (schema.type === "array") {
    const items = Array.isArray(value) ? value : [];
    const itemSchema = schema.items ?? { type: "string" };
    return (
      <fieldset className="schema-array">
        <legend>{title}</legend>
        {items.map((item, index) => (
          <div className="schema-array-row" key={`${fieldKey}-${index}`}>
            <SchemaField
              fieldKey={`${label} ${index + 1}`}
              schema={itemSchema}
              ui={record(ui.items)}
              value={item}
              workspaceId={workspaceId}
              onChange={(next) =>
                onChange(
                  items.map((current, itemIndex) =>
                    itemIndex === index ? next : current,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`删除 ${label} 第 ${index + 1} 项`}
              onClick={() =>
                onChange(items.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="schema-add-item"
          disabled={
            schema.maxItems !== undefined && items.length >= schema.maxItems
          }
          onClick={() => onChange([...items, initialValue(itemSchema)])}
        >
          <Plus size={14} /> 添加{label}
        </button>
      </fieldset>
    );
  }

  if (schema.type === "boolean") {
    return (
      <label className="schema-boolean">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {title}
      </label>
    );
  }

  if (schema.enum?.length) {
    if (widget === "radio" || widget === "segmented") {
      return (
        <fieldset className={`schema-options is-${widget}`}>
          <legend>{title}</legend>
          <div>
            {schema.enum.map((option) => (
              <label key={String(option)}>
                <input
                  type="radio"
                  name={fieldKey}
                  value={String(option)}
                  checked={String(value ?? "") === String(option)}
                  onChange={() => onChange(option)}
                />
                <span>{String(option)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
    return (
      <label>
        {title}
        <select
          value={String(value ?? "")}
          onChange={(event) => {
            const option = schema.enum?.find(
              (candidate) => String(candidate) === event.target.value,
            );
            onChange(option);
          }}
        >
          {!required && <option value="">请选择</option>}
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (schema.type === "number" || schema.type === "integer") {
    const range = widget === "range" || widget === "slider";
    return (
      <label>
        {title}
        <div className={range ? "schema-range" : undefined}>
          <input
            type={range ? "range" : "number"}
            value={typeof value === "number" ? value : ""}
            min={schema.minimum}
            max={schema.maximum}
            step={schema.type === "integer" ? 1 : "any"}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? ""
                  : schema.type === "integer"
                    ? Number.parseInt(event.target.value, 10)
                    : Number(event.target.value),
              )
            }
          />
          {range && <output>{String(value ?? "")}</output>}
        </div>
      </label>
    );
  }

  const assetFormat = ["image", "video", "audio", "file", "asset"].includes(
    schema.format ?? "",
  );
  if (assetFormat) {
    return (
      <label className="schema-asset-field">
        {title}
        <input
          value={typeof value === "string" ? value : ""}
          placeholder="asset://..."
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="schema-asset-upload">
          <Upload size={14} />
          {uploading ? "正在上传…" : "上传并选择资产"}
          <input
            type="file"
            accept={
              schema.format === "image"
                ? "image/*"
                : schema.format === "video"
                  ? "video/*"
                  : schema.format === "audio"
                    ? "audio/*"
                    : undefined
            }
            disabled={!workspaceId || uploading}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file || !workspaceId) return;
              setUploading(true);
              try {
                const response = await fetch(
                  `/api/v2/files?workspaceId=${encodeURIComponent(workspaceId)}`,
                  assetUploadRequestInit(file, {
                    sourceType: "schema-field-upload",
                  }),
                );
                const payload = (await response.json()) as {
                  asset?: { uri?: string };
                  error?: string;
                };
                if (!response.ok || !payload.asset?.uri) {
                  throw new Error(payload.error ?? "资产上传失败");
                }
                onChange(payload.asset.uri);
              } finally {
                setUploading(false);
                event.currentTarget.value = "";
              }
            }}
          />
        </span>
      </label>
    );
  }

  const multiline =
    widget === "textarea" ||
    schema.format === "multiline" ||
    schema.format === "prompt";
  return (
    <label>
      {title}
      {multiline ? (
        <textarea
          value={String(value ?? "")}
          placeholder={placeholder}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          required={required}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={schema.format === "uri" ? "url" : "text"}
          value={String(value ?? "")}
          placeholder={placeholder}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          pattern={schema.pattern}
          required={required}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {schema.description && <small>{schema.description}</small>}
    </label>
  );
}
