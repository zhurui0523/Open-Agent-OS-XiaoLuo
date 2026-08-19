/**
 * Xiaoluo Brain panel - the chat-driven "xiaoluo brain" composer mode inside
 * the intent console: writes code, renders previews, asks back before acting.
 * Runtime lives in app/xiaoluo-brain (ChatAgent); LLM calls are proxied by
 * /api/v2/brain/chat so API keys never reach the browser.
 */
"use client";

import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type MutableRefObject,
  type ReactNode,
  useRef,
} from "react";
import {
  AlertTriangle,
  Activity,
  Bookmark,
  BookOpen,
  Brain,
  Download,
  FolderSearch,
  History,
  Eye,
  FileCode,
  FilePen,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  MessagesSquare,
  Package,
  Play,
  CheckCircle2,
  Circle,
  ExternalLink,
  RefreshCw,
  Search,
  Plug,
  SearchCode,
  Server,
  Settings2,
  Square,
  TerminalSquare,  Store,

  Wrench,
} from "lucide-react";
import type { ModelConnection } from "../types";
import { MarkdownLite } from "../xiaoluo-brain/components/chat/markdown-lite";
import { useChatAgent } from "../xiaoluo-brain/hooks/use-chat-agent";
import type {
  ChatAdapters,
  ChatUIMessage,
} from "../xiaoluo-brain/hooks/use-chat-agent";
import { HttpChatStore, HttpProgramStore } from "../xiaoluo-brain/lib/brain/api";
import { buildPreviewDocument, isPreviewable } from "../xiaoluo-brain/lib/brain/preview";
import type { CodeArtifact, ProgramMeta, ServiceRunInfo } from "../xiaoluo-brain/lib/brain/types";
/** 交付卡数据（deploy_program / package_program 落盘凭据） */
interface DeliveryMeta {
  mode: "deploy" | "package";
  dir: string;
  fileCount: number;
  entryFile?: string;
  installHint?: string;
  runHint?: string;
  warnings?: string[];
}
/** 规划卡数据（todo_write 任务清单项） */
interface PlanTodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "complete";
}
type XiaoLuoDesktopCommandResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** 输出超长时的落盘相对路径（read_file 可分页读全文） */
  spillPath?: string;
  error?: string;
  code?: string;
  reasons?: string[];
};
type XiaoLuoDesktopServiceResult = Partial<ServiceRunInfo> & {
  error?: string;
  code?: string;
  reasons?: string[];
  services?: ServiceRunInfo[];
};
type XiaoLuoDesktopFsResult = {
  entries?: { path: string; isDir: boolean; size?: number }[];
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  hits?: { path: string; line: number; text: string }[];
  paths?: string[];
  ok?: boolean;
  error?: string;
};
/** 桌面端主进程桥（preload.cjs 经 contextBridge 暴露；浏览器环境为 undefined） */
interface XiaoLuoDesktopBridge {
  fsAction: (payload: { action: string; path: string; content?: string; opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" } }) => Promise<XiaoLuoDesktopFsResult>;
  runCommand: (payload: { command: string; cwd?: string; timeoutMs?: number; approved?: boolean }) => Promise<XiaoLuoDesktopCommandResult>;
  manageService: (payload: { action: "start" | "stop" | "status"; command?: string; ttlMs?: number; cwd?: string; id?: string; approved?: boolean }) => Promise<XiaoLuoDesktopServiceResult>;
  deployProgram: (payload: { name?: string; files: { path: string; content: string }[]; entryFile?: string }) => Promise<{ dir?: string; fileCount?: number; error?: string }>;
  mcpAction: (payload: { action: string; server?: string; tool?: string; arguments?: Record<string, unknown> }) => Promise<{ servers?: { name: string; ok?: boolean; error?: string; tools?: { rawName: string; description: string; inputSchema?: Record<string, unknown> }[] }[]; ok?: boolean; text?: string; error?: string }>;
  fetchLocal: (payload: { url: string }) => Promise<{ ok?: boolean; status?: number; contentType?: string; text?: string; error?: string }>;
}
declare global {
  interface Window {
    xiaoluoDesktop?: XiaoLuoDesktopBridge;
  }
}
/** 审批弹窗风险摘要：把 reasons 标签翻译成人话，防老板不看内容盲点批准 */
function riskSummary(reasons?: string[]): string {
  if (!reasons || reasons.length === 0) return "";
  const map: Record<string, string> = {
    全局安装依赖: "会往系统全局环境装软件包（影响所有项目，不只是当前工作区）",
    系统包管理器安装: "会调用 winget/choco/scoop/apt/brew 等系统级包管理器改动本机环境",
    "Python 包安装": "会往 Python 环境装依赖包（pip/uv install）",
  };
  const lines = reasons.map((r) => "⚠ " + (map[r] ?? "命中风险签名：" + r));
  return "\n【风险摘要·批准前请看清】\n" + lines.join("\n");
}

function desktopRuntime(): XiaoLuoDesktopBridge | null {
  return typeof window !== "undefined" && window.xiaoluoDesktop ? window.xiaoluoDesktop : null;
}

/** 流式结果：SSE 边收边拼，正文增量喂 onDelta，tool_calls 碎片按 index 拼装 */
interface StreamAccum {
  content: string;
  tools: Array<{ id: string; name: string; argsJson: string }>;
  usage: { prompt: number; completion: number };
}

async function parseBrainSSE(
  body: ReadableStream<Uint8Array>,
  protocol: "openai" | "anthropic",
  onDelta?: (text: string) => void,
): Promise<StreamAccum> {
  const acc: StreamAccum = { content: "", tools: [], usage: { prompt: 0, completion: 0 } };
  const tcByIndex = new Map<number, { id: string; name: string; argsJson: string }>();
  let blockType = "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onOpenAIData = (obj: unknown) => {
    const ch = obj as {
      choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const delta = ch.choices?.[0]?.delta;
    if (delta?.content) {
      acc.content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const slot = tcByIndex.get(idx) ?? { id: "", name: "", argsJson: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
      tcByIndex.set(idx, slot);
    }
    if (ch.usage) {
      acc.usage.prompt = ch.usage.prompt_tokens ?? acc.usage.prompt;
      acc.usage.completion = ch.usage.completion_tokens ?? acc.usage.completion;
    }
  };
  const onAnthropicEvent = (event: string, obj: unknown) => {
    const d = obj as {
      message?: { usage?: { input_tokens?: number } };
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string };
      usage?: { output_tokens?: number };
    };
    if (event === "message_start") {
      acc.usage.prompt = d.message?.usage?.input_tokens ?? 0;
    } else if (event === "content_block_start") {
      blockType = d.content_block?.type ?? "";
      if (blockType === "tool_use") {
        tcByIndex.set(tcByIndex.size, { id: d.content_block?.id ?? "", name: d.content_block?.name ?? "", argsJson: "" });
      }
    } else if (event === "content_block_delta") {
      if (d.delta?.type === "text_delta" && d.delta.text) {
        acc.content += d.delta.text;
        onDelta?.(d.delta.text);
      } else if (d.delta?.type === "input_json_delta" && d.delta.partial_json) {
        const slot = tcByIndex.get(tcByIndex.size - 1);
        if (slot) slot.argsJson += d.delta.partial_json;
      }
    } else if (event === "message_delta") {
      acc.usage.completion = d.usage?.output_tokens ?? acc.usage.completion;
    }
  };
  let lastEvent = "";
  const processLine = (line: string) => {
    if (line.startsWith("event:")) {
      lastEvent = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let obj: unknown;
      try {
        obj = JSON.parse(data);
      } catch {
        return;
      }
      if (protocol === "openai") onOpenAIData(obj);
      else onAnthropicEvent(lastEvent, obj);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      processLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf) processLine(buf.replace(/\r$/, ""));
  acc.tools = [...tcByIndex.values()].filter((t) => t.name);
  return acc;
}

/** 小改动 diff 块：红删绿增（edit_file 事件展示改了哪几行） */
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split("\n").slice(0, 12);
  const newLines = newText.split("\n").slice(0, 12);
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", marginTop: 4, fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
      {oldLines.map((l, i) => (
        <div key={"o" + i} style={{ background: "#fef2f2", color: "#b91c1c", padding: "1px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>- {l}</div>
      ))}
      {newLines.map((l, i) => (
        <div key={"n" + i} style={{ background: "#f0fdf4", color: "#15803d", padding: "1px 8px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>+ {l}</div>
      ))}
    </div>
  );
}

import type { BrainResultSnapshot } from "./brain-result-dock";
import { resolveAssetContentUrl } from "./asset-content-preview";
import { BrainLLMError } from "../xiaoluo-brain/lib/brain/types";
import type { ChatMessage, ToolCall } from "../xiaoluo-brain/lib/brain/types";

/** 宿主（对话器底部输入条）驱动面板的句柄 */
export interface BrainPanelHandle {
  /** 发送正文；attachments 由面板物化进工作区 uploads/ 后随正文注入【附件】段 */
  send: (text: string, attachments?: ChatAttachmentRef[]) => void;
}

/** 宿主附件最小形（面板不依赖画布 ChatAttachment 全量类型） */
export interface ChatAttachmentRef {
  name: string;
  kind: string;
  uri: string;
  previewUrl?: string;
}

interface XiaoluoBrainPanelProps {
  canvasId: string;
  models: ModelConnection[];
  /** 五模态生成直派口（画布节点执行），由对话器宿主注入 */
  onGenerateMedia?: ChatAdapters["generateMedia"];
  /** 宿主选项条里用户选定的文本大模型 id（未选则按健康度/优先级自动取） */
  selectedModelId?: string;
  /** 宿主底部输入条的发送句柄注册口 */
  sendRef?: MutableRefObject<BrainPanelHandle | null>;
  /** 最新代码产物/预览上报口（画布独立结果面板） */
  onBrainResult?: (snapshot: BrainResultSnapshot) => void;
  /** 程序库一键上画布（画布⇄代码）：宿主把程序产物变成画布节点 */
  onPinProgram?: (p: { name: string; entry: string; artifact: NonNullable<BrainResultSnapshot["artifact"]> }) => void;
  /** 时间线事件跳转：打开“小逻结果”面板并定位到指定 Tab */
  onOpenResult?: (tab: "code" | "preview") => void;
}

/** ChatAgent message history -> OpenAI-compatible wire messages */
function toWireMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
        name: m.toolName,
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant" as const,
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** 深度思考折叠块（Codex 式）：灰底，默认收起 */
function ThinkBlock({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div
      style={{
        borderRadius: 10,
        background: "#f6f7f9",
        border: "1px solid #eef0f3",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          color: "#6b7280",
        }}
      >
        <Brain size={13} />
        深度思考
        <span style={{ marginLeft: "auto", opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div
          style={{
            padding: "0 10px 8px",
            fontSize: 12,
            color: "#6b7280",
            whiteSpace: "pre-wrap",
            lineHeight: 1.7,
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Codex 式时间线事件行 ----------

/** MCP 工具公开名：mcp__<server>__<tool>（归一化，与 Claude Code/Codex 同形状） */
function qualifyMcpName(server: string, raw: string): string {
  const clean = (s: string) => String(s).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  let q = "mcp__" + clean(server).slice(0, 24) + "__" + clean(raw);
  if (q.length > 64) q = q.slice(0, 64);
  return q;
}

const EVENT_ICONS: Record<string, typeof Eye> = {
  write_code: FileCode,
  preview_code: Eye,
  write_file: FilePen,
  run_command: TerminalSquare,
  web_search: Search,
  browse_page: Globe,
  read_file: FileText,
  list_dir: FolderOpen,
  git: GitBranch,
  add_memory: Bookmark,
  grep_files: SearchCode,
  find_files: FolderSearch,
  start_service: Play,
  stop_service: Square,
  service_status: Activity,
  deploy_program: Download,
  debate_ideas: MessagesSquare,
  ask_user: MessageCircleQuestion,
  package_program: Package,
todo_write: ListTodo,
  load_skill: BookOpen,
  save_skill: FilePen,
  edit_file: FilePen,
  query_ledger: BookOpen,
  llm_interrupted: AlertTriangle,
  session_restored: History,
};

const EVENT_VERBS: Record<string, string> = {
  write_code: "写入",
  preview_code: "预览",
  write_file: "写文件",
  run_command: "执行命令",
  web_search: "检索",
  browse_page: "读取网页",
  read_file: "读文件",
  list_dir: "列目录",
  git: "git",
  add_memory: "记住",
  grep_files: "搜内容",
  find_files: "找文件",
  start_service: "起服务",
  stop_service: "停服务",
  service_status: "查服务",
  deploy_program: "部署到本机",
  debate_ideas: "多视角碰撞",
  ask_user: "请老板定夺",
  package_program: "组包交付",
todo_write: "列计划",
  load_skill: "加载技能",
  save_skill: "沉淀技能",
  install_plugin: "装插件",
  edit_file: "改文件",
  query_ledger: "查账本",
  llm_interrupted: "中断",
  session_restored: "已恢复",
};

interface EventMeta {
  tool?: string;
  target?: string;
  ok?: boolean;
  files?: { path: string; language: string; chars: number }[];
  output?: string;
  detail?: string;
  /** 输出超长时的全文落盘相对路径 */
  spillPath?: string;
  /** 测试信号：jest/pytest/vitest/go test 的通过/失败计数 */
  testReport?: { passed?: number; failed?: number; summary?: string };
  diagnosis?: string;
}

/** 反查消息流里最近的完整代码产物（预览卡的代码区数据源） */
function lookupCodeArtifact(msgs: ChatUIMessage[], beforeIdx = msgs.length): CodeArtifact | null {
  // 只向前查到该卡片之前：旧预览卡展示它当时的产物，不被后续新产物串味
  for (let i = beforeIdx - 1; i >= 0; i -= 1) {
    const art = msgs[i].artifact;
    if (art?.files?.length) return art;
  }
  return null;
}

/** 预览卡：文件清单一览（不在对话里内嵌代码）；点击任何文件/按钮都跳左侧结果面板 */
function PreviewFileCard({
  msg,
  artifact,
  onOpenResult,
}: {
  msg: ChatUIMessage;
  artifact: CodeArtifact | null;
  onOpenResult?: (tab: "code" | "preview") => void;
}) {
  const files = artifact?.files ?? [];
  return (
    <div
      key={msg.id}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#fff",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          fontSize: 13,
          fontWeight: 600,
          background: "#fafafa",
          borderBottom: "1px solid #eef0f3",
        }}
      >
        <FileCode size={14} color="#4f46e5" />
        <span>预览</span>
        <span
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontWeight: 400,
            color: "#4b5563",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {msg.preview?.title ?? msg.content.replace(/^预览：/, "")}
        </span>
      </div>
      {files.length ? (
        <div style={{ padding: "4px 0" }}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onOpenResult?.("code")}
              title="到结果面板查看该文件"
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                width: "100%",
                padding: "5px 12px",
                border: "none",
                background: "transparent",
                fontSize: 12,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                color: "#374151",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <FileText size={12} style={{ flexShrink: 0, color: "#9ca3af" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
              <span style={{ marginLeft: "auto", flexShrink: 0, color: "#9ca3af" }}>
                {f.language} · {f.content.length} 字符
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {onOpenResult ? (
        <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderTop: "1px solid #eef0f3", background: "#fafafa" }}>
          <button
            type="button"
            onClick={() => onOpenResult("preview")}
            style={{ padding: "2px 10px", borderRadius: 999, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4f46e5", fontSize: 12, cursor: "pointer" }}
          >
            打开预览
          </button>
          <button
            type="button"
            onClick={() => onOpenResult("code")}
            style={{ padding: "2px 10px", borderRadius: 999, border: "1px solid #e5e7eb", background: "#fff", color: "#4b5563", fontSize: 12, cursor: "pointer" }}
          >
            查看代码
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 结构化事件行：图标 + 动词 + 目标 + 时间，展开看明细 / 跳转结果面板 */
function TimelineEvent({
  msg,
  defaultOpen,
  onOpenResult,
}: {
  msg: ChatUIMessage;
  defaultOpen?: boolean;
  onOpenResult?: (tab: "code" | "preview") => void;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const meta = (msg.meta ?? {}) as EventMeta;
  const tool = meta.tool ?? "";
  const Icon = EVENT_ICONS[tool] ?? (tool.startsWith("mcp__") ? Plug : Wrench);
  const verb = EVENT_VERBS[tool] ?? msg.content;
  const ok = meta.ok !== false;
  const hasDetail = Boolean(meta.files?.length || meta.output || meta.detail || meta.testReport || meta.spillPath);
  const expandable = hasDetail || tool === "write_code" || tool === "preview_code";
  const time = new Date(msg.createdAt).toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <div style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 12.5, alignItems: "flex-start" }}>
      <span style={{ color: ok ? "#4f46e5" : "#dc2626", display: "inline-flex", marginTop: 2 }}>
        <Icon size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => expandable && setOpen((o) => !o)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "inherit",
            cursor: expandable ? "pointer" : "default",
            display: "flex",
            gap: 6,
            alignItems: "baseline",
            width: "100%",
            textAlign: "left",
          }}
        >
          <span style={{ fontWeight: 600, flexShrink: 0 }}>{verb}</span>
          {meta.target ? (
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                color: "#374151",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {meta.target}
            </span>
          ) : null}
          <span style={{ color: "#9ca3af", flexShrink: 0, marginLeft: "auto" }}>{time}</span>
        </button>
        {open ? (
          <div style={{ marginTop: 4, padding: "6px 8px", background: "#f8fafc", borderRadius: 8, border: "1px solid #eef0f3" }}>
            {meta.testReport || meta.spillPath ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                {meta.testReport ? (
                  <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, border: "1px solid " + (meta.testReport.failed ? "#fecaca" : "#bbf7d0"), background: meta.testReport.failed ? "#fef2f2" : "#f0fdf4", color: meta.testReport.failed ? "#dc2626" : "#16a34a" }}>
                    测试信号 {meta.testReport.passed ?? 0} 通过 / {meta.testReport.failed ?? 0} 失败{meta.testReport.summary ? `（${meta.testReport.summary}）` : ""}
                  </span>
                ) : null}
                {meta.spillPath ? (
                  <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 999, border: "1px solid #fde68a", background: "#fffbeb", color: "#b45309", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
                    全文已落盘 {meta.spillPath}
                  </span>
                ) : null}
              </div>
            ) : null}
            {meta.files?.length ? (
              <div>
                {meta.files.map((f) => (
                  <div key={f.path} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", color: "#4b5563" }}>
                    {f.path} <span style={{ color: "#9ca3af" }}>· {f.language} · {f.chars} 字符</span>
                  </div>
                ))}
              </div>
            ) : null}
            {meta.output || meta.detail ? (
              <div style={{ marginTop: meta.files?.length ? 4 : 0, whiteSpace: "pre-wrap", color: "#4b5563", maxHeight: 140, overflow: "auto" }}>
                {meta.output || meta.detail}
              </div>
            ) : null}
            {tool === "write_code" && onOpenResult ? (
              <button
                type="button"
                onClick={() => onOpenResult("code")}
                style={{ marginTop: 6, padding: "2px 10px", borderRadius: 999, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4f46e5", fontSize: 12, cursor: "pointer" }}
              >
                查看代码
              </button>
            ) : null}
            {tool === "preview_code" && onOpenResult ? (
              <button
                type="button"
                onClick={() => onOpenResult("preview")}
                style={{ marginTop: 6, padding: "2px 10px", borderRadius: 999, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4f46e5", fontSize: 12, cursor: "pointer" }}
              >
                打开预览
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 工具步骤折叠组（Codex 式）：“执行了 N 步”+ 末步摘要，展开看明细 */
function StepGroup({ msgs, defaultOpen }: { msgs: ChatUIMessage[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const last = msgs[msgs.length - 1];
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid #eef0f3",
        background: "#fbfbfc",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          color: "#6b7280",
          textAlign: "left",
        }}
      >
        <Settings2 size={13} style={{ flexShrink: 0 }} />
        <span style={{ flexShrink: 0 }}>执行了 {msgs.length} 步</span>
        {!open ? (
          <span
            style={{
              flex: 1,
              color: "#9ca3af",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {last.content}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <span style={{ opacity: 0.7, flexShrink: 0 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div style={{ padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
          {msgs.map((s, idx) => (
            <div
              key={s.id}
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              style={{
                fontSize: 12,
                color: "#6b7280",
                cursor: "pointer",
                whiteSpace: expandedIdx === idx ? "pre-wrap" : "nowrap",
                overflow: "hidden",
                textOverflow: expandedIdx === idx ? undefined : "ellipsis",
              }}
            >
              · {s.content}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function XiaoluoBrainPanel({
  canvasId,
  models,
  onGenerateMedia,
  selectedModelId,
  sendRef,
  onBrainResult,
  onOpenResult,
  onPinProgram,
}: XiaoluoBrainPanelProps) {
  const [askDraft, setAskDraft] = useState("");

  const brainModels = useMemo(
    () =>
      models
        .filter((m) => m.enabled !== false && m.modalities.includes("text"))
        .sort((a, b) => {
          const health =
            Number(b.state === "healthy") - Number(a.state === "healthy");
          return health || (b.priority ?? 0) - (a.priority ?? 0);
        }),
    [models],
  );
  const effectiveModel =
    brainModels.find((m) => m.id === selectedModelId) ?? brainModels[0] ?? null;

  // ---- MCP 外部工具：连工作区 mcp.json 里的服务器，工具以 mcp__<server>__<tool> 注册进工具面 ----
  const [mcpTools, setMcpTools] = useState<{ name: string; description: string; inputSchema?: Record<string, unknown> }[]>([]);
  const [mcpServers, setMcpServers] = useState<{ name: string; ok: boolean; error?: string; toolCount: number }[]>([]);
  const mcpMapRef = useRef(new Map<string, { server: string; raw: string }>());
  useEffect(() => {
    const desktop = desktopRuntime();
    if (!desktop || typeof desktop.mcpAction !== "function") return;
    let live = true;
    (async () => {
      try {
        const res = await desktop.mcpAction({ action: "servers" });
        if (!live || res.error) return;
        const map = new Map<string, { server: string; raw: string }>();
        const tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[] = [];
        const servers: { name: string; ok: boolean; error?: string; toolCount: number }[] = [];
        for (const s of res.servers ?? []) {
          servers.push({ name: s.name, ok: Boolean(s.ok), error: s.error, toolCount: (s.tools ?? []).length });
          if (!s.ok) continue;
          for (const t of s.tools ?? []) {
            const q = qualifyMcpName(s.name, t.rawName);
            if (map.has(q)) continue;
            map.set(q, { server: s.name, raw: t.rawName });
            tools.push({ name: q, description: t.description, inputSchema: t.inputSchema });
          }
        }
        mcpMapRef.current = map;
        setMcpTools(tools);
        setMcpServers(servers);
      } catch { /* MCP 同步失败不影响主流程 */ }
    })();
    return () => { live = false; };
  }, []);

  // ---- 技能库（轻量三件套）：扫工作区 skills/ 目录进能力清单，save_skill 落盘后轮末自动刷新 ----
  const [skillCatalog, setSkillCatalog] = useState<{ name: string; description: string }[]>([]);
  const capabilityCatalog = useMemo(() => {
    const base = brainModels
      .map((m) => "- " + m.name + " (" + m.modalities.join("/") + ")")
      .join("\n");
    if (!skillCatalog.length) return base;
    return (
      base +
      "\n[技能库：先 load_skill 读正文再照做；值得复用的做法用 save_skill 沉淀]\n" +
      skillCatalog.map((s) => "- " + s.name + " | skill | " + s.description).join("\n")
    );
  }, [brainModels, skillCatalog]);

  /** 文件系统口的统一入口：桌面模式走主进程本地工作区（与 deploy/command 同一工作区）；
   *  否则走服务端 /api/v2/brain/fs（每用户隔离工作区，路径防穿越） */
  async function brainFs(
    action: "list" | "read" | "write" | "grep" | "find",
    relPath: string,
    content?: string,
    opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" },
  ): Promise<XiaoLuoDesktopFsResult> {
    const desktop = desktopRuntime();
    if (desktop) {
      const res = await desktop.fsAction({ action, path: relPath, content, opts });
      if (res.error) throw new Error(res.error);
      return res;
    }
    const resp = await fetch("/api/v2/brain/fs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, path: relPath, content, opts }),
    });
    const data = (await resp.json().catch(() => ({}))) as XiaoLuoDesktopFsResult;
    if (!resp.ok) {
      throw new Error(data.error ?? "文件操作失败 (" + resp.status + ")");
    }
    return data;
  }

  /** ArrayBuffer → base64（分块防栈溢出；附件物化写盘用） */
  function bufToB64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /** 附件物化：内容 URL 抓取 → base64 落工作区 uploads/，Agent 用 read_file/脚本自取；失败降级为 URL 引用不阻断发送 */
  async function materializeAttachments(list: ChatAttachmentRef[]): Promise<string> {
    const lines: string[] = [];
    const ts = Date.now().toString(36);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const url = resolveAssetContentUrl(a.previewUrl ?? a.uri);
      const safeName = (a.name || "file").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
      const rel = `uploads/${ts}-${i + 1}-${safeName}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error("抓取失败 " + r.status);
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 4 * 1024 * 1024) throw new Error("超过 4MB 上限");
        await brainFs("write", rel, bufToB64(buf), { encoding: "base64" });
        lines.push(`${i + 1}. ${a.name}（${a.kind}）→ 工作区文件 ${rel}`);
      } catch (err) {
        lines.push(`${i + 1}. ${a.name}（${a.kind}）落盘失败（${err instanceof Error ? err.message : String(err)}），内容地址：${url}`);
      }
    }
    return (
      "\n\n【附件】（已落盘到工作区 uploads/）\n" +
      lines.join("\n") +
      "\n（文本类直接 read_file；xlsx/pdf 等二进制自己写解析脚本用 run_command 跑，别声称读不了。）"
    );
  }

  const adapters = useMemo<ChatAdapters>(() => {
    const callLLM: ChatAdapters["callLLM"] = async (req) => {
      const model = effectiveModel;
      if (!model) {
        throw new BrainLLMError("请先在设置里启用一个文本大模型", { retryable: false });
      }
      // 兜底超时 150s：上游挂死不能把整轮吊死在“进行中”；老板停止信号（req.signal）优先
      const timeoutSignal = AbortSignal.timeout(150_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
      let resp: Response;
      try {
        resp = await fetch("/api/v2/brain/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            canvasId,
            modelId: model.id,
            messages: toWireMessages(req.messages),
            tools: req.tools,
            stream: true,
          }),
          signal,
        });
      } catch (e) {
        if (req.signal?.aborted) throw e; // 老板点了停止：上抛让 Agent 按中止收尾
        throw new BrainLLMError("模型调用超时或连接断开", { retryable: true });
      }
      const flattenError = (raw: unknown): string => {
        if (typeof raw === "string") return raw;
        if (raw && typeof raw === "object") {
          const obj = raw as { message?: unknown; error?: unknown };
          if (typeof obj.message === "string" && obj.message) return obj.message;
          if (obj.error !== undefined) return flattenError(obj.error);
          try { return JSON.stringify(raw); } catch { return String(raw); }
        }
        return String(raw);
      };
      const throwUpstreamError = (status: number, raw: unknown) => {
        const msg = flattenError(raw) || ("模型调用失败 (" + status + ")");
        throw new BrainLLMError(msg, { retryable: status >= 500 || status === 429 });
      };
      if (!resp.ok) {
        let raw: unknown;
        try {
          raw = (await resp.json()) as { error?: unknown };
        } catch {
          /* keep default message */
        }
        throwUpstreamError(resp.status, (raw as { error?: unknown })?.error);
      }
      // 服务端走了流式透传：SSE 边收边喂 onDelta，拼完与非流式同形返回
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && resp.body) {
        const isAnthropic = contentType.includes("profile=anthropic-sse");
        const acc = await parseBrainSSE(resp.body, isAnthropic ? "anthropic" : "openai", req.onDelta);
        const toolCalls: ToolCall[] = acc.tools.map((tc, i) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.argsJson || "{}") as Record<string, unknown>; } catch { /* 坏 JSON 保空，工具层会报参数错 */ }
          return { id: tc.id || ("stream_tc_" + i), name: tc.name, arguments: args };
        });
        return {
          content: acc.content,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          usage: { promptTokens: acc.usage.prompt, completionTokens: acc.usage.completion },
        };
      }
      const data = (await resp.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // 上游 200 但正文带 error（协议转换/网关透传场景）：同样按错误抛出，避免吞错
      if ((data as unknown as { error?: unknown }).error) {
        throwUpstreamError(resp.status, (data as unknown as { error?: unknown }).error);
      }
      const wire = data.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (wire?.tool_calls ?? []).map((tc) => ({
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        arguments: JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>,
      }));
      return {
        content: wire?.content ?? "",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    };
    return {
      callLLM,
      generateMedia: onGenerateMedia,
      /** 网页抓取：走服务端 /api/v2/brain/browse（SSRF 防护在服务端） */
      browser: {
        fetchPage: async (url: string) => {
          // 本地探活（模块2）：环回地址走桌面主进程通道（服务端 SSRF 防护拦 127.* 是对的，本地探活改走主进程）
          const desktop = desktopRuntime();
          const isLoopback = url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost") || url.startsWith("http://[::1]");
          if (desktop && isLoopback) {
            const res = await desktop.fetchLocal({ url });
            if (res.error) throw new Error(res.error);
            return { title: url, text: res.text ?? "" };
          }
          const resp = await fetch("/api/v2/brain/browse", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url }),
          });
          const data = (await resp.json().catch(() => ({}))) as {
            title?: string;
            text?: string;
            error?: string;
          };
          if (!resp.ok) {
            throw new Error(data.error ?? "网页抓取失败 (" + resp.status + ")");
          }
          return { title: data.title ?? "", text: data.text ?? "" };
        },
      },
      /** 联网检索：走服务端 /api/v2/brain/search（供应商用户可切换，默认 DuckDuckGo） */
      webSearch: async (query: string) => {
        const resp = await fetch("/api/v2/brain/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        });
        const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!resp.ok) {
          throw new Error(data.error ?? "检索失败 (" + resp.status + ")");
        }
        return data.text ?? ""; 
      },
      /** 文件系统：桌面模式走主进程本地工作区；否则服务端 /api/v2/brain/fs（防穿越） */
      fs: {
        listDir: async (relPath: string) => (await brainFs("list", relPath)).entries ?? [],
        readFile: async (relPath: string, window?: { offset?: number; limit?: number }) => {
          const res = await brainFs("read", relPath, undefined, window);
          return { content: res.content ?? "", truncated: res.truncated, totalLines: res.totalLines };
        },
        writeFile: async (relPath: string, content: string) => {
          await brainFs("write", relPath, content);
        },
        grep: async (pattern: string, opts?: { path?: string; maxResults?: number }) =>
          (await brainFs("grep", pattern, undefined, opts)).hits ?? [],
        find: async (name: string, opts?: { path?: string; maxResults?: number }) =>
          (await brainFs("find", name, undefined, opts)).paths ?? [],
      },
      /** 终端：走服务端 /api/v2/brain/command（沙箱受控执行 + 风险分级审批门） */
      command: {
        run: async (command: string, opts?: { cwd?: string; timeoutMs?: number }) => {
          const desktop = desktopRuntime();
          if (desktop) {
            let res = await desktop.runCommand({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, approved: false });
            if (res.code === "approval_required") {
              const reasonLines = (res.reasons ?? []).map((r) => "· " + r).join("\n");
              const ok = window.confirm(
                "小逻想在本机执行以下命令，需要你批准：\n\n" +
                  command +
                  riskSummary(res.reasons) +
                  (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                  "\n\n确定执行吗？",
              );
              if (!ok) {
                throw new Error("老板未批准命令「" + command + "」，已取消执行。请改用更保守的做法或先向老板说明理由。");
              }
              res = await desktop.runCommand({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, approved: true });
            }
            if (res.error) throw new Error(res.error);
            return { exitCode: res.exitCode ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", spillPath: res.spillPath };
          }
          const send = async (approved: boolean) => {
            const resp = await fetch("/api/v2/brain/command", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ command, timeoutMs: opts?.timeoutMs, approved }),
            });
            const data = (await resp.json().catch(() => ({}))) as {
              exitCode?: number;
              stdout?: string;
              stderr?: string;
              spillPath?: string;
              error?: string;
              code?: string;
              reasons?: string[];
            };
            return { resp, data };
          };
          let { resp, data } = await send(false);
          if (resp.status === 403 && data.code === "approval_required") {
            const reasonLines = (data.reasons ?? []).map((r) => "· " + r).join("\n");
            const ok = window.confirm(
              "小逻想执行以下命令，需要你批准：\n\n" +
                command +
                riskSummary(data.reasons) +
                (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                "\n\n确定执行吗？",
            );
            if (!ok) {
              throw new Error("老板未批准命令「" + command + "」，已取消执行。请改用更保守的做法或先向老板说明理由。");
            }
            ({ resp, data } = await send(true));
          }
          if (!resp.ok) {
            throw new Error(data.error ?? "命令执行失败 (" + resp.status + ")");
          }
          return { exitCode: data.exitCode ?? 1, stdout: data.stdout ?? "", stderr: data.stderr ?? "", spillPath: data.spillPath };
        },
      },
      /** 服务管理：走服务端 /api/v2/brain/services（二期服务管理器，启动同样走审批门） */
      service: {
        start: async (command, opts) => {
          const desktop = desktopRuntime();
          if (desktop) {
            let res = await desktop.manageService({ action: "start", command, cwd: opts?.cwd, ttlMs: opts?.ttlMs, approved: false });
            if (res.code === "approval_required") {
              const reasonLines = (res.reasons ?? []).map((r) => "· " + r).join("\n");
              const ok = window.confirm(
                "小逻想在本机启动一个长驻服务，需要你批准：\n\n" +
                  command +
                  riskSummary(res.reasons) +
                  (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                  "\n\n确定启动吗？",
              );
              if (!ok) {
                throw new Error("老板未批准启动服务「" + command + "」，已取消。请改用无需启动服务的做法或先向老板说明理由。");
              }
              res = await desktop.manageService({ action: "start", command, cwd: opts?.cwd, ttlMs: opts?.ttlMs, approved: true });
            }
            if (res.error) throw new Error(res.error);
            return {
              id: res.id ?? "",
              command: res.command ?? command,
              pid: res.pid ?? -1,
              port: res.port,
              url: res.url,
              status: res.status ?? "starting",
              listening: res.listening,
              exitCode: res.exitCode,
              ageMs: res.ageMs ?? 0,
              logTail: res.logTail ?? "",
            };
          }
          const send = async (approved: boolean) => {
            const resp = await fetch("/api/v2/brain/services", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "start", command, ttlMs: opts?.ttlMs, approved }),
            });
            const data = (await resp.json().catch(() => ({}))) as Partial<ServiceRunInfo> & {
              error?: string;
              code?: string;
              reasons?: string[];
            };
            return { resp, data };
          };
          let { resp, data } = await send(false);
          if (resp.status === 403 && data.code === "approval_required") {
            const reasonLines = (data.reasons ?? []).map((r) => "· " + r).join("\n");
            const ok = window.confirm(
              "小逻想启动一个长驻服务，需要你批准：\n\n" +
                command +
                riskSummary(data.reasons) +
                (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                "\n\n确定启动吗？",
            );
            if (!ok) {
              throw new Error("老板未批准启动服务「" + command + "」，已取消。请改用无需启动服务的做法或先向老板说明理由。");
            }
            ({ resp, data } = await send(true));
          }
          if (!resp.ok) {
            throw new Error(data.error ?? "服务启动失败 (" + resp.status + ")");
          }
          return {
            id: data.id ?? "",
            command: data.command ?? command,
            pid: data.pid ?? -1,
            port: data.port,
            url: data.url,
            status: data.status ?? "starting",
            listening: data.listening,
            exitCode: data.exitCode,
            ageMs: data.ageMs ?? 0,
            logTail: data.logTail ?? "",
          };
        },
        stop: async (id) => {
          const desktop = desktopRuntime();
          if (desktop) {
            const res = await desktop.manageService({ action: "stop", id });
            if (res.error) throw new Error(res.error);
            return {
              id: res.id ?? id,
              command: res.command ?? "",
              pid: res.pid ?? -1,
              status: res.status ?? "exited",
              listening: res.listening,
              exitCode: res.exitCode,
              ageMs: res.ageMs ?? 0,
              logTail: res.logTail ?? "",
            };
          }
          const resp = await fetch("/api/v2/brain/services", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "stop", id }),
          });
          const data = (await resp.json().catch(() => ({}))) as Partial<ServiceRunInfo> & { error?: string };
          if (!resp.ok) {
            throw new Error(data.error ?? "服务停止失败 (" + resp.status + ")");
          }
          return {
            id: data.id ?? id,
            command: data.command ?? "",
            pid: data.pid ?? -1,
            status: data.status ?? "exited",
            listening: data.listening,
            exitCode: data.exitCode,
            ageMs: data.ageMs ?? 0,
            logTail: data.logTail ?? "",
          };
        },
        status: async (id) => {
          const desktop = desktopRuntime();
          if (desktop) {
            const res = await desktop.manageService({ action: "status", id });
            if (res.error) throw new Error(res.error);
            return res.services ?? [];
          }
          const resp = await fetch("/api/v2/brain/services", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "status", id }),
          });
          const data = (await resp.json().catch(() => ({}))) as { services?: ServiceRunInfo[]; error?: string };
          if (!resp.ok) {
            throw new Error(data.error ?? "服务查询失败 (" + resp.status + ")");
          }
          return data.services ?? [];
        },
      },
      /** git：走服务端 /api/v2/brain/git（操作白名单 status/log/diff/commit/push；push 审批门同命令模式） */
      git: {
        exec: async (op, repoPath, opts) => {
          void repoPath;
          const send = async (approved: boolean) => {
            const resp = await fetch("/api/v2/brain/git", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ op, message: opts?.message, limit: opts?.limit, ref: opts?.ref, approved }),
            });
            const data = (await resp.json().catch(() => ({}))) as { text?: string; error?: string; code?: string; reasons?: string[] };
            return { resp, data };
          };
          let { resp, data } = await send(false);
          if (resp.status === 403 && data.code === "approval_required") {
            const reasonLines = (data.reasons ?? []).map((r: string) => "· " + r).join("\n");
            const ok = window.confirm(
              "小逻想执行 git push，需要你批准：\n\n" +
                riskSummary(data.reasons) +
                (reasonLines ? reasonLines + "\n\n" : "") +
                "确定推送吗？",
            );
            if (!ok) {
              throw new Error("老板未批准 git push，已取消。请改用本地 commit 保存进度，或先向老板说明推送理由。");
            }
            ({ resp, data } = await send(true));
          }
          if (!resp.ok) {
            throw new Error(data.error ?? "git 操作失败 (" + resp.status + ")");
          }
          return data.text ?? "";
        },
      },
      /** 本机落盘（deploy_program；模块3）：桌面主进程通道；无桌面环境则不注册 */
      deployProgram: desktopRuntime()
        ? async (artifact: CodeArtifact, name?: string) => {
            const desktop = desktopRuntime();
            if (!desktop) throw new Error("未接入本机落盘通道。");
            const res = await desktop.deployProgram({
              name,
              files: artifact.files.map((f) => ({ path: f.path, content: f.content })),
              entryFile: artifact.entryFile,
            });
            if (res.error) throw new Error(res.error);
            return { dir: res.dir ?? "", fileCount: res.fileCount ?? artifact.files.length };
          }
        : undefined,
      /** MCP 外部工具：桌面主进程托管 stdio 服务器（工作区 mcp.json）；无桌面通道则不接入 */
      mcp: desktopRuntime()
        ? {
            tools: mcpTools,
            callTool: async (qualified: string, args: Record<string, unknown>) => {
              const desktop = desktopRuntime();
              if (!desktop) throw new Error("MCP 通道未接入。");
              const hit = mcpMapRef.current.get(qualified);
              if (!hit) return "MCP 工具不存在：" + qualified + "（服务器可能未连接）";
              const res = await desktop.mcpAction({ action: "call", server: hit.server, tool: hit.raw, arguments: args });
              if (res.error) throw new Error(res.error);
              return String(res.text ?? "");
            },
          }
        : undefined,
      capabilityCatalog,
      model: effectiveModel?.id ?? "brain",
    };
  }, [canvasId, effectiveModel, capabilityCatalog, onGenerateMedia, mcpTools]);

  /** 对话存档走服务端（同源 /api/v2/chat），任务档案暂留 localStorage */
  const chatStore = useMemo(() => new HttpChatStore({ base: "" }), []);

  const brain = useChatAgent("brain-" + canvasId, adapters, {
    store: chatStore,
  });
  const busy = brain.phase === "thinking";

  // 运行中每秒轮询步骤摘要，驱动运行指示器刷新（Codex 式）
  const [, bumpStep] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(bumpStep, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const stepNote = busy ? brain.getStepNote() : "";

  // 底部对话器输入条通过句柄驱动发送：忙时插话（steer），闲时新发
  useEffect(() => {
    if (!sendRef) return;
    sendRef.current = {
      send: (text: string, attachments?: ChatAttachmentRef[]) => {
        const value = text.trim();
        if (!value) return;
        void (async () => {
          // 附件物化：抓内容 URL → base64 落工作区 uploads/ → 注入【附件】段（二进制不塞正文）
          const block = attachments?.length ? await materializeAttachments(attachments) : "";
          const full = value + block;
          if (busy) {
            brain.steer(full);
            return;
          }
          await brain.send(full);
        })();
      },
    };
    return () => {
      sendRef.current = null;
    };
  });

  /** 最新代码产物 / 预览快照：上报宿主，落到画布独立结果面板 */
  const latestSnapshot = (() => {
    let artifact: BrainResultSnapshot["artifact"] = null;
    let preview: BrainResultSnapshot["preview"] = null;
    let artifactIdx = -1;
    let previewIdx = -1;
    for (let i = brain.messages.length - 1; i >= 0; i -= 1) {
      const msg = brain.messages[i];
      if (!artifact && msg.kind === "code-card" && msg.artifact) { artifact = msg.artifact; artifactIdx = i; }
      if (!preview && msg.kind === "preview-card" && msg.preview) { preview = msg.preview; previewIdx = i; }
      if (artifact && preview) break;
    }
    // 同一程序保证：产物比预览新时按最新产物重建预览（防旧预览与新代码错配）
    if (artifact && artifactIdx > previewIdx) {
      preview = isPreviewable(artifact) ? buildPreviewDocument(artifact) : null;
    }
    return { artifact, preview };
  })();

  useEffect(() => {
    onBrainResult?.(latestSnapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSnapshot.artifact, latestSnapshot.preview]);

  /** 拆分正文中的 <think>…</think> 思考段 */
  const splitThink = (content: string) => {
    const match = /<think>([\s\S]*?)<\/think>/i.exec(content);
    if (!match) return { think: "", body: content };
    return {
      think: match[1].trim(),
      body: (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim(),
    };
  };

  /** Codex 式消息流：连续旁白合并为“执行了 N 步”折叠组，其余按消息渲染 */
  // 最新的结构化事件默认展开
  let lastEventId = "";
  for (let i = brain.messages.length - 1; i >= 0; i -= 1) {
    const mm = brain.messages[i];
    if (mm.kind === "status" && mm.meta && typeof mm.meta.tool === "string") {
      lastEventId = mm.id;
      break;
    }
  }

  const renderGroupItems = (items: ChatUIMessage[]): ReactNode[] => {
    const out: ReactNode[] = [];
    let buf: ChatUIMessage[] = [];
    const flush = (isTail: boolean) => {
      if (!buf.length) return;
      if (buf.length === 1) {
        const m = buf[0];
        out.push(
          <div
            key={"sg-" + m.id}
            style={{ fontSize: 12, color: "#8a8f98", display: "flex", gap: 6, alignItems: "baseline" }}
          >
            <span style={{ opacity: 0.7 }}>·</span>
            <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
          </div>,
        );
      } else {
        out.push(<StepGroup key={"sg-" + buf[0].id} msgs={buf} defaultOpen={busy && isTail} />);
      }
      buf = [];
    };
    items.forEach((m) => {
      if (m.kind === "status") {
        // 结构化事件（带 tool meta）单独成时间线行；纯旁白进折叠组
        if (m.meta && typeof m.meta.tool === "string") {
          flush(false);
          out.push(
            <TimelineEvent key={m.id} msg={m} defaultOpen={m.id === lastEventId} onOpenResult={onOpenResult} />,
          );
          return;
        }
        buf.push(m);
        return;
      }
      flush(false);
      out.push(renderMessage(m));
    });
    flush(true);
    return out;
  };

  /** 对话流回合：老板消息（灰底气泡+时间）+ 小逻回复（处理摘要+结构化内容），一问一答清晰分层 */
  const renderItems = () => {
    const groups: Array<{ key: string; user?: ChatUIMessage; items: ChatUIMessage[] }> = [];
    brain.messages.forEach((m) => {
      if (m.kind === "user") {
        groups.push({ key: m.id, user: m, items: [] });
        return;
      }
      if (!groups.length) groups.push({ key: "pre-" + m.id, items: [] });
      groups[groups.length - 1].items.push(m);
    });
    const lastIdx = groups.length - 1;
    return groups.map((g, gi) => {
      const steps = g.items.filter((x) => x.kind === "status" && x.meta && typeof x.meta.tool === "string").length;
      const running = busy && gi === lastIdx;
      return (
        <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {g.user ? (
            <div style={{ background: "#f5f6f8", borderRadius: 10, padding: "8px 12px" }}>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{g.user.content}</div>
              <div style={{ marginTop: 4, textAlign: "right", fontSize: 11, color: "#9ca3af" }}>
                {new Date(g.user.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
              </div>
            </div>
          ) : null}
          {g.items.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {steps > 0 || running ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#8a8f98" }}>
                  {steps > 0 ? <span>已处理 {steps} 步</span> : null}
                  {running ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#4f46e5" }}>
                      <LoaderCircle size={11} className="spin" /> 进行中
                    </span>
                  ) : (
                    <span style={{ color: "#16a34a" }}>已完成</span>
                  )}
                </div>
              ) : null}
              {renderGroupItems(g.items)}
            </div>
          ) : null}
        </div>
      );
    });
  };

  /** 规划卡：todo_write 的任务清单（进度条+逐项状态），老板实时看到小逻走到哪了 */
  const PlanCard = ({ m }: { m: ChatUIMessage }) => {
    const todos = (m.meta?.todos ?? []) as PlanTodoItem[];
    if (!todos.length) return null;
    const done = todos.filter((t) => t.status === "complete").length;
    return (
      <div
        key={m.id}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 12,
          background: "#fafafa",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#374151" }}>
          <ListTodo size={14} style={{ color: "#4f46e5" }} />
          执行计划
          <span style={{ fontWeight: 400, color: "#9ca3af", fontSize: 12 }}>{done}/{todos.length}</span>
          <span style={{ flex: 1, height: 4, borderRadius: 999, background: "#eef0f3", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: Math.round((done / todos.length) * 100) + "%", background: "#4f46e5" }} />
          </span>
        </div>
        {todos.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {t.status === "complete" ? (
              <CheckCircle2 size={13} style={{ color: "#16a34a", flexShrink: 0 }} />
            ) : t.status === "in_progress" ? (
              <LoaderCircle size={13} className="spin" style={{ color: "#4f46e5", flexShrink: 0 }} />
            ) : (
              <Circle size={13} style={{ color: "#d1d5db", flexShrink: 0 }} />
            )}
            <span
              style={{
                color: t.status === "complete" ? "#9ca3af" : t.status === "in_progress" ? "#4f46e5" : "#374151",
                textDecoration: t.status === "complete" ? "line-through" : "none",
              }}
            >
              {t.content}
            </span>
          </div>
        ))}
      </div>
    );
  };

  /** 交付卡：deploy/package 的落盘凭据独立成卡（路径/用法/风险），不再只留一条旁白 */
  const DeliveryCard = ({ m }: { m: ChatUIMessage }) => {
    const d = (m.meta?.delivery ?? null) as DeliveryMeta | null;
    if (!d) return null;
    const isPkg = d.mode === "package";
    const Icon = isPkg ? Package : Download;
    return (
      <div
        key={m.id}
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 12,
          background: "#fafafa",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#374151" }}>
          <Icon size={14} style={{ color: "#4f46e5" }} />
          {isPkg ? "组包交付完成" : "已部署到本机"}
          <span style={{ fontWeight: 400, color: "#9ca3af", fontSize: 12 }}>{d.fileCount} 个文件</span>
        </div>
        <div
          style={{
            fontFamily: "ui-monospace, Consolas, monospace",
            fontSize: 12,
            background: "#fffbeb",
            color: "#b45309",
            padding: "4px 8px",
            borderRadius: 6,
            wordBreak: "break-all",
          }}
        >
          {d.dir}
        </div>
        {d.entryFile ? <div style={{ color: "#6b7280", fontSize: 12 }}>入口文件：{d.entryFile}</div> : null}
        {d.installHint ? <div style={{ color: "#6b7280", fontSize: 12 }}>安装依赖：{d.installHint}</div> : null}
        {d.runHint ? <div style={{ color: "#6b7280", fontSize: 12 }}>运行方式：{d.runHint}</div> : null}
        {d.warnings?.length ? (
          <div style={{ color: "#dc2626", fontSize: 12, display: "flex", gap: 4, alignItems: "flex-start" }}>
            <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{d.warnings.join("；")}</span>
          </div>
        ) : null}
        <div style={{ color: "#9ca3af", fontSize: 12 }}>
          产物在本机小逻工作区内；让小逻继续装依赖 / 起服务 / 探活即可。
        </div>
      </div>
    );
  };

  const renderMessage = (m: ChatUIMessage) => {
    switch (m.kind) {
      case "user":
        return (
          <div key={m.id} style={{ display: "flex", justifyContent: "flex-end" }}>
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 12,
                background: "#eef2ff",
                whiteSpace: "pre-wrap",
                fontSize: 13,
              }}
            >
              {m.content}
            </div>
          </div>
        );
      case "assistant": {
        // Codex 式：拆出 <think> 思考块，正文走 Markdown；空气泡不渲染（流式占位例外：光标先行）
        const streaming = Boolean((m.meta as { streaming?: boolean } | undefined)?.streaming);
        const { think, body } = splitThink(m.content);
        if (!think && !body && !streaming) return null;
        return (
          <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {think ? <ThinkBlock text={think} /> : null}
            {body ? <MarkdownLite text={body} /> : null}
            {streaming ? (
              <span style={{ color: "#4f46e5", fontSize: 12, opacity: 0.7 }}>{"● ● ●"}</span>
            ) : null}
          </div>
        );
      }
      case "status": {
        const diffMeta = m.meta as { diff?: { oldText?: string; newText?: string } } | undefined;
        return (
          <div key={m.id} style={{ fontSize: 12, color: "#8a8f98", whiteSpace: "pre-wrap" }}>
            {m.content}
            {diffMeta?.diff?.oldText !== undefined ? (
              <DiffBlock oldText={diffMeta.diff.oldText ?? ""} newText={diffMeta.diff.newText ?? ""} />
            ) : null}
          </div>
        );
      }
      case "code-card":
        // 代码产物统一在画布“小逻结果”独立面板展示，对话流不再重复
        return null;
      case "media-card": {
        const result = m.result;
        return (
          <div
            key={m.id}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>生成完成</div>
            {result?.assetUrl ? (
              <a
                href={result.assetUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#4f46e5", wordBreak: "break-all" }}
              >
                查看结果资产
              </a>
            ) : null}
            {result?.outputSummary ? (
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "#374151" }}>
                {result.outputSummary}
              </div>
            ) : null}
            {result?.status === "failed" ? (
              <div style={{ marginTop: 6, color: "#dc2626" }}>{result.error ?? "生成失败"}</div>
            ) : null}
            <div style={{ marginTop: 6, fontSize: 12, color: "#8a8f98" }}>
              结果已作为结果卡片落到画布上。
            </div>
          </div>
        );
      }
      case "preview-card":
        // 图1式：左侧代码文件列表 + 右侧行号代码区（产物从消息流反查，旧消息也生效）
        return (
          <PreviewFileCard
            key={m.id}
            msg={m}
            artifact={lookupCodeArtifact(brain.messages, brain.messages.findIndex((x) => x.id === m.id))}
            onOpenResult={onOpenResult}
          />
        );
      case "plan-card":
        return <PlanCard key={m.id} m={m} />;
      case "delivery-card":
        return <DeliveryCard key={m.id} m={m} />;
      case "ask-card":
        return (
          <div
            key={m.id}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.ask?.question ?? m.content}</div>
            {m.ask?.options?.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {m.ask.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    disabled={busy}
                    onClick={() => brain.answerAsk({ selected: opt })}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      border: "1px solid #c7d2fe",
                      background: "#fff",
                      cursor: busy ? "default" : "pointer",
                      fontSize: 13,
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                placeholder="或直接输入回答…"
                disabled={busy}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontSize: 13,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && askDraft.trim() && !busy) {
                    const text = askDraft.trim();
                    setAskDraft("");
                    brain.answerAsk({ text });
                  }
                }}
              />
              {!m.ask?.blocking ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => brain.answerAsk({ skipped: true })}
                  style={{ fontSize: 12, color: "#6b7280", background: "none", border: "none", cursor: "pointer" }}
                >
                  跳过
                </button>
              ) : null}
            </div>
          </div>
        );
      default:
        return (
          <div key={m.id} style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
            {m.content}
          </div>
        );
    }
  };

  // 消息从上往下排；新消息到来时自动滚到最底
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [brain.messages.length, busy]);

  const task = brain.currentTask;

  // 小逻的记忆：入口挪到结果面板标题栏（brain-result-dock），面板不再渲染记忆 UI

  // 程序库：小逻写的程序自动落盘（.data/brain-programs/），这里可查/重开/改名/删
  const programStore = useMemo(() => new HttpProgramStore(), []);
  const [programsOpen, setProgramsOpen] = useState(false);

  // ---- 技能市场：skills/ 技能流通（服务端通道；桌面模式暂不支持） ----
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketListings, setMarketListings] = useState<
    { name: string; description: string; publisherId: string; publisherName: string; publishedAt: string; localCopy: boolean }[]
  >([]);
  const [marketBusy, setMarketBusy] = useState(false);
  const [marketError, setMarketError] = useState("");
  async function refreshSkillMarket() {
    if (desktopRuntime()) {
      setMarketError("技能市场目前仅支持网页端，桌面端稍后接入。");
      setMarketListings([]);
      return;
    }
    setMarketBusy(true);
    setMarketError("");
    try {
      const resp = await fetch("/api/v2/brain/skill-market");
      const data = (await resp.json().catch(() => ({}))) as { listings?: typeof marketListings; error?: string };
      if (!resp.ok) throw new Error(data.error ?? "读取技能市场失败 (" + resp.status + ")");
      setMarketListings(data.listings ?? []);
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : "读取技能市场失败");
    } finally {
      setMarketBusy(false);
    }
  }
  async function marketAction(action: "publish" | "unpublish" | "install", name: string, publisherId?: string) {
    setMarketBusy(true);
    setMarketError("");
    try {
      const resp = await fetch("/api/v2/brain/skill-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, name, publisherId }),
      });
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      if (!resp.ok) throw new Error(data.error ?? "操作失败 (" + resp.status + ")");
      await Promise.all([refreshSkillMarket(), refreshSkillsAfterMarket()]);
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setMarketBusy(false);
    }
  }
  /** 安装/发布后重扫技能目录，让能力清单立刻同步 */
  async function refreshSkillsAfterMarket() {
    try {
      const res = await brainFs("list", "skills");
      const dirs = (res.entries ?? []).filter((e: any) => e.isDir).slice(0, 50);
      const items: { name: string; description: string }[] = [];
      for (const d of dirs) {
        const n = String(d.path).split("/").pop() ?? "";
        if (!n) continue;
        try {
          const r = await brainFs("read", "skills/" + n + "/SKILL.md");
          const m = /description:\s*(.+)/.exec(String(r.content ?? ""));
          items.push({ name: n, description: m ? m[1].trim() : "" });
        } catch { /* 坏条目跳过 */ }
      }
      setSkillCatalog(items);
    } catch { /* 重扫失败不影响主流程 */ }
  }
  const [programs, setPrograms] = useState<ProgramMeta[]>([]);
  const [progNonce, setProgNonce] = useState(0);
  useEffect(() => {
    if (!programsOpen) return;
    let live = true;
    programStore.list().then((list) => {
      if (live) setPrograms(list);
    });
    return () => {
      live = false;
    };
  }, [programsOpen, progNonce, programStore]);

  /** 重开程序：读回文件 → 组装预览 → 上报结果面板 */
  const openProgram = (id: string) => {
    programStore.get(id).then((rec) => {
      if (!rec) return;
      const artifact: CodeArtifact = { files: rec.contents, entryFile: rec.entry };
      const preview = isPreviewable(artifact) ? buildPreviewDocument(artifact) : null;
      onBrainResult?.({ artifact, preview });
    });
  };
  /** 上画布（画布⇄代码）：读程序产物 → 交宿主变成画布节点 */
  const pinProgram = (p: ProgramMeta) => {
    programStore.get(p.id).then((rec) => {
      if (!rec) return;
      onPinProgram?.({ name: p.name, entry: rec.entry, artifact: { files: rec.contents, entryFile: rec.entry } });
    });
  };
  const renameProgram = (p: ProgramMeta) => {
    const next = window.prompt("程序新名字", p.name);
    if (!next || !next.trim() || next.trim() === p.name) return;
    programStore.rename(p.id, next.trim()).then(() => setProgNonce((v) => v + 1));
  };
  // 服务台：小逻起的长驻服务在这里可见/可开/可停（管理权在老板）
  const [servicesOpen, setServicesOpen] = useState(false);
  const [services, setServices] = useState<ServiceRunInfo[]>([]);
  const [svcNonce, setSvcNonce] = useState(0);
  const [svcBusy, setSvcBusy] = useState(false);
  const refreshServices = async () => {
    if (!adapters.service) return;
    setSvcBusy(true);
    try {
      setServices(await adapters.service.status());
    } catch {
      /* 查询失败不打断：列表保持旧值 */
    } finally {
      setSvcBusy(false);
    }
  };
  useEffect(() => {
    if (!servicesOpen) return;
    void refreshServices();
    const t = window.setInterval(() => void refreshServices(), 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servicesOpen, svcNonce]);

  // 技能库扫描：打开面板扫一次；每轮结束（busy 落回 false）重扫，save_skill 落盘的技能下轮可见
  useEffect(() => {
    if (busy) return;
    let live = true;
    const scan = async () => {
      try {
        const res = await brainFs("list", "skills");
        const dirs = (res.entries ?? []).filter((e: any) => e.isDir).slice(0, 50);
        const items: { name: string; description: string }[] = [];
        for (const d of dirs) {
          const n = String(d.path).split("/").pop() ?? "";
          if (!n) continue;
          try {
            const r = await brainFs("read", "skills/" + n + "/SKILL.md");
            const m = /description:\s*(.+)/.exec(String(r.content ?? ""));
            items.push({ name: n, description: m ? m[1].trim() : "" });
          } catch { /* 坏条目跳过 */ }
        }
        // 插件技能（学 kimi-code 插件包）：扫 plugins/<插件>/skills/ 一并进目录
        try {
          const pRes = await brainFs("list", "plugins");
          const pluginDirs = (pRes.entries ?? []).filter((e: any) => e.isDir).slice(0, 5);
          for (const pd of pluginDirs) {
            const pn = String(pd.path).split("/").pop() ?? "";
            if (!pn) continue;
            try {
              const sRes = await brainFs("list", "plugins/" + pn + "/skills");
              for (const sd of (sRes.entries ?? []).filter((e: any) => e.isDir).slice(0, 20)) {
                const sn = String(sd.path).split("/").pop() ?? "";
                if (!sn) continue;
                try {
                  const r = await brainFs("read", "plugins/" + pn + "/skills/" + sn + "/SKILL.md");
                  const m = /description:\s*(.+)/.exec(String(r.content ?? ""));
                  items.push({ name: sn, description: (m ? m[1].trim() : "") + "（插件 " + pn + "）" });
                } catch { /* 坏条目跳过 */ }
              }
            } catch { /* 插件无 skills 目录跳过 */ }
          }
        } catch { /* plugins 目录不存在跳过 */ }
        if (live) setSkillCatalog(items);
      } catch { /* skills 目录不存在按空库处理 */ }
    };
    void scan();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const stopService = async (id: string) => {
    if (!adapters.service) return;
    try {
      await adapters.service.stop(id);
    } catch (e) {
      window.alert("停止失败：" + (e instanceof Error ? e.message : String(e)));
    }
    setSvcNonce((v) => v + 1);
  };

  const removeProgram = (p: ProgramMeta) => {
    if (!window.confirm("删除程序「" + p.name + "」？删除后无法恢复。")) return;
    programStore.remove(p.id).then(() => setProgNonce((v) => v + 1));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {task ? (
        <div
          style={{
            borderBottom: "1px solid #eef0f3",
            padding: "8px 4px",
            fontSize: 12,
            color: "#6b7280",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                padding: "1px 8px",
                borderRadius: 999,
                background: "#eef2ff",
                color: "#4f46e5",
              }}
            >
              {task.status === "active" ? "进行中" : task.status}
            </span>
            <button
              type="button"
              onClick={() => setServicesOpen((v) => !v)}
              title="服务台：小逻起的长驻服务"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 8px",
                borderRadius: 999,
                border: "1px solid #eef0f3",
                background: "#fff",
                cursor: "pointer",
                color: servicesOpen ? "#4f46e5" : "#6b7280",
              }}
            >
              <Server size={11} />
              服务
            </button>
            <button
              type="button"
              onClick={() => setProgramsOpen((v) => !v)}
              title="程序库：小逻写的程序都收在这里"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 8px",
                borderRadius: 999,
                border: "1px solid #eef0f3",
                background: "#fff",
                cursor: "pointer",
                color: programsOpen ? "#4f46e5" : "#6b7280",
              }}
            >
              <FolderOpen size={11} />
              程序库
            </button>

            <button
              type="button"
              onClick={() => {
                setMarketOpen((v) => {
                  const next = !v;
                  if (next) void refreshSkillMarket();
                  return next;
                });
              }}
              title="我的技能 · 市场发布"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 8px",
                borderRadius: 999,
                border: "1px solid #eef0f3",
                background: "#fff",
                cursor: "pointer",
                color: marketOpen ? "#4f46e5" : "#6b7280",
              }}
            >
              <Store size={11} />
              技能市场
            </button>
          </div>
        </div>
      ) : null}
      {servicesOpen ? (
        <div
          style={{
            borderBottom: "1px solid #eef0f3",
            padding: "8px 4px",
            fontSize: 12,
            color: "#6b7280",
            flexShrink: 0,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Server size={13} style={{ color: "#4f46e5", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "#374151", flex: 1 }}>服务台（{services.length}）</span>
            <button
              type="button"
              onClick={() => void refreshServices()}
              disabled={svcBusy}
              title="刷新"
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", display: "inline-flex", alignItems: "center" }}
            >
              <RefreshCw size={12} className={svcBusy ? "spin" : undefined} />
            </button>
            <button
              type="button"
              onClick={() => setServicesOpen(false)}
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12 }}
            >
              收起
            </button>
          </div>
          {!adapters.service ? (
            <div style={{ color: "#9ca3af" }}>当前环境未接入服务通道。</div>
          ) : services.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>
              暂无运行中的服务——让小逻部署并启动程序后，服务会出现在这里。
              {mcpServers.length > 0 && (
                <div style={{ marginTop: 6, borderTop: "1px dashed #e5e7eb", paddingTop: 6 }}>
                  MCP：
                  {mcpServers.map((s) => (
                    <span key={s.name} style={{ marginRight: 10 }}>
                      <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 3, background: s.ok ? "#16a34a" : "#dc2626", marginRight: 4 }} />
                      {s.name}{s.ok ? "（" + s.toolCount + " 工具）" : "（连接失败）"}
                      {s.error ? <span style={{ color: "#dc2626" }}> {s.error.slice(0, 60)}</span> : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            services.map((sv) => {
              const live = sv.status === "running";
              return (
                <div key={sv.id} style={{ borderTop: "1px solid #f3f4f6", padding: "6px 0", display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 999,
                        flexShrink: 0,
                        background: live ? "#16a34a" : "#9ca3af",
                      }}
                    />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#374151", flex: 1 }}>{sv.command}</span>
                    <span style={{ color: "#9ca3af", flexShrink: 0 }}>{live ? "运行中" : sv.status}</span>
                    {sv.url ? (
                      <a
                        href={sv.url}
                        target="_blank"
                        rel="noreferrer"
                        title={sv.url}
                        style={{ color: "#4f46e5", display: "inline-flex", alignItems: "center", flexShrink: 0 }}
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      title="停止服务"
                      onClick={() => void stopService(sv.id)}
                      style={{ border: "none", background: "none", cursor: "pointer", color: "#dc2626", fontSize: 12, flexShrink: 0 }}
                    >
                      停止
                    </button>
                  </div>
                  <div style={{ color: "#9ca3af", fontSize: 11 }}>
                    {sv.port ? "端口 " + sv.port + " · " : ""}pid {sv.pid}
                  </div>
                  {sv.logTail ? (
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        color: "#6b7280",
                        background: "#f9fafb",
                        borderRadius: 6,
                        padding: "4px 8px",
                        maxHeight: 64,
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {sv.logTail}
                    </pre>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
      {programsOpen ? (
        <div
          style={{
            borderBottom: "1px solid #eef0f3",
            padding: "8px 4px",
            fontSize: 12,
            color: "#6b7280",
            flexShrink: 0,
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <FolderOpen size={13} style={{ color: "#4f46e5", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "#374151", flex: 1 }}>程序库（{programs.length}）</span>
            <button
              type="button"
              onClick={() => setProgramsOpen(false)}
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12 }}
            >
              收起
            </button>
          </div>
          {programs.length === 0 ? (
            <div style={{ color: "#9ca3af" }}>还没有程序——让小逻写个程序（游戏也行），成功后自动收进这里。</div>
          ) : (
            programs.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  title="打开预览"
                  onClick={() => openProgram(p.id)}
                  style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, border: "none", background: "none", cursor: "pointer", color: "#374151", fontSize: 12, textAlign: "left", overflow: "hidden", padding: 0 }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  <span style={{ color: "#9ca3af", flexShrink: 0 }}>{p.files.length} 文件 · v{p.version}</span>
                </button>
                <button
                  type="button"
                  title="把程序变成画布节点"
                  onClick={() => pinProgram(p)}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12, flexShrink: 0 }}
                >
                  上画布
                </button>
                <button
                  type="button"
                  title="重命名"
                  onClick={() => renameProgram(p)}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12, flexShrink: 0 }}
                >
                  改名
                </button>
                <button
                  type="button"
                  title="删除程序"
                  onClick={() => removeProgram(p)}
                  style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12, flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {marketOpen ? (
        <div
          style={{
            borderBottom: "1px solid #eef0f3",
            padding: "8px 4px",
            fontSize: 12,
            color: "#6b7280",
            flexShrink: 0,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Store size={13} style={{ color: "#4f46e5", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, color: "#374151", flex: 1 }}>我的技能 · 市场发布</span>
            <button
              type="button"
              onClick={() => void refreshSkillMarket()}
              disabled={marketBusy}
              title="刷新"
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", display: "inline-flex", alignItems: "center" }}
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              onClick={() => setMarketOpen(false)}
              style={{ border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 12 }}
            >
              收起
            </button>
          </div>
          {marketError ? <div style={{ color: "#dc2626", marginBottom: 4 }}>{marketError}</div> : null}
          {desktopRuntime() ? (
            <div style={{ color: "#9ca3af" }}>桌面端暂不支持技能市场，请在网页端发布/安装。</div>
          ) : (
            <>
              <div style={{ color: "#9ca3af", marginBottom: 6 }}>
                浏览与安装别人的技能，请前往 能力中心 → Skill → 技能市场 页签。
              </div>
              <div style={{ marginTop: 8, borderTop: "1px dashed #e5e7eb", paddingTop: 6 }}>
                <div style={{ fontWeight: 600, color: "#374151", marginBottom: 2 }}>我的技能（发布到市场）</div>
                {skillCatalog.length === 0 ? (
                  <div style={{ color: "#9ca3af" }}>还没有技能——让小逻做完事后说"记住这套做法"，就会沉淀成技能。</div>
                ) : (
                  skillCatalog.map((sk) => (
                    <div key={"pub-" + sk.name} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <span style={{ color: "#374151" }}>{sk.name}</span>
                        <span style={{ color: "#9ca3af", marginLeft: 6 }}>{sk.description}</span>
                      </div>
                      {marketListings.some((item) => item.name === sk.name && item.localCopy) ? (
                        <button
                          type="button"
                          disabled={marketBusy}
                          onClick={() => void marketAction("unpublish", sk.name)}
                          style={{ border: "1px solid #eef0f3", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#9ca3af", fontSize: 11, padding: "1px 8px", flexShrink: 0 }}
                        >
                          下架
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={marketBusy}
                          onClick={() => void marketAction("publish", sk.name)}
                          style={{ border: "1px solid #eef0f3", borderRadius: 6, background: "#fff", cursor: "pointer", color: "#4f46e5", fontSize: 11, padding: "1px 8px", flexShrink: 0 }}
                        >
                          发布
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      <div ref={listRef}
 style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 4px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {brain.messages.length === 0 ? (
          <div style={{ color: "#8a8f98", fontSize: 13, lineHeight: 1.8 }}>
            智能创作已就位：可以直接让它写代码、出网页预览、生成文件；
            拿不准的地方它会先反问确认。大模型在底部选项条切换。
          </div>
        ) : (
          renderItems()
        )}
        {busy ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#8a8f98" }}>
            <LoaderCircle size={13} className="spin" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {stepNote || "小逻正在思考 / 执行…"}
            </span>
          </div>
        ) : null}
        </div>
      </div>
      {busy ? (
        <div
          style={{
            borderTop: "1px solid #eef0f3",
            padding: "6px 4px",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={brain.stop}
            style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}
          >
            停止
          </button>
        </div>
      ) : null}
    </div>
  );
}