/**
 * Xiaoluo Brain (xiaoluo-brain ChatAgent) LLM gateway proxy.
 * Frontend callLLM adapter hits here; server resolves the model connection
 * (baseUrl + encrypted Key) and forwards to upstream: OpenAI-compatible
 * chat/completions directly, Anthropic messages via anthropic-adapter
 * (response translated back to chat/completions shape). Keys never leave the server.
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { modelConnections } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { modelEndpointKind } from "../../../../lib/model-endpoints";
import {
  anthropicErrorToOpenAI,
  anthropicToOpenAI,
  buildAnthropicBody,
} from "../../../../lib/anthropic-adapter";
import { resolveSecret } from "../../../../lib/secret-vault";

interface ChatWireMessage {
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

/** 中断/裁剪可能留下没有对应 assistant tool_calls 的孤儿 tool 结果，上游会直接拒收 */
function pruneOrphanToolMessages(messages: ChatWireMessage[]): ChatWireMessage[] {
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

async function resolveCredential(row: {
  secretRefId: string | null;
  credentialRef: string | null;
  workspaceId: string;
}): Promise<string | undefined> {
  // Same credential resolution as kernel-executors.modelCredential
  if (!row.secretRefId) {
    return row.credentialRef ? process.env[row.credentialRef] : undefined;
  }
  return await resolveSecret(row.secretRefId, row.workspaceId);
}
export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      modelId?: string;
      messages?: ChatWireMessage[];
      tools?: unknown[];
      stream?: boolean;
    };
    const canvasId = payload.canvasId?.trim();
    const modelId = payload.modelId?.trim();
    if (!canvasId || !modelId || !Array.isArray(payload.messages) || payload.messages.length === 0) {
      return Response.json({ error: "canvasId、modelId 和 messages 必填" }, { status: 400 });
    }
    await enforceRateLimit({ subject: user.id, route: "brain:chat", max: 240, windowMs: 60_000 });
    const access = await requireCanvasAccess(user.id, canvasId, "view");
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
      return Response.json({ error: "模型不存在或未启用" }, { status: 404 });
    }
    // chat/completions（OpenAI 兼容）与 messages（Anthropic）两种端点；其余协议暂不支持
    const endpoint = modelEndpointKind(row.baseUrl);
    if (endpoint !== "chat-completions" && endpoint !== "messages") {
      return Response.json(
        { error: "智能创作暂不支持该类型模型连接（需要 OpenAI 兼容或 Anthropic 文本模型）" },
        { status: 400 },
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
      return Response.json({ error: "模型 API Key 未配置或无法解密" }, { status: 400 });
    }
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    // 防第三方入口：剔除没有归属的孤儿 tool 结果，避免上游拒收
    const recentMessages = pruneOrphanToolMessages(payload.messages.slice(-64));
    const wantStream = Boolean(payload.stream);
    const upstreamBody =
      endpoint === "messages"
        ? (() => {
            const obj = JSON.parse(buildAnthropicBody({ model: row.modelName, messages: recentMessages, tools })) as Record<string, unknown>;
            if (wantStream) obj.stream = true;
            return JSON.stringify(obj);
          })()
        : JSON.stringify({
            model: row.modelName,
            messages: recentMessages,
            stream: wantStream,
            // 流式也要 usage（账本统计不知不觉）
            ...(wantStream ? { stream_options: { include_usage: true } } : {}),
            ...(tools.length ? { tools, tool_choice: "auto" } : {}),
          });
    if (upstreamBody.length > 12_000_000) {
      return Response.json({ error: "请求过大" }, { status: 413 });
    }
    // 流式时头部超时独立管：收到响应头后改由客户端断开信号接管（正文可能流几分钟，不能被 180s 闸门截断）
    const headCtrl = new AbortController();
    const headTimer = setTimeout(() => headCtrl.abort(), 180_000);
    const upstreamSignal = wantStream
      ? AbortSignal.any([request.signal, headCtrl.signal])
      : AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
    const headers: Record<string, string> =
      endpoint === "messages"
        ? {
            "content-type": "application/json",
            "x-api-key": credential,
            "anthropic-version": "2023-06-01",
          }
        : {
            "content-type": "application/json",
            authorization: `Bearer ${credential}`,
          };
    const fetchOptions = {
      method: "POST",
      headers,
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
    // 流式成功：SSE 原样透传（客户端自行解析）；失败落回下方非流错误处理
    if (wantStream && upstream.ok && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "content-type":
            endpoint === "messages"
              ? "text/event-stream; profile=anthropic-sse"
              : "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    const text = await upstream.text();
    // Anthropic 协议：响应转回 OpenAI chat/completions 格式（前端统一解析）
    let outText = text;
    if (endpoint === "messages") {
      try {
        outText =
          upstream.status >= 200 && upstream.status < 300
            ? anthropicToOpenAI(JSON.parse(text) as Record<string, unknown>)
            : anthropicErrorToOpenAI(text);
      } catch {
        outText = JSON.stringify({ error: "Anthropic 响应解析失败 (" + upstream.status + ")" });
      }
    }
    return new Response(outText, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return jsonError(error, "智能创作模型调用失败");
  }
}