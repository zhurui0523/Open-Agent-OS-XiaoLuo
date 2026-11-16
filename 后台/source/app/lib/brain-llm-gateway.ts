/**
 * 小逻 v3 —— LLM 网关核心（P3：把「调模型」从 HTTP 路由里剥出来）
 *
 * 原来这段全写在 app/api/v2/brain/chat/route.ts 里：浏览器发一轮就得走一次 fetch。
 * app-server 化之后，跑在服务端进程里的小逻也要调同一个模型连接、同一套凭据、同一种协议翻译，
 * 再走一遍自己的 HTTP 路由就成了自己调自己。本文件把那部分抽成可直接 import 的函数：
 *
 *  - 路由只留 HTTP 关切：鉴权（requireUser）、限流、参数校验、把结果包成 Response；
 *  - Node 端口（server-ports.ts）直接 await callBrainModel，不经过网络。
 *
 * 行为与抽出前逐字一致：同样的错误文案与状态码、同样的 slice(-64) 与孤儿 tool 裁剪、
 * 同样的 12MB 上限、180s 头部超时、非流式 429/5xx 退避重试一次、Anthropic 响应回译 OpenAI 形状。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { modelConnections } from "../../db/schema";
import { requireCanvasAccess } from "./authorization";
import { modelEndpointKind } from "./model-endpoints";
import { resolveSecret } from "./secret-vault";
import {
  anthropicErrorToOpenAI,
  anthropicToOpenAI,
  buildAnthropicBody,
} from "./anthropic-adapter";

/** 上游线格式的消息（与 OpenAI chat/completions 同形） */
export interface ChatWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** 网关侧可预期的失败：带 HTTP 语义的状态码，路由据此回 Response，Node 侧据此抛错 */
export class BrainGatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BrainGatewayError";
    this.status = status;
  }
}

/** 中断/裁剪可能留下没有对应 assistant tool_calls 的孤儿 tool 结果，上游会直接拒收 */
export function pruneOrphanToolMessages(messages: ChatWireMessage[]): ChatWireMessage[] {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) declared.add(tc.id);
    }
    if (m.role === "tool" && typeof m.tool_call_id === "string") answered.add(m.tool_call_id);
  }
  const out: ChatWireMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      // 孤儿结果：没有归属的 assistant tool_calls
      if (typeof m.tool_call_id === "string" && declared.has(m.tool_call_id)) out.push(m);
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const kept = m.tool_calls.filter((tc) => tc?.id && answered.has(tc.id));
      if (kept.length === 0) {
        // 悬空调用轮：剥掉 tool_calls，正文兜底占位，防上游拒收
        out.push({
          ...m,
          tool_calls: undefined,
          content: typeof m.content === "string" && m.content ? m.content : "（已中断）",
        });
        continue;
      }
      if (kept.length !== m.tool_calls.length) {
        out.push({ ...m, tool_calls: kept });
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

type ModelCredentialRow = {
  secretRefId: string | null;
  credentialRef: string | null;
  workspaceId: string;
};

export async function resolveCredential(row: ModelCredentialRow): Promise<string | undefined> {
  // Same credential resolution as kernel-executors.modelCredential
  if (!row.secretRefId) {
    return row.credentialRef ? process.env[row.credentialRef] : undefined;
  }
  return await resolveSecret(row.secretRefId, row.workspaceId);
}

export interface CallBrainModelInput {
  userId: string;
  canvasId: string;
  modelId: string;
  messages: ChatWireMessage[];
  tools?: unknown[];
  stream?: boolean;
  /** 调用方中止信号（在途请求被掐断）；缺省只受 180s 头部超时约束 */
  signal?: AbortSignal;
}

export interface BrainModelCall {
  /** 上游状态码（非流式时宿主可据此判失败） */
  status: number;
  /** 非流式：已回译成 OpenAI chat/completions 形状的 JSON 文本 */
  body?: string;
  /** 流式：上游 SSE 原始字节流，宿主自己解析 */
  streamBody?: ReadableStream<Uint8Array>;
  /** 流式时的 content-type（Anthropic 带 profile 标记） */
  contentType?: string;
}

/**
 * 解析模型连接（含权限）：不存在/未启用 404，无权限由 requireCanvasAccess 抛 Response。
 * 单独导出是给宿主「先验连接再开线程」用，避免线程建好了才发现模型不可用。
 */
export async function resolveBrainModelConnection(userId: string, canvasId: string, modelId: string) {
  const access = await requireCanvasAccess(userId, canvasId, "view");
  const db = await getDb();
  const [row] = await db
    .select()
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.id, modelId),
        eq(modelConnections.workspaceId, access.workspaceId),
        eq(modelConnections.enabled, true),
      ),
    )
    .limit(1);
  if (!row) {
    throw new BrainGatewayError(404, "模型不存在或未启用");
  }
  const endpoint = modelEndpointKind(row.baseUrl);
  if (endpoint !== "chat-completions" && endpoint !== "messages") {
    throw new BrainGatewayError(
      400,
      "这个模型连接不是对话模型（端点类型：" +
        endpoint +
        "）：小逻只能接 OpenAI chat/completions 或 Anthropic messages 兼容的对话模型，图片/视频生成连接不能用于聊天。请在设置里换一个对话模型。",
    );
  }
  let credential = await resolveCredential(row);
  // 本地大模型（嵌入式引擎）无需 API Key：uiSchema.provider === "local" 时用占位凭据放行
  if (!credential) {
    try {
      const parsedUiSchema = JSON.parse(row.uiSchemaJson) as Record<string, unknown>;
      if (parsedUiSchema.provider === "local") credential = "local";
    } catch {
      /* uiSchema 解析失败按缺凭据处理 */
    }
  }
  if (!credential) {
    throw new BrainGatewayError(400, "模型 API Key 未配置或无法解密");
  }
  return { row, endpoint, credential };
}

/** 拼上游请求体（两种协议各一份；流式统一要 usage，账本统计不知不觉） */
export function buildUpstreamBody(
  endpoint: "chat-completions" | "messages",
  modelName: string,
  messages: ChatWireMessage[],
  tools: unknown[],
  stream: boolean,
): string {
  if (endpoint === "messages") {
    const obj = JSON.parse(buildAnthropicBody({ model: modelName, messages, tools })) as Record<string, unknown>;
    if (stream) obj.stream = true;
    return JSON.stringify(obj);
  }
  return JSON.stringify({
    model: modelName,
    messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  });
}

/** 上游请求头：Anthropic 用 x-api-key，OpenAI 兼容用 Bearer */
export function buildUpstreamHeaders(
  endpoint: "chat-completions" | "messages",
  credential: string,
): Record<string, string> {
  return endpoint === "messages"
    ? {
        "content-type": "application/json",
        "x-api-key": credential,
        "anthropic-version": "2023-06-01",
      }
    : { "content-type": "application/json", authorization: `Bearer ${credential}` };
}

/** Anthropic 响应回译成 OpenAI 形状；解析不了不能把原始 HTML 丢给宿主 */
export function translateUpstreamResponse(
  endpoint: "chat-completions" | "messages",
  status: number,
  text: string,
): string {
  if (endpoint !== "messages") return text;
  try {
    return status >= 200 && status < 300
      ? anthropicToOpenAI(JSON.parse(text) as Record<string, unknown>)
      : anthropicErrorToOpenAI(text);
  } catch {
    return JSON.stringify({ error: "Anthropic 响应解析失败 (" + status + ")" });
  }
}

/**
 * 走一次模型调用。凭据、权限、协议翻译都在这里面，调用方拿到的就是可用的响应。
 * 抛 BrainGatewayError（404/400/413）或网络层原生错误；上游 4xx/5xx 不抛错，
 * 由调用方按 status 决定怎么回（保持与抽出前的路由一致）。
 */
export async function callBrainModel(input: CallBrainModelInput): Promise<BrainModelCall> {
  const { row, endpoint, credential } = await resolveBrainModelConnection(input.userId, input.canvasId, input.modelId);
  const tools = Array.isArray(input.tools) ? input.tools : [];
  // 防第三方入口：剔除没有归属的孤儿 tool 结果，避免上游拒收
  const recentMessages = pruneOrphanToolMessages(input.messages.slice(-64));
  const wantStream = Boolean(input.stream);
  const upstreamBody = buildUpstreamBody(endpoint, row.modelName, recentMessages, tools, wantStream);
  if (upstreamBody.length > 12_000_000) {
    throw new BrainGatewayError(413, "请求过大");
  }
  // 流式时头部超时独立管：收到响应头后改由调用方断开信号接管（正文可能流几分钟，不能被 180s 闸门截断）
  const headCtrl = new AbortController();
  const headTimer = setTimeout(() => headCtrl.abort(), 180_000);
  const upstreamSignal = wantStream
    ? AbortSignal.any(input.signal ? [input.signal, headCtrl.signal] : [headCtrl.signal])
    : AbortSignal.any(input.signal ? [input.signal, AbortSignal.timeout(180_000)] : [AbortSignal.timeout(180_000)]);
  const fetchOptions = {
    method: "POST",
    headers: buildUpstreamHeaders(endpoint, credential),
    body: upstreamBody,
    signal: upstreamSignal,
  };
  let upstream = await fetch(row.baseUrl, fetchOptions);
  // 非流式且上游抖动（429/5xx）：短退避重试一次；流式透传不重试，由客户端重试接管
  if (!wantStream && (upstream.status === 429 || upstream.status >= 500)) {
    await upstream.text().catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 700));
    upstream = await fetch(row.baseUrl, fetchOptions);
  }
  clearTimeout(headTimer);
  // 流式成功：SSE 原样交回（宿主自行解析）；失败落回下方非流处理
  if (wantStream && upstream.ok && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return {
      status: 200,
      streamBody: upstream.body as ReadableStream<Uint8Array>,
      contentType:
        endpoint === "messages" ? "text/event-stream; profile=anthropic-sse" : "text/event-stream",
    };
  }
  const text = await upstream.text();
  return { status: upstream.status, body: translateUpstreamResponse(endpoint, upstream.status, text) };
}
