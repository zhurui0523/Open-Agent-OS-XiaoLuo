"use client";

import type { JsonSchema } from "../lib/json-schema";
import { validateJsonSchema } from "../lib/json-schema";
import { SchemaField } from "./schema-field";

interface SchemaFieldsProps {
  schema?: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  value: Record<string, unknown>;
  workspaceId?: string;
  title?: string;
  onChange: (value: Record<string, unknown>) => void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function SchemaFields({
  schema,
  uiSchema = {},
  value,
  workspaceId,
  title,
  onChange,
}: SchemaFieldsProps) {
  const root = (schema ?? {}) as JsonSchema;
  const properties = root.properties ?? {};
  const required = new Set(root.required ?? []);
  const configuredOrder = Array.isArray(uiSchema["ui:order"])
    ? uiSchema["ui:order"].filter(
        (item): item is string => typeof item === "string" && item !== "*",
      )
    : [];
  const keys = [
    ...configuredOrder.filter((key) => key in properties),
    ...Object.keys(properties).filter((key) => !configuredOrder.includes(key)),
  ];
  const issues = validateJsonSchema(root, value);
  if (!keys.length) return null;

  return (
    <div className="schema-fields">
      <div className="schema-fields-heading">
        <span>{title ?? "能力参数"}</span>
        <small>
          {issues.length
            ? `${issues.length} 项需要完善`
            : "Schema 校验通过"}
        </small>
      </div>
      {keys.map((key) => (
        <SchemaField
          key={key}
          fieldKey={key}
          schema={properties[key]}
          ui={record(uiSchema[key])}
          value={value[key] ?? properties[key].default}
          required={required.has(key)}
          workspaceId={workspaceId}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
      {!!issues.length && (
        <ul className="schema-validation-errors" aria-live="polite">
          {issues.slice(0, 4).map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              {issue.path.replace(/^\$\./, "")}：{issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
