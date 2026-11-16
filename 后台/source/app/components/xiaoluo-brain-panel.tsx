/**
 * Xiaoluo Brain panel - the chat-driven "xiaoluo brain" composer mode inside
 * the intent console: writes code, renders previews, asks back before acting.
 * Runtime lives in app/xiaoluo-brain (ChatAgent); LLM calls are proxied by
 * /api/v2/brain/chat so API keys never reach the browser.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type MutableRefObject,
  type ReactNode,
  useRef,
} from "react";
import { copyTextToClipboard } from "../xiaoluo-brain/components/chat/clipboard";
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
  Search,
  Plug,
  SearchCode,
  Settings2,
  Square,
  TerminalSquare,

  Wrench,
  Copy,
  Check,
  Quote,
} from "lucide-react";
import type { ModelConnection, ModelInputConstraints } from "../types";
import { modelSupportsVision } from "../lib/model-vision";
import { isChatEndpointKind } from "../lib/model-endpoints";
import { MarkdownLite } from "../xiaoluo-brain/components/chat/markdown-lite";
import { useChatAgent } from "../xiaoluo-brain/hooks/use-chat-agent";
import type {
  ChatAdapters,
  ChatUIMessage,
  ChatUserMediaRef,
} from "../xiaoluo-brain/hooks/use-chat-agent";
import { HttpChatStore } from "../xiaoluo-brain/lib/brain/api";
import { auditApproval, markApproved, riskSummary, wasApproved } from "../xiaoluo-brain/lib/brain/approval-grants";
import {
  mapCompletionResponse,
  modelErrorFromStatus,
  parseModelSSE,
  replyFromStreamAccum,
  salvageStreamInterruption,
  toWireMessages,
  type StreamAccum,
  type WireCompletion,
} from "../xiaoluo-brain/lib/brain/llm-wire";
import { buildPreviewDocument, isPreviewable, PREVIEW_SANDBOX } from "../xiaoluo-brain/lib/brain/preview";
import type { CodeArtifact, ServiceRunInfo, SetupServicePayload, SetupServiceResult, StdinSessionResult } from "../xiaoluo-brain/lib/brain/types";
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
/** 对话可用的模型连接：只认 OpenAI 兼容 chat/completions 与 Anthropic messages，图片/视频生成端点不混进来 */
function isChatModelConnection(model: ModelConnection): boolean {
  return isChatEndpointKind(model.baseUrl ?? "");
}
/** 内嵌浏览器面板矩形（取最大可见 iframe，窗口内容坐标）；无则整窗 */
function browserPanelRect(): { x: number; y: number; width: number; height: number } | undefined {
  const frames = Array.from(document.querySelectorAll('iframe'));
  let best: { x: number; y: number; width: number; height: number } | undefined;
  let bestArea = 0;
  for (const f of frames) {
    const r = f.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
  }
  return best;
}

/** iframe 内坐标 → 窗口坐标的偏移量（按 src 片段匹配） */
function iframeOffset(urlMatch: string): { x: number; y: number } | null {
  const frames = Array.from(document.querySelectorAll('iframe'));
  for (const f of frames) {
    if ((f.src || '').includes(urlMatch)) {
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y };
    }
  }
  return null;
}

let desktopGateApprovedThisSession = false;

/** 整桌控制双闸：设置开关（持久）+ 每会话一次 confirm（会话级） */
async function ensureDesktopGate(): Promise<void> {
  const dsk = desktopRuntime();
  if (!dsk?.desktopAction) throw new Error('桌面通道不可用');
  const gate = await dsk.desktopAction({ action: 'gate' });
  if (!gate.enabled) throw new Error('整桌控制未开启：请在客户端设置里打开「允许小逻控制本机」开关后重试');
  if (!desktopGateApprovedThisSession) {
    const ok = window.confirm('小逻请求本会话内控制本机（截屏/鼠标/键盘）。允许吗？');
    if (!ok) throw new Error('老板拒绝了整桌控制授权');
    desktopGateApprovedThisSession = true;
  }
}

interface XiaoLuoDesktopBridge {
  fsAction: (payload: { action: string; path: string; query?: string; content?: string; opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" }; mode?: string }) => Promise<XiaoLuoDesktopFsResult>;
  runCommand: (payload: { command: string; cwd?: string; timeoutMs?: number; approved?: boolean }) => Promise<XiaoLuoDesktopCommandResult>;
  cancelCommands?: () => Promise<{ ok?: boolean }>;
  manageService: (payload: { action: "start" | "stop" | "status" | "setup" | "setups"; command?: string; ttlMs?: number; cwd?: string; id?: string; approved?: boolean; kind?: string; name?: string; port?: number; path?: string; database?: string }) => Promise<XiaoLuoDesktopServiceResult>;
  deployProgram: (payload: { name?: string; files: { path: string; content: string }[]; entryFile?: string }) => Promise<{ dir?: string; fileCount?: number; error?: string }>;
  mcpAction: (payload: { action: string; server?: string; tool?: string; arguments?: Record<string, unknown>; uri?: string }) => Promise<{ servers?: { name: string; ok?: boolean; error?: string; tools?: { rawName: string; description: string; inputSchema?: Record<string, unknown> }[] }[]; resources?: { server?: string; uri?: string; name?: string; description?: string; mimeType?: string }[]; ok?: boolean; text?: string; error?: string; uri?: string }>;
  fetchLocal: (payload: { url: string }) => Promise<{ ok?: boolean; status?: number; contentType?: string; text?: string; error?: string }>;
  openExternal?: (payload: { url: string }) => Promise<{ ok?: boolean }>;
  browserAction?: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string; dataUrl?: string; width?: number; height?: number; result?: string }>;
  desktopAction?: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string; code?: string; enabled?: boolean; dataUrl?: string; width?: number; height?: number }>;
  webDriveAction?: (payload: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string; dataUrl?: string; width?: number; height?: number; result?: string; url?: string; title?: string; connected?: boolean }>; // WEB-DRIVE-TS
  uiaAction?: (payload: Record<string, unknown>) => Promise<unknown>; // UIA-PANEL
  sshAction?: (payload: Record<string, unknown>) => Promise<unknown>; // SSH-PANEL
  writeClipboard?: (payload: { text: string }) => Promise<{ ok?: boolean }>;
}
declare global {
  interface Window {
    xiaoluoDesktop?: XiaoLuoDesktopBridge;
  }
}
function desktopRuntime(): XiaoLuoDesktopBridge | null {
  return typeof window !== "undefined" && window.xiaoluoDesktop ? window.xiaoluoDesktop : null;
}

/**
 * 服务端命令口的一次往返（含审批门）：403 approval_required → 老板确认 → 会话内记名放行 → 重发。
 * run_command / 交互会话开席 / 会话续写三条路共用，审批语义只有一份，免得哪天只改了其中一条。
 */
async function postBrainCommand(
  body: Record<string, unknown>,
  opts: { scope: string; subject: string; action: string }
): Promise<Record<string, unknown>> {
  const send = async (approved: boolean) => {
    const resp = await fetch("/api/v2/brain/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, approved }),
    });
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return { resp, data };
  };
  let { resp, data } = await send(false);
  if (resp.status === 403 && data.code === "approval_required") {
    const reasons = (data.reasons as string[] | undefined) ?? [];
    // 会话级记住选择：同内容本会话批准过（30 分钟内）直接放行，不再弹窗
    if (wasApproved(opts.scope, opts.subject)) {
      ({ resp, data } = await send(true));
    } else {
      const reasonLines = reasons.map((r) => "· " + r).join("\n");
      const ok = window.confirm(
        "小逻想" + opts.action + "，需要你批准：\n\n" +
          opts.subject +
          riskSummary(reasons) +
          (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
          "\n\n确定执行吗？（批准后本会话内相同内容不再询问）",
      );
      auditApproval(opts.scope, opts.subject, ok, reasons);
      if (!ok) {
        throw new Error("老板未批准「" + opts.subject + "」，已取消执行。请改用更保守的做法或先向老板说明理由。");
      }
      markApproved(opts.scope, opts.subject);
      ({ resp, data } = await send(true));
    }
  }
  if (!resp.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "命令执行失败 (" + resp.status + ")");
  }
  return data;
}

/** 会话回程报文 → 端口结构（状态只有 running/exited 两态，其余一律按 running 处理） */
function toStdinSession(data: Record<string, unknown>): StdinSessionResult {
  return {
    sessionId: String(data.sessionId ?? ""),
    pid: typeof data.pid === "number" ? data.pid : undefined,
    output: typeof data.output === "string" ? data.output : "",
    droppedChars: typeof data.droppedChars === "number" ? data.droppedChars : undefined,
    status: data.status === "exited" ? "exited" : "running",
    exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
  };
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
import type { ChatMessage } from "../xiaoluo-brain/lib/brain/types";

/** 宿主（对话器底部输入条）驱动面板的句柄 */
export interface BrainPanelHandle {
  /** 发送正文；attachments 由面板物化进工作区 uploads/ 后随正文注入【附件】段 */
  send: (text: string, attachments?: ChatAttachmentRef[]) => void;
  /** 停止当前回合（中止 Agent + 杀在途命令 + 释放反问挂起） */
  stop: () => void;
  /** QUEUE-TURN：移除指定排队中的待发送任务 */
  removeQueued?: (id: number) => void;
  /** STEER-GUIDE：执行中插话引导——不等当前任务结束，下一个工具步前立即注入 */
  steer?: (text: string) => void;
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
  /** 忙态上报：宿主输入条按钮切"停止"态用 */
  onBusyChange?: (busy: boolean) => void;
  /** QUEUE-TURN：待发送任务队列上报（宿主输入条显示「等待发送 N」） */
  onQueueChange?: (items: Array<{ id: number; text: string }>) => void;
  /** 技能目录（工作区技能+插件技能）上报宿主，供输入条 / 斜杠补全与显式引用 */
  onSkillCatalogChange?: (items: Array<{ name: string; description: string }>) => void;
  /** 工作区 id：注册表包技能物化拉取用（注册表 API 无 workspaceId 拒请求） */
  workspaceId?: string;
  /** 权限模式：default=仅工作区 / auto=越界只读自动放行 / full=本机任意读写 */
  permissionMode?: "default" | "auto" | "full";
  /** 最新代码产物/预览上报口（画布独立结果面板） */
  onBrainResult?: (snapshot: BrainResultSnapshot) => void;
  /** 程序库一键上画布（画布⇄代码）：宿主把程序产物变成画布节点 */
  onPinProgram?: (p: { name: string; entry: string; artifact: NonNullable<BrainResultSnapshot["artifact"]> }) => void;
  /** 时间线事件跳转：打开“小逻结果”面板并定位到指定 Tab */
  onOpenResult?: () => void;
  /** 宿主注入的外部消息（快速问答/专业生成 intent 流），按时间戳与大脑回合严格混排 */
  externalItems?: { id: string; createdAt: number; node: ReactNode }[];
  /** 统一对话流尾部指示区（如快速问答进行中） */
  externalFooter?: ReactNode;
  /** 统一对话流能力同步：素材放大（宿主全屏查看器） */
  onZoomMedia?: (url: string, label?: string) => void;
  /** 统一对话流能力同步：引用消息到宿主输入条 */
  onQuoteText?: (content: string, id: string, role: "user" | "assistant") => void;
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
  llm_retry: LoaderCircle,
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
  llm_retry: "重试",
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
  onOpenResult?: () => void;
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
              onClick={() => onOpenResult?.()}
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
            onClick={() => onOpenResult()}
            style={{ padding: "2px 10px", borderRadius: 999, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4f46e5", fontSize: 12, cursor: "pointer" }}
          >
            代码与预览
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
  onOpenResult?: () => void;
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
        {/* TIMELINE-CLEAN-EMPTY：明细区为空（无文件/输出/按钮）时不渲染，去掉空灰框 */}
        {open && (meta.testReport || meta.spillPath || meta.files?.length || meta.output || meta.detail || ((tool === "write_code" || tool === "preview_code") && onOpenResult)) ? (
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
                onClick={() => onOpenResult()}
                style={{ marginTop: 6, padding: "2px 10px", borderRadius: 999, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4f46e5", fontSize: 12, cursor: "pointer" }}
              >
                查看代码
              </button>
            ) : null}
            {tool === "preview_code" && onOpenResult ? (
              <button
                type="button"
                onClick={() => onOpenResult()}
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
  externalItems,
  externalFooter,
  onZoomMedia,
  onQuoteText,
  onBusyChange,
  onQueueChange,
  onSkillCatalogChange,
  workspaceId = "",
  permissionMode = "default",
}: XiaoluoBrainPanelProps) {
  const [askDraft, setAskDraft] = useState("");
  // 统一对话流能力同步：大脑消息也提供 复制/引用（与 intent 消息一致的反馈态）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [quotedBrainId, setQuotedBrainId] = useState<string | null>(null);
  const copyBrainText = (content: string, id: string) => {
    void copyTextToClipboard(content).then((ok) => {
      if (!ok) return;
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((v) => (v === id ? null : v)), 1500);
    });
  };
  const brainActions = (
    id: string,
    content: string,
    role: "user" | "assistant",
    align: "left" | "right",
  ) => (
    <div
      className="brain-msg-actions"
      style={{ display: "flex", gap: 4, justifyContent: align === "right" ? "flex-end" : "flex-start" }}
    >
      <button
        type="button"
        className="message-copy-btn"
        title="复制内容"
        onClick={() => copyBrainText(content, id)}
      >
        {copiedId === id ? (
          <>
            <Check size={12} />
            <span>已复制</span>
          </>
        ) : (
          <>
            <Copy size={12} />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  );

  const brainModels = useMemo(
    () =>
      models
        .filter((m) => m.enabled !== false && m.modalities.includes("text") && isChatModelConnection(m))
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
      "\n[技能库：先 load_skill 读正文再照做；值得复用的做法用 save_skill 沉淀；共享技能需先 install_skill 安装为私有才能用]\n" +
      skillCatalog.map((s) => "- " + s.name + " | skill | " + s.description).join("\n")
    );
  }, [brainModels, skillCatalog]);

  /** 文件系统口的统一入口：桌面模式走主进程本地工作区（与 deploy/command 同一工作区）；
   *  否则走服务端 /api/v2/brain/fs（每用户隔离工作区，路径防穿越） */
  async function brainFs(
    action: "list" | "read" | "write" | "grep" | "find" | "fuzzy",
    relPath: string,
    content?: string,
    opts?: { offset?: number; limit?: number; maxResults?: number; encoding?: "base64" },
    query?: string,
  ): Promise<XiaoLuoDesktopFsResult> {
    const desktop = desktopRuntime();
    if (desktop) {
      const res = await desktop.fsAction({ action, path: relPath, query, content, opts, mode: permissionMode });
      if (res.error) throw new Error(res.error);
      return res;
    }
    const resp = await fetch("/api/v2/brain/fs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, path: relPath, query, content, opts, mode: permissionMode }),
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
      // 分层超时（学 Codex stream_idle_timeout）：连接阶段 30s；流式阶段按 60s 空闲判挂死。
      // 持续有 chunk 产出的长响应永不误杀；老板停止信号（req.signal）优先。
      const ctl = new AbortController();
      const signal = req.signal ? AbortSignal.any([req.signal, ctl.signal]) : ctl.signal;
      let timeoutTimer: ReturnType<typeof setTimeout> = setTimeout(
        () => ctl.abort(new DOMException("连接超时（30 秒未建立）", "TimeoutError")),
        30_000,
      );
      const armIdleTimer = () => {
        clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(
          () => ctl.abort(new DOMException("流式响应空闲超时（60 秒无新数据）", "TimeoutError")),
          60_000,
        );
      };
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
        clearTimeout(timeoutTimer);
        if (req.signal?.aborted) throw e; // 老板点了停止：上抛让 Agent 按中止收尾
        throw new BrainLLMError("模型调用超时或连接断开", { retryable: true });
      }
      // 连接已建立：切到空闲计时（每个 chunk / 每次读操作都会重置）
      armIdleTimer();
      const throwUpstreamError = (status: number, raw: unknown) => {
        throw modelErrorFromStatus(status, raw);
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
        // chunk 级空闲重置：任何数据到达都续命 60s（tool_calls 碎片也算，不只 content）
        const idleBody = resp.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              armIdleTimer();
              c.enqueue(chunk);
            },
          }),
        );
        let acc: StreamAccum | undefined;
        try {
          acc = await parseModelSSE(idleBody, isAnthropic ? "anthropic" : "openai", req.onDelta);
        } catch (e) {
          clearTimeout(timeoutTimer);
          // 用户停止：原样上抛
          if (req.signal?.aborted) throw e;
          // 断流抢救与收口映射都在 llm-wire：服务端宿主流式时走的是同一套口径
          return salvageStreamInterruption(acc);
        }
        clearTimeout(timeoutTimer);
        return replyFromStreamAccum(acc);
      }
      armIdleTimer();
      const data = (await resp.json()) as WireCompletion;
      // 上游 200 但正文带 error（协议转换/网关透传场景）：同样按错误抛出，避免吞错
      if (data.error) {
        throwUpstreamError(resp.status, data.error);
      }
      clearTimeout(timeoutTimer);
      return mapCompletionResponse(data);
    };
    const desktop = desktopRuntime(); // VISION-OPS：视觉/整桌口共用桌面桥句柄
    return {
      callLLM,
      generateMedia: onGenerateMedia,
      /** 网页抓取：走服务端 /api/v2/brain/browse（SSRF 防护在服务端） */
      vision: desktop?.browserAction
        ? {
            modelVision: modelSupportsVision({
              modelId: effectiveModel?.id ?? "",
              modalities: (effectiveModel as { modalities?: string[] } | undefined)?.modalities,
              inputConstraints: (effectiveModel as { inputConstraints?: ModelInputConstraints } | undefined)?.inputConstraints,
            }),
            capture: async (region: 'browser' | 'window') => {
              const rect = region === 'browser' ? browserPanelRect() : undefined;
              const res = await desktop.browserAction!({ action: 'screenshot', ...(rect ? { rect } : {}) });
              if (res.error || !res.dataUrl) throw new Error(res.error ?? '截屏失败');
              return { dataUrl: res.dataUrl, width: res.width ?? 0, height: res.height ?? 0 };
            },
            operate: async (req: { op: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; frameUrl?: string }) => {
              let px = req.x ?? 0;
              let py = req.y ?? 0;
              if (req.frameUrl) {
                const off = iframeOffset(req.frameUrl);
                if (!off) throw new Error('未找到 iframe：' + req.frameUrl);
                px += off.x;
                py += off.y;
              }
              const res = await desktop.browserAction!({ action: req.op === 'dblclick' ? 'click' : req.op, x: px, y: py, double: req.op === 'dblclick', text: req.text, key: req.key, dx: req.dx, dy: req.dy });
              if (res.error) throw new Error(res.error);
              return 'UI 操作已执行：' + req.op + '（' + Math.round(px) + ',' + Math.round(py) + '）';
            },
            dom: async (urlMatch?: string) => {
              const res = await desktop.browserAction!({ action: 'dom', urlMatch: urlMatch ?? '' });
              if (res.error) throw new Error(res.error);
              return res.result ?? '';
            },
            navigate: async (url: string) => {
              window.dispatchEvent(new CustomEvent('xiaoluo:navigate-browser', { detail: { url } }));
              return '已向浏览器页签发送导航指令：' + url + '（页签已切到浏览器）';
            },
          }
        : undefined,
      desktop: desktop?.desktopAction
        ? {
            capture: async () => {
              await ensureDesktopGate();
              const res = await desktop.desktopAction!({ action: 'screenshot', approved: true });
              if (res.error || !res.dataUrl) throw new Error(res.error ?? '整桌截屏失败');
              return { dataUrl: res.dataUrl, width: res.width ?? 0, height: res.height ?? 0 };
            },
            operate: async (req: { op: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number }) => {
              await ensureDesktopGate();
              const res = await desktop.desktopAction!({ action: 'operate', approved: true, op: req.op, x: req.x, y: req.y, text: req.text, key: req.key, dx: req.dx, dy: req.dy });
              if (res.error) throw new Error(res.error);
              return '整桌操作已执行：' + req.op;
            },
          }
        : undefined,
      webdriver: desktop?.webDriveAction
        ? {
            navigate: async (url: string) => {
              const res = await desktop.webDriveAction!({ action: 'navigate', url });
              if (res.error) throw new Error(res.error);
              return '外部浏览器已打开：' + (res.url ?? url) + (res.title ? '（' + res.title + '）' : '');
            },
            dom: async (mode?: 'dom' | 'text', max?: number) => {
              const res = await desktop.webDriveAction!({ action: mode === 'text' ? 'text' : 'dom', ...(max ? { max } : {}) });
              if (res.error) throw new Error(res.error);
              return res.result ?? '';
            },
            capture: async () => {
              const res = await desktop.webDriveAction!({ action: 'screenshot' });
              if (res.error || !res.dataUrl) throw new Error(res.error ?? '外部浏览器截图失败');
              return { dataUrl: res.dataUrl, width: res.width ?? 0, height: res.height ?? 0 };
            },
            operate: async (req: { op: string; selector?: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; clear?: boolean }) => {
              const res = await desktop.webDriveAction!({ action: req.op === 'dblclick' ? 'click' : req.op, double: req.op === 'dblclick', selector: req.selector, x: req.x, y: req.y, text: req.text, key: req.key, dx: req.dx, dy: req.dy, clear: req.clear });
              if (res.error) throw new Error(res.error);
              return '外部浏览器操作已执行：' + req.op + (req.selector ? '（' + req.selector + '）' : '');
            },
            eval: async (js: string, awaitPromise?: boolean) => {
              const res = await desktop.webDriveAction!({ action: 'eval', js, awaitPromise });
              if (res.error) throw new Error(res.error);
              return res.result ?? '';
            },
            record: async (req: { op: string; name?: string }) => {
              const map: Record<string, string> = { start: 'record-start', stop: 'record-stop', save: 'skill-save', list: 'skill-list', delete: 'skill-delete' };
              const action = map[req.op] || 'record-stop';
              const res = await desktop.webDriveAction!({ action, ...(req.name ? { name: req.name } : {}) }) as Record<string, unknown>;
              if (res && res.error) throw new Error(String(res.error));
              return JSON.stringify(res); // RECORD-PANEL
            },
            replay: async (req: { name?: string; steps?: unknown[]; stepDelay?: number }) => {
              const res = await desktop.webDriveAction!({ action: 'replay', ...(req.name ? { name: req.name } : {}), ...(req.steps ? { steps: req.steps } : {}), ...(req.stepDelay ? { stepDelay: req.stepDelay } : {}) }) as Record<string, unknown>;
              if (res && res.error) throw new Error(String(res.error));
              return JSON.stringify(res);
            },
          }
        : undefined,
      uia: desktop?.uiaAction
        ? {
            inspect: async (req: { action: string; pid?: number; name?: string; automationId?: string; controlType?: string; depth?: number; max?: number; text?: string }) => {
              const mutate = req.action === 'invoke' || req.action === 'setvalue' || req.action === 'focus';
              if (mutate) await ensureDesktopGate();
              const res = await desktop.uiaAction!({ ...req });
              const err = res && typeof res === 'object' && 'error' in res ? (res as { error?: string }).error : undefined;
              if (err) throw new Error(err);
              return typeof res === 'string' ? res : JSON.stringify(res);
            },
          }
        : undefined,
      ssh: desktop?.sshAction
        ? {
            exec: async (req: { host: string; command?: string; user?: string; port?: number; identityFile?: string; timeoutMs?: number; op?: string }) => {
              await ensureDesktopGate();
              const res = await desktop.sshAction!({ action: req.op === 'test' ? 'test' : 'exec', host: req.host, command: req.command, user: req.user, port: req.port, identityFile: req.identityFile, timeoutMs: req.timeoutMs }) as Record<string, unknown>;
              if (res && res.error) throw new Error(String(res.error));
              return JSON.stringify(res); // SSH-PANEL
            },
          }
        : undefined,
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
        fuzzyFind: async (query: string, opts?: { path?: string; maxResults?: number }) =>
          (await brainFs("fuzzy", opts?.path ?? ".", undefined, { maxResults: opts?.maxResults }, query)).paths ?? [],
      },
      /** 终端：走服务端 /api/v2/brain/command（沙箱受控执行 + 风险分级审批门） */
      command: {
        cancelAll: () => {
          const desk = desktopRuntime();
          if (desk && typeof desk.cancelCommands === "function") desk.cancelCommands().catch(() => {});
          void fetch("/api/v2/brain/command", { method: "DELETE" }).catch(() => {});
        },
        run: async (command: string, opts?: { cwd?: string; timeoutMs?: number }) => {
          const desktop = desktopRuntime();
          if (desktop) {
            let res = await desktop.runCommand({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, approved: false });
            if (res.code === "approval_required") {
              // 会话级记住选择：同命令本会话批准过（30 分钟内）直接放行，不再弹窗
              if (wasApproved("command", command)) {
                res = await desktop.runCommand({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, approved: true });
              } else {
                const reasonLines = (res.reasons ?? []).map((r) => "· " + r).join("\n");
                const ok = window.confirm(
                  "小逻想在本机执行以下命令，需要你批准：\n\n" +
                    command +
                    riskSummary(res.reasons) +
                    (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                    "\n\n确定执行吗？（批准后本会话内相同命令不再询问）",
                );
                auditApproval("command", command, ok, res.reasons);
                if (!ok) {
                  throw new Error("老板未批准命令「" + command + "」，已取消执行。请改用更保守的做法或先向老板说明理由。");
                }
                markApproved("command", command);
                res = await desktop.runCommand({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs, approved: true });
              }
            }
            if (res.error) throw new Error(res.error);
            return { exitCode: res.exitCode ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", spillPath: res.spillPath };
          }
          const data = await postBrainCommand(
            { command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs },
            { scope: "command", subject: command, action: "执行以下命令" },
          );
          return {
            exitCode: (data.exitCode as number | undefined) ?? 1,
            stdout: (data.stdout as string | undefined) ?? "",
            stderr: (data.stderr as string | undefined) ?? "",
            spillPath: data.spillPath as string | undefined,
            networkNote: data.networkNote as string | undefined,
          };
        },
        /**
         * 交互会话（write_stdin）：桌面桥没有对应通道，所以只在服务端形态提供这两个口——
         * 缺 startSession 时 agent 侧根本不注册 write_stdin 工具，不会让小逻学着用一个不存在的口。
         */
        ...(desktopRuntime()
          ? {}
          : {
              startSession: async (command: string, sOpts?: { cwd?: string; ttlMs?: number }) =>
                toStdinSession(
                  await postBrainCommand(
                    { command, interactive: true, cwd: sOpts?.cwd, ttlMs: sOpts?.ttlMs },
                    { scope: "session", subject: command, action: "开一个常驻的交互会话（进程会留在本机直到收尾）" },
                  ),
                ),
              writeSession: async (sessionId: string, input?: string, wOpts?: { waitMs?: number; close?: boolean }) =>
                toStdinSession(
                  await postBrainCommand(
                    { sessionId, input, waitMs: wOpts?.waitMs, close: wOpts?.close },
                    { scope: "session", subject: input ?? "(轮询会话 " + sessionId + ")", action: "往交互会话里输入这一行" },
                  ),
                ),
            }),
      },
      /** 服务管理：走服务端 /api/v2/brain/services（二期服务管理器，启动同样走审批门） */
      service: {
        start: async (command, opts) => {
          const desktop = desktopRuntime();
          if (desktop) {
            let res = await desktop.manageService({ action: "start", command, cwd: opts?.cwd, ttlMs: opts?.ttlMs, approved: false });
            if (res.code === "approval_required") {
              // 会话级记住选择：同命令本会话批准过（30 分钟内）直接放行，不再弹窗
              if (wasApproved("service", command)) {
                res = await desktop.manageService({ action: "start", command, cwd: opts?.cwd, ttlMs: opts?.ttlMs, approved: true });
              } else {
                const reasonLines = (res.reasons ?? []).map((r) => "· " + r).join("\n");
                const ok = window.confirm(
                  "小逻想在本机启动一个长驻服务，需要你批准：\n\n" +
                    command +
                    riskSummary(res.reasons) +
                    (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                    "\n\n确定启动吗？（批准后本会话内相同服务不再询问）",
                );
                auditApproval("service", command, ok, res.reasons);
                if (!ok) {
                  throw new Error("老板未批准启动服务「" + command + "」，已取消。请改用无需启动服务的做法或先向老板说明理由。");
                }
                markApproved("service", command);
                res = await desktop.manageService({ action: "start", command, cwd: opts?.cwd, ttlMs: opts?.ttlMs, approved: true });
              }
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
              body: JSON.stringify({ action: "start", command, ttlMs: opts?.ttlMs, cwd: opts?.cwd, approved }),
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
            // 会话级记住选择：同命令本会话批准过（30 分钟内）直接放行，不再弹窗
            if (wasApproved("service", command)) {
              ({ resp, data } = await send(true));
            } else {
              const reasonLines = (data.reasons ?? []).map((r) => "· " + r).join("\n");
              const ok = window.confirm(
                "小逻想启动一个长驻服务，需要你批准：\n\n" +
                  command +
                  riskSummary(data.reasons) +
                  (reasonLines ? "\n\n涉及：\n" + reasonLines : "") +
                  "\n\n确定启动吗？（批准后本会话内相同服务不再询问）",
              );
              auditApproval("service", command, ok, data.reasons);
              if (!ok) {
                throw new Error("老板未批准启动服务「" + command + "」，已取消。请改用无需启动服务的做法或先向老板说明理由。");
              }
              markApproved("service", command);
              ({ resp, data } = await send(true));
            }
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
        /** setup_service：一键搭建本地服务（宿主审批门，必弹框） */
        setup: async (payload: SetupServicePayload) => { // SVC-SETUP
          const summary = payload.kind + (payload.name ? " (" + payload.name + ")" : "") + (payload.port ? " 端口 " + payload.port : "");
          const askMsg = "小逻要搭建一个本地服务，需要你批准：\n\n" + summary + "\n\n数据目录与端口都独立、都在工作区内；搭好后凭据与连接串会回流。\n\n是否继续？";
          const rejectMsg = "老板未批准搭建服务「" + summary + "」，已取消。请先向老板说明理由，或换别的做法。";
          const desktop = desktopRuntime();
          if (desktop) {
            let res = await desktop.manageService({ action: "setup", ...payload, approved: false });
            if (res.code === "approval_required") {
              // 会话级记住选择：同款搭建本会话批准过（30 分钟内）直接放行，不再弹窗
              if (wasApproved("service-setup", summary)) {
                res = await desktop.manageService({ action: "setup", ...payload, approved: true });
              } else {
                const ok = window.confirm(askMsg);
                auditApproval("service-setup", summary, ok, res.reasons);
                if (!ok) throw new Error(rejectMsg);
                markApproved("service-setup", summary);
                res = await desktop.manageService({ action: "setup", ...payload, approved: true });
              }
            }
            if (res.error && res.code !== "install_required") throw new Error(res.error);
            return res as unknown as SetupServiceResult;
          }
          const send = async (approved: boolean) => {
            const resp = await fetch("/api/v2/brain/services", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "setup", ...payload, approved }),
            });
            const data = (await resp.json().catch(() => ({}))) as SetupServiceResult & { reasons?: string[] };
            return { resp, data };
          };
          let { resp, data } = await send(false);
          if (resp.status === 403 && data.code === "approval_required") {
            // 会话级记住选择：同款搭建本会话批准过（30 分钟内）直接放行，不再弹窗
            if (wasApproved("service-setup", summary)) {
              ({ resp, data } = await send(true));
            } else {
              const ok = window.confirm(askMsg);
              auditApproval("service-setup", summary, ok, data.reasons);
              if (!ok) throw new Error(rejectMsg);
              markApproved("service-setup", summary);
              ({ resp, data } = await send(true));
            }
          }
          if (!resp.ok && !data.error) throw new Error("服务搭建失败 (" + resp.status + ")");
          return data;
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
            // 会话级记住选择：本会话批准过 push（30 分钟内）直接放行，不再弹窗
            if (wasApproved("git_push", "push")) {
              ({ resp, data } = await send(true));
            } else {
              const reasonLines = (data.reasons ?? []).map((r: string) => "· " + r).join("\n");
              const ok = window.confirm(
                "小逻想执行 git push，需要你批准：\n\n" +
                  riskSummary(data.reasons) +
                  (reasonLines ? reasonLines + "\n\n" : "") +
                  "确定推送吗？（批准后本会话内不再询问）",
              );
              auditApproval("git_push", "git push", ok, data.reasons);
              if (!ok) {
                throw new Error("老板未批准 git push，已取消。请改用本地 commit 保存进度，或先向老板说明推送理由。");
              }
              markApproved("git_push", "push");
              ({ resp, data } = await send(true));
            }
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
            // MCP resources（学 Codex resources/list + resources/read）：宿主聚合各服务器声明的资源
            listResources: async () => {
              const desktop = desktopRuntime();
              if (!desktop) throw new Error("MCP 通道未接入。");
              const res = await desktop.mcpAction({ action: "resources" });
              if (res.error) throw new Error(res.error);
              return (res.resources ?? []).map((r) => ({
                server: String(r.server ?? ""),
                uri: String(r.uri ?? ""),
                name: String(r.name ?? ""),
                description: r.description ? String(r.description) : undefined,
                mimeType: r.mimeType ? String(r.mimeType) : undefined,
              }));
            },
            readResource: async (uri: string, server?: string) => {
              const desktop = desktopRuntime();
              if (!desktop) throw new Error("MCP 通道未接入。");
              const res = await desktop.mcpAction({ action: "resource-read", uri, server });
              if (res.error) throw new Error(res.error);
              return String(res.text ?? "");
            },
          }
        : undefined,
      /**
       * 「允许小逻控制本机」闸门读数：内核每轮起线程前往主进程现问一次，关着就不把
       * desktop/webdriver/ssh 报成可用能力 —— 报了只会让小逻撞一次闸，回头让老板满设置里找开关。
       * 主进程答不上这一问（老宿主没有 gate）时交 null，按开着处理：问不到答案不能白收能力。
       */
      hostGate: desktop?.desktopAction
        ? async () => {
            const res = await desktop.desktopAction!({ action: 'gate' });
            return typeof res.enabled === 'boolean' ? res.enabled : null;
          }
        : undefined,
      capabilityCatalog,
      canvasId,
      permissionMode,
      model: effectiveModel?.id ?? "brain",
    };
  }, [canvasId, effectiveModel, capabilityCatalog, onGenerateMedia, mcpTools, permissionMode]);

  /** 对话存档走服务端（同源 /api/v2/chat），任务档案暂留 localStorage */
  const chatStore = useMemo(() => new HttpChatStore({ base: "" }), []);

  // 分叉（P2）：branchCid = 当前分支对话 id，null = 主干（brain-<canvasId>）。
  // 换画布必须回主干，否则 A 画布的分支会挂在 B 画布上。
  const [branchCid, setBranchCid] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [forkError, setForkError] = useState("");
  useEffect(() => {
    setBranchCid(null);
    setForkError("");
  }, [canvasId]);

  const brain = useChatAgent(branchCid ?? "brain-" + canvasId, adapters, {
    store: chatStore,
  });

  const forkCurrentConversation = useCallback(async () => {
    setForkBusy(true);
    setForkError("");
    try {
      setBranchCid(await brain.forkConversation());
    } catch (e) {
      setForkError(e instanceof Error ? e.message : String(e));
    } finally {
      setForkBusy(false);
    }
  }, [brain]);
  const busy = brain.phase === "thinking";
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // QUEUE-TURN：执行中任务队列——忙时发送先入队，回合一结束自动派发队首（新回合按序接续）
  const [queuedTurns, setQueuedTurns] = useState<
    Array<{ id: number; text: string; media: ChatUserMediaRef[]; imageParts: Array<{ mimeType: string; dataUrl: string }> }>
  >([]);
  const queueSeqRef = useRef(0);
  const queueDispatchingRef = useRef(false);
  // 队列上报宿主：展示文本剥掉注入段（附件/引用/记忆），只剩老板原话
  useEffect(() => {
    onQueueChange?.(
      queuedTurns.map((q) => ({
        id: q.id,
        text:
          q.text
            .replace(/【附件】[\s\S]*$/, "")
            .replace(/【外部工具引用】[\s\S]*?\n\n/g, "")
            .replace(/【记忆引用】[\s\S]*?\n\n/g, "")
            .replace(/^>.*$/gm, "")
            .trim() || "（附件素材）",
      })),
    );
  }, [queuedTurns, onQueueChange]);
  // 回合结束自动派发：守卫防连发（send 全程 await，跑完才放行下一条）
  useEffect(() => {
    if (busy) {
      queueDispatchingRef.current = false;
      return;
    }
    if (!queuedTurns.length || queueDispatchingRef.current) return;
    const next = queuedTurns[0];
    queueDispatchingRef.current = true;
    setQueuedTurns((prev) => prev.slice(1));
    void (async () => {
      try {
        await brain.send(next.text, [], next.media, next.imageParts.length ? next.imageParts : undefined);
      } finally {
        queueDispatchingRef.current = false;
      }
    })();
  }, [busy, queuedTurns]);

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
      // STOP-FIX: 原先裸 stop() 被 TS 解析成 window.stop()（页面停止加载，空操作）；
      // 正确接 brain.stop() 中止当前回合，并清空排队队列，防中止后自动派发队首看起来「没停住」
      stop: () => {
        setQueuedTurns([]);
        brain.stop();
      },
      // QUEUE-TURN：移除指定排队任务（宿主输入条「等待发送」清单的 × 按钮）
      removeQueued: (id: number) => setQueuedTurns((prev) => prev.filter((q) => q.id !== id)),
      // STEER-GUIDE：忙时插话——入 steerQueue，下一个工具步之前以「老板中途补充」注入
      steer: (text: string) => {
        const value = text.trim();
        if (!value || !busy) return;
        brain.steer(value);
      },
      send: (text: string, attachments?: ChatAttachmentRef[]) => {
        const value = text.trim();
        if (!value) return;
        void (async () => {
          // 附件物化：抓内容 URL → base64 落工作区 uploads/ → 注入【附件】段（二进制不塞正文）
          const block = attachments?.length ? await materializeAttachments(attachments) : "";
          const full = value + block;
          // 气泡直接渲染素材本体：把附件映射成可播放/可查看的媒体引用
          const media: ChatUserMediaRef[] = (attachments ?? []).map((a) => ({
            kind:
              a.kind === "image" || a.kind === "video" || a.kind === "audio" || a.kind === "text"
                ? a.kind
                : "other",
            url: resolveAssetContentUrl(a.previewUrl ?? a.uri),
            name: a.name,
          }));
          // 图片附件：抓内容 → base64 dataUrl 随消息直传模型（模型可直接看图；失败降级为路径）
          const imageParts: Array<{ mimeType: string; dataUrl: string }> = [];
          for (const a of (attachments ?? []).filter((x) => x.kind === "image").slice(0, 3)) {
            try {
              const r = await fetch(resolveAssetContentUrl(a.previewUrl ?? a.uri));
              if (!r.ok) continue;
              const buf = await r.arrayBuffer();
              if (buf.byteLength > 2 * 1024 * 1024) continue;
              const mime = (r.headers.get("content-type") ?? "").split(";")[0] || "image/png";
              imageParts.push({ mimeType: mime, dataUrl: `data:${mime};base64,${bufToB64(buf)}` });
            } catch { /* 抓取失败：附件已落盘，模型可走文件路径 */ }
          }
          if (busy) {
            // QUEUE-TURN：执行中不打断，进等待队列，当前轮结束后按序自动作为新回合派发
            setQueuedTurns((prev) => [...prev, { id: ++queueSeqRef.current, text: full, media, imageParts }]);
            return;
          }
          await brain.send(full, [], media, imageParts.length ? imageParts : undefined);
        })();
      },
    };
    return () => {
      sendRef.current = null;
    };
  });

  /** 最新代码产物 / 预览快照：上报宿主，落到画布独立结果面板 */
  // useMemo 稳定快照对象引用：原先每次渲染都重建 preview 新对象，
  // 下游 useEffect 依赖每次渲染都变并 setState，触发 Maximum update depth exceeded
  const latestSnapshot = useMemo(() => {
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
    // PREVIEW-CODE-FIRST: coding artifact wins. When a previewable code artifact exists,
    // the preview tab defaults to running THIS program; later image/other preview cards
    // no longer override it. A newer live-service URL still takes over below.
    if (artifact && isPreviewable(artifact)) {
      preview = buildPreviewDocument(artifact);
    } else if (artifact && artifactIdx > previewIdx) {
      preview = null;
    }
    // 本机服务实况预览：抓对话内容里最近的 127.0.0.1 / localhost URL，
    // 比代码产物新时优先内嵌服务地址（跑着的服务才是真实效果）
    let liveUrl: string | null = null;
    let liveIdx = -1;
    for (let i = brain.messages.length - 1; i >= 0; i -= 1) {
      const text = brain.messages[i].content || "";
      const hits = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s"'<>)\]。，、；：）】》]*)?/g);
      if (hits && hits.length) {
        liveUrl = hits[hits.length - 1];
        liveIdx = i;
        break;
      }
    }
    if (liveUrl && liveIdx >= artifactIdx) {
      preview = { srcDoc: "", sandbox: PREVIEW_SANDBOX, title: "本地服务 " + liveUrl, url: liveUrl };
    }
    return { artifact, preview };
  }, [brain.messages]);

  useEffect(() => {
    // AUTO-SVC-SYNC：同步计数随快照上报 → 服务重启后浏览器页签强制重载
    onBrainResult?.({ ...latestSnapshot, syncNonce: brain.svcSyncNonce });
  }, [latestSnapshot, brain.svcSyncNonce, onBrainResult]);

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

  const renderGroupItems = (
    items: ChatUIMessage[],
    turnRunning = false,
  ): ReactNode[] => {
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
      out.push(renderMessage(m, turnRunning));
    });
    flush(true);
    return out;
  };

  /** 对话流回合：老板消息（灰底气泡+时间）+ 小逻回复（处理摘要+结构化内容），一问一答清晰分层 */
  const renderItems = () => {
    const groups: Array<{ key: string; startTs: number; user?: ChatUIMessage; items: ChatUIMessage[] }> = [];
    brain.messages.forEach((m) => {
      if (m.kind === "user") {
        groups.push({ key: m.id, startTs: m.createdAt, user: m, items: [] });
        return;
      }
      if (!groups.length) groups.push({ key: "pre-" + m.id, startTs: m.createdAt, items: [] });
      groups[groups.length - 1].items.push(m);
    });
    const lastIdx = groups.length - 1;
    const turnEntries = groups.map((g, gi) => {
      const steps = g.items.filter((x) => x.kind === "status" && x.meta && typeof x.meta.tool === "string").length;
      const running = busy && gi === lastIdx;
      const userText = g.user ? g.user.content.split("\n\n【附件】")[0] : "";
      const node = (
        <div key={g.key} className="brain-turn" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {g.user ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <div style={{ background: "#333338", color: "#fff", borderRadius: 14, padding: "10px 14px", maxWidth: "94%" }}>
              {/* 【附件】段是给 Agent 取文件用的技术文本，界面不展示 */}
              {/* MEDIA-FIRST：素材（图片/视频/音频等）在上，文字在下，中间拉开间距更易读 */}
              {g.user.media?.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  {g.user.media.map((m, mi) => (
                    <div key={m.url + "-" + mi}>
                      {m.kind === "image" ? (
                        <button
                          type="button"
                          title="点击放大"
                          onClick={() => onZoomMedia?.(m.url, m.name)}
                          style={{ border: "none", background: "none", padding: 0, cursor: "zoom-in", display: "block", maxWidth: "100%" }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.url}
                            alt={m.name}
                            title={m.name}
                            draggable={false}
                            style={{ maxWidth: "100%", maxHeight: 180, borderRadius: 8, display: "block" }}
                          />
                        </button>
                      ) : m.kind === "video" ? (
                        <video
                          src={m.url}
                          controls
                          style={{ maxWidth: "100%", maxHeight: 200, borderRadius: 8, display: "block" }}
                        />
                      ) : m.kind === "audio" ? (
                        <audio src={m.url} controls style={{ width: "100%" }} />
                      ) : m.kind === "text" ? (
                        <iframe
                          src={m.url}
                          title={m.name}
                          style={{ width: "100%", height: 140, border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff" }}
                        />
                      ) : (
                        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
                          {m.name}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              {userText ? (
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {userText}
                </div>
              ) : null}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 2 }}>
                {brainActions(g.user.id, userText, "user", "right")}
                <span style={{ fontSize: 11, color: "#9ca3af" }}>
                  {new Date(g.user.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}
                </span>
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
              {renderGroupItems(g.items, running)}
            </div>
          ) : null}
        </div>
      );
      return { ts: g.startTs, node };
    });
    // 统一对话流：外部消息（快速问答/专业生成）与大脑回合按时间戳严格混排
    const extEntries = (externalItems ?? []).map((e) => ({
      ts: e.createdAt,
      node: <div key={"ext-" + e.id}>{e.node}</div>,
    }));
    return [...turnEntries, ...extEntries].sort((a, b) => a.ts - b.ts).map((x) => x.node);
  };

  /** 规划卡：todo_write 的任务清单（进度条+逐项状态），老板实时看到小逻走到哪了 */
  const PlanCard = ({
    m,
    running = false,
  }: {
    m: ChatUIMessage;
    running?: boolean;
  }) => {
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
            ) : t.status === "in_progress" && running ? (
              <LoaderCircle size={13} className="spin" style={{ color: "#4f46e5", flexShrink: 0 }} />
            ) : (
              <Circle size={13} style={{ color: "#d1d5db", flexShrink: 0 }} />
            )}
            <span
              style={{
                color: t.status === "complete" ? "#9ca3af" : t.status === "in_progress" && running ? "#4f46e5" : "#374151",
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

  const renderMessage = (m: ChatUIMessage, running = false) => {
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
        // Codex 式：拆出 <think> 思考块，正文走 Markdown；回复格式与 Intent 消息统一（头像 + 浅灰气泡）
        const streaming = Boolean((m.meta as { streaming?: boolean } | undefined)?.streaming);
        const { think, body } = splitThink(m.content);
        if (!think && !body) return null;
        return (
          <div key={m.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="message-avatar"
              src="/xiaoluo-mascot.jpg"
              alt="小逻"
              width={27}
              height={27}
              draggable={false}
            />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 6,
              }}
            >
              {think ? <ThinkBlock text={think} /> : null}
              {body ? (
                <div
                  className="brain-bubble"
                  style={{ background: "#f4f5f7", borderRadius: 14, padding: "10px 14px", maxWidth: "94%" }}
                >
                  <MarkdownLite text={body} />
                </div>
              ) : null}
              {/* TIMELINE-CLEAN-DOTS：移除流式「● ● ●」占位点——下方文字已表明执行中 */}
              {!streaming && body ? brainActions(m.id, body, "assistant", "left") : null}
            </div>
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
        return <PlanCard key={m.id} m={m} running={running} />;
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
  }, [brain.messages.length, busy, externalItems?.length]);

  const task = brain.currentTask;

  // 小逻的记忆：入口挪到结果面板标题栏（brain-result-dock），面板不再渲染记忆 UI

  // 技能库扫描：打开面板扫一次；每轮结束（busy 落回 false）重扫，save_skill 落盘的技能下轮可见
  const [skillScanTick, setSkillScanTick] = useState(0);
  useEffect(() => {
    const onChange = () => setSkillScanTick((tick) => tick + 1);
    window.addEventListener("xiaoluo:skills-changed", onChange);
    return () => window.removeEventListener("xiaoluo:skills-changed", onChange);
  }, []);
  useEffect(() => {
    // busy 期间不再回避重扫：长任务执行中技能变更也要实时进菜单（2026-09-22 菜单陈旧修复）
    let live = true;
    let scanning = false;
    const scan = async () => {
      if (scanning) return;
      scanning = true;
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
        // 物种合一：注册表包技能自动物化为工作区 SKILL.md（对话器 /斜杠 与 load_skill 和画布完全同权）
        if (workspaceId) try {
          const regResp = await fetch("/api/v2/registry?workspaceId=" + encodeURIComponent(workspaceId));
          const reg = (await regResp.json().catch(() => ({}))) as {
            packages?: Array<{ id?: string; name?: string; packageType?: string; lifecycleState?: string; description?: string; ownerScope?: string; availabilitySource?: string }>;
            capabilities?: Array<{ packageId?: string; title?: string; modality?: string; contributionType?: string; instructions?: string; enabled?: boolean }>;
          };
          const owned = new Set(items.map((it) => it.name));
          for (const pkg of reg.packages ?? []) {
            if (pkg.packageType !== "skill" || pkg.lifecycleState === "uninstalled" || !pkg.name) continue;
            // 物化口径与能力中心"可用 Skill"页签对齐：可用包全部物化（2026-09-22 裁决：斜杠菜单全量显示）
            const name = pkg.name;
            if (owned.has(name)) continue;
            const cap = (reg.capabilities ?? []).find(
              (c) => c.packageId === pkg.id && c.contributionType === "skill" && c.enabled !== false,
            );
            // 正文回退链：instructions → description → 标题，保证可用技能必进菜单
            const instructions =
              String(cap?.instructions ?? "").trim() ||
              String(pkg.description ?? "").trim() ||
              String(cap?.title ?? name).trim();
            const md =
              "---\nname: " + name +
              "\ndescription: " + String(pkg.description ?? cap?.title ?? name).replace(/\r?\n/g, " ").slice(0, 200) +
              "\nmodality: " + (cap?.modality || "text") +
              "\n---\n\n" + instructions + "\n";
            try {
              await brainFs("write", "skills/" + name + "/SKILL.md", md);
            } catch { continue; }
            owned.add(name);
            items.push({ name, description: String(pkg.description ?? "").trim() });
          }
        } catch { /* 注册表不可用时跳过物化 */ }
        if (live) setSkillCatalog(items);
      } catch { /* skills 目录不存在按空库处理 */ }
      finally { scanning = false; }
    };
    void scan();
    // 自愈：每 30 秒周期重扫，跨窗口/跨事件漏触发兜底，菜单恒与"可用 Skill"对齐
    const timer = window.setInterval(() => void scan(), 30_000);
    return () => { live = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, skillScanTick]);

  // 技能目录上报宿主：对话输入条的 / 斜杠补全菜单与发送期显式引用消费
  useEffect(() => {
    onSkillCatalogChange?.(skillCatalog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillCatalog]);



  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {brain.messages.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "8px 4px",
            borderBottom: "1px solid #eef0f3",
            fontSize: 12,
            color: "#6b7280",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            disabled={busy || forkBusy}
            onClick={() => void forkCurrentConversation()}
            title="把当前对话整份复制成一条分支：分支里随便换思路试，原对话不动"
            style={{
              padding: "2px 10px",
              borderRadius: 999,
              border: "1px solid #c7d2fe",
              background: "#eef2ff",
              color: "#4f46e5",
              fontSize: 12,
              cursor: busy || forkBusy ? "default" : "pointer",
              opacity: busy || forkBusy ? 0.5 : 1,
            }}
          >
            {forkBusy ? "分叉中…" : "分叉对话"}
          </button>
          {branchCid ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setBranchCid(null);
                  setForkError("");
                }}
                title="回到本画布的主干对话"
                style={{
                  padding: "2px 10px",
                  borderRadius: 999,
                  border: "1px solid #d1d5db",
                  background: "#f3f4f6",
                  color: "#374151",
                  fontSize: 12,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.5 : 1,
                }}
              >
                返回主对话
              </button>
              <span style={{ opacity: 0.8 }}>分支自 {brain.forkedFrom ?? branchCid}</span>
            </>
          ) : null}
          {forkError ? <span style={{ color: "#b91c1c" }}>{forkError}</span> : null}
        </div>
      ) : null}
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


          </div>
        </div>
      ) : null}
      <div ref={listRef}
 style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 4px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {brain.messages.length === 0 && !(externalItems ?? []).length ? (
          <div style={{ color: "#8a8f98", fontSize: 13, lineHeight: 1.8 }}>
            智能创作已就位：可以直接让它写代码、出网页预览、生成文件；
            拿不准的地方它会先反问确认。大模型在底部选项条切换。
          </div>
        ) : (
          renderItems()
        )}
        {externalFooter}
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

    </div>
  );
}