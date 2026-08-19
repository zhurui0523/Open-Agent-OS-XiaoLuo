/**
 * markdown-lite —— 零依赖轻量 Markdown 渲染器（Codex 式对话器配套）。
 * 覆盖小逻正文常见输出：标题 / 列表 / 粗体 / 斜体 / 行内代码 /
 * 代码块（深色底 + 语言标签 + 复制按钮）。不引入 react-markdown 等新依赖。
 */
"use client";

import { useState, type ReactNode } from "react";

// ---------- 行内：**粗体** *斜体* `行内代码` ----------

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyBase}-i${i}`;
    i += 1;
    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          style={{
            background: "#f3f4f6",
            border: "1px solid #e5e7eb",
            borderRadius: 4,
            padding: "0 4px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ---------- 代码块：深色底 + 语言标签 + 复制 ----------

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        borderRadius: 10,
        overflow: "hidden",
        border: "1px solid #2b2f36",
        margin: "6px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px 10px",
          background: "#161b22",
          color: "#8b949e",
          fontSize: 11,
        }}
      >
        <span>{lang || "代码"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
          style={{
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          background: "#0d1117",
          color: "#e6edf3",
          fontSize: 12,
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

// ---------- 块级解析 ----------

/** 轻量 Markdown 渲染（受控文本，无脚本注入面） */
export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾围栏（缺失时自然越界结束）
      blocks.push(<CodeBlock key={`b${key}`} lang={lang} code={buf.join("\n")} />);
      key += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <div
          key={`b${key}`}
          style={{
            fontWeight: 600,
            fontSize: heading[1].length <= 2 ? 14 : 13,
            margin: "8px 0 4px",
          }}
        >
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      key += 1;
      i += 1;
      continue;
    }

    // 列表（连续 -/* 或 1.）
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const itemPattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      const items: string[] = [];
      while (i < lines.length && itemPattern.test(lines[i])) {
        items.push(lines[i].replace(itemPattern, ""));
        i += 1;
      }
      blocks.push(
        <div
          key={`b${key}`}
          style={{ display: "flex", flexDirection: "column", gap: 2, margin: "4px 0 4px 4px" }}
        >
          {items.map((item, idx) => (
            <div key={idx} style={{ display: "flex", gap: 6 }}>
              <span style={{ color: "#6b7280", flexShrink: 0 }}>
                {ordered ? `${idx + 1}.` : "•"}
              </span>
              <span>{renderInline(item, `l${key}-${idx}`)}</span>
            </div>
          ))}
        </div>,
      );
      key += 1;
      continue;
    }

    // 引用
    if (line.trimStart().startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <div
          key={`b${key}`}
          style={{
            borderLeft: "3px solid #d1d5db",
            paddingLeft: 10,
            color: "#6b7280",
            margin: "4px 0",
          }}
        >
          {renderInline(buf.join(" "), `q${key}`)}
        </div>,
      );
      key += 1;
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落（合并连续普通行）
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <div key={`b${key}`} style={{ margin: "2px 0", whiteSpace: "pre-wrap" }}>
        {renderInline(buf.join("\n"), `p${key}`)}
      </div>,
    );
    key += 1;
  }

  return <div style={{ fontSize: 13, lineHeight: 1.7 }}>{blocks}</div>;
}
