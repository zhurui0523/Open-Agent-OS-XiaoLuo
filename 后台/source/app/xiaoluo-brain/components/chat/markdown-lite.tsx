/**
 * markdown-lite —— 零依赖轻量 Markdown 渲染器（Codex 式对话器配套）。
 * 覆盖小逻正文常见输出：标题 / 列表 / 粗体 / 斜体 / 行内代码 /
 * 代码块（深色底 + 语言标签 + 复制按钮）。不引入 react-markdown 等新依赖。
 */
"use client";

import { useState, type ReactNode } from "react";
import { copyTextToClipboard } from "./clipboard";

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
            void copyTextToClipboard(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
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

// ---------- CHAT-STYLE：主题常量 ----------

/** 标题渐变（与输入条发送键同系）：一级标题用 */
const HEAD_GRADIENT = "linear-gradient(90deg, #4f46e5, #a855f7)";
/** 强调紫：行首「表情 标题：」与加粗用 */
const ACCENT = "#4f46e5";
/** 行首表情小标题：🎮 游戏功能：… → 强调渲染（覆盖常见 emoji 码点段） */
const EMOJI_LEAD = /^(\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]{0,4})\s*([^\n：:]{1,24}[：:])([\s\S]*)$/u;

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

    // 标题（CHAT-STYLE：一级渐变主题色，层级字号拉开）
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const lvl = heading[1].length;
      blocks.push(
        <div
          key={`b${key}`}
          style={{
            fontWeight: 700,
            fontSize: lvl === 1 ? 16 : lvl === 2 ? 14 : 13,
            margin: "10px 0 4px",
            ...(lvl <= 2
              ? { background: HEAD_GRADIENT, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }
              : { color: "#111827" }),
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
            <div key={idx} style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
              {/* CHAT-STYLE：无序=紫色圆点，有序=靛蓝序号，行距拉开 */}
              <span
                style={
                  ordered
                    ? { color: "#4f46e5", fontWeight: 600, flexShrink: 0, fontSize: 12 }
                    : {
                        width: 5,
                        height: 5,
                        borderRadius: 9999,
                        background: HEAD_GRADIENT,
                        flexShrink: 0,
                        alignSelf: "center",
                      }
                }
              >
                {ordered ? `${idx + 1}.` : ""}
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
    const paraText = buf.join("\n");
    // CHAT-STYLE：行首「🎮 游戏功能：」这类表情小标题自动加粗着色，正文保持段落感
    const lead = EMOJI_LEAD.exec(paraText);
    blocks.push(
      <div key={`b${key}`} style={{ margin: "3px 0", whiteSpace: "pre-wrap" }}>
        {lead ? (
          <>
            <span style={{ fontWeight: 700, color: ACCENT }}>
              {lead[1]} {lead[2]}
            </span>
            {lead[3].trim() ? renderInline(lead[3].replace(/^\n/, ""), `p${key}`) : null}
          </>
        ) : (
          renderInline(paraText, `p${key}`)
        )}
      </div>,
    );
    key += 1;
  }

  return <div style={{ fontSize: 13, lineHeight: 1.7 }}>{blocks}</div>;
}
