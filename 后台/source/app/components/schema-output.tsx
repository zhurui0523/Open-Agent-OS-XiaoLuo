"use client";

import { VideoPlayer } from "./video-player";

interface JsonSchema {
  type?: string;
  title?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

interface SchemaOutputProps {
  schema: Record<string, unknown>;
  value: unknown;
  label?: string;
}

function media(schema: JsonSchema, value: unknown) {
  if (typeof value !== "string" || !value) return null;
  if (schema.format === "image") {
    return (
      // Result URLs come from user-configured providers and OSS.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={value} alt={schema.title ?? "生成图像"} loading="lazy" />
    );
  }
  if (schema.format === "video") {
    return <VideoPlayer src={value} title={schema.title} />;
  }
  if (schema.format === "audio") {
    return <audio src={value} controls preload="metadata" />;
  }
  if (["file", "uri"].includes(schema.format ?? "")) {
    return (
      <span className="schema-output-file-actions">
        <a href={value} target="_blank" rel="noreferrer">
          打开文件
        </a>
        <a href={value} download>
          下载
        </a>
      </span>
    );
  }
  return null;
}

function OutputValue({
  schema,
  value,
  path,
}: {
  schema: JsonSchema;
  value: unknown;
  path: string;
}) {
  const mediaElement = media(schema, value);
  if (mediaElement) {
    return <div className="schema-output-media">{mediaElement}</div>;
  }
  if (schema.type === "object" && schema.properties) {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <dl className="schema-output-object">
        {Object.entries(schema.properties).map(([key, child]) => (
          <div key={`${path}.${key}`}>
            <dt>{child.title ?? key}</dt>
            <dd>
              <OutputValue
                schema={child}
                value={record[key]}
                path={`${path}.${key}`}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return (
      <ol className="schema-output-array">
        {value.map((item, index) => (
          <li key={`${path}.${index}`}>
            <OutputValue
              schema={schema.items ?? {}}
              value={item}
              path={`${path}.${index}`}
            />
          </li>
        ))}
      </ol>
    );
  }
  if (value === null || value === undefined || value === "") {
    return <span className="schema-output-empty">暂无结果</span>;
  }
  if (typeof value === "object") {
    return <pre>{JSON.stringify(value, null, 2)}</pre>;
  }
  return <span>{String(value)}</span>;
}

export function SchemaOutput({
  schema,
  value,
  label = "结果",
}: SchemaOutputProps) {
  return (
    <section className="schema-output" aria-label={label}>
      <OutputValue schema={schema as JsonSchema} value={value} path="$" />
    </section>
  );
}
