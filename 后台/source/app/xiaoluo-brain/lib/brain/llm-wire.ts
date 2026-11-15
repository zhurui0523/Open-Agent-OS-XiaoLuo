/**
 * 小逻 v3 —— LLM 线上格式转换（ChatMessage ↔ OpenAI chat/completions）
 *
 * 引擎的历史是 ChatMessage（带 toolCalls/toolCallId/images 的内部形状），
 * 上游只认 OpenAI 兼容线格式。这段转换原先长在面板组件里，app-server 化后
 * 浏览器宿主与服务端宿主都要转同一份，抄一遍就会漂（尤其是孤儿工具结果的对称裁剪）。
 *
 * 纯函数 + 只依赖 Web 流全局（ReadableStream/TextDecoder，浏览器与 Node 18+ 都有）：
 * 两种宿主共用，也能直接在 Node 里测。
 *
 * 流式那半段（parseModelSSE / replyFromStreamAccum / salvageStreamInterruption）原先只住在面板组件里，
 * 服务端宿主想逐字显形就得再来一份 —— 现在两边解析同一份，断流抢救的口径也不会分家。
 */

import type { ChatMessage } from "./types";
import { BrainLLMError, type ToolCall } from "./types";

/** 线格式消息（与 app/lib/brain-llm-gateway.ts 的 ChatWireMessage 同形） */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** ChatAgent message history -> OpenAI-compatible wire messages */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  // 孤立工具结果（中断/裁剪丢了对应 assistant tool_calls）会让上游报
  // “No tool call found for function”：先把没有归属的工具结果剔除
  const declaredToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) declaredToolCallIds.add(tc.id);
    }
  }
  // 对称裁剪：中断会留下"发了调用但没有结果"的悬空 assistant 轮，上游同样拒收（No tool output found）
  const answeredToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) answeredToolCallIds.add(m.toolCallId);
  }
  return messages.filter((m) => {
    if (m.role !== "tool") return true;
    return m.toolCallId !== undefined && declaredToolCallIds.has(m.toolCallId);
  }).map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
        name: m.toolName,
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const keptCalls = m.toolCalls.filter((tc) => answeredToolCallIds.has(tc.id));
      if (keptCalls.length === 0) {
        return { role: m.role, content: m.content || "（已中断）" };
      }
      return {
        role: "assistant" as const,
        content: m.content,
        tool_calls: keptCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    if (m.role === "user" && m.images?.length) {
      return {
        role: m.role,
        content: [
          { type: "text" as const, text: m.content },
          ...m.images.map((im) => ({ type: "image_url" as const, image_url: { url: im.dataUrl } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** 上游 chat/completions 响应里我们关心的那几项（非流式整包） */
export interface WireCompletion {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
}

/** ports.callLLM 的返回形状（引擎据此判截断续跑，别丢 finishReason） */
export interface LLMReply {
  content: string;
  toolCalls?: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason?: string;
}

/**
 * 整包响应 → 引擎形状。
 * WRITE-CODE-TRUNC：参数 JSON 解析失败显式标记 __truncated，工具层据此回流「被截断请拆分」，
 * 不能静默当空参数执行（那会把半截 write_code 当成「老板要一个空文件」）。
 */
export function mapCompletionResponse(data: WireCompletion): LLMReply {
  const wire = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (wire?.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
    } catch {
      args.__truncated = true;
    }
    return { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: args };
  });
  return {
    content: wire?.content ?? "",
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
    // TRUNC-GATE：length/max_tokens 判为长度截断而非自愿收尾
    finishReason: data.choices?.[0]?.finish_reason,
  };
}

/**
 * 流式累积形状：SSE 边收边拼，正文增量喂 onDelta，tool_calls 碎片按 index 拼装。
 * 这段原先长在面板组件里 —— 但浏览器宿主和服务端宿主解析的是同一种上游字节流，
 * 抄两份就会漂（尤其是 __truncated 与 usage 回填这两处会静默改变行为的细节）。
 */
export interface StreamAccum {
  content: string;
  tools: Array<{ id: string; name: string; argsJson: string }>;
  usage: { prompt: number; completion: number };
  // WRITE-CODE-TRUNC: length/max_tokens = 输出被长度上限掐断，工具参数 JSON 大概率残缺
  finishReason?: string;
}

/** 上游 SSE 方言：OpenAI 兼容与 Anthropic（网关用 content-type 里的 profile 标记区分） */
export type ModelSSEProtocol = "openai" | "anthropic";

/** 消费上游 SSE 字节流；onDelta 只喂正文增量（tool_calls 碎片不算逐字显形） */
export async function parseModelSSE(
  body: ReadableStream<Uint8Array>,
  protocol: ModelSSEProtocol,
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
      choices?: Array<{
        finish_reason?: string;
        delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const fr = ch.choices?.[0]?.finish_reason;
    if (fr) acc.finishReason = fr;
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
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
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
      const sr = d.delta?.stop_reason;
      if (sr) acc.finishReason = sr;
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

/** 流式累积 → 引擎形状：与非流式 mapCompletionResponse 同形，Agent 不需要知道上游怎么传的 */
export function replyFromStreamAccum(acc: StreamAccum): LLMReply {
  // WRITE-CODE-TRUNC: 参数 JSON 断裂=输出被截断——显式标记 __truncated，工具层回流「被截断请拆分」
  const toolCalls: ToolCall[] = acc.tools.map((tc, i) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsJson || "{}") as Record<string, unknown>;
    } catch {
      args.__truncated = true;
    }
    return { id: tc.id || "stream_tc_" + i, name: tc.name, arguments: args };
  });
  return {
    content: acc.content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: { promptTokens: acc.usage.prompt, completionTokens: acc.usage.completion },
    // TRUNC-GATE：收口原因透传给 Agent，length/max_tokens 判为长度截断而非自愿收尾
    finishReason: acc.finishReason,
  };
}

/**
 * 断流抢救（学 Codex 中断保留）：已收到实质正文且没有半截工具调用 → 直接定稿，
 * 不整体重试浪费已产出内容；否则抛可重试错并带上 partial，由宿主决定怎么续。
 */
export function salvageStreamInterruption(acc: StreamAccum | undefined): LLMReply {
  if (acc && acc.content.trim().length >= 20 && acc.tools.length === 0) {
    return {
      content:
        acc.content +
        "\n\n[系统注记] 流式响应中途断开，以上为已收到的部分；请从断点继续，不要重复已说过的内容。",
      usage: { promptTokens: acc.usage.prompt, completionTokens: acc.usage.completion },
    };
  }
  throw new BrainLLMError("模型流式响应中途断开，正在重试…", { retryable: true, partial: acc?.content });
}

/** 上游错误体可能是字符串、{message}、{error:{message}}，甚至 HTML：收成一句能给人看的话 */
export function flattenModelError(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { message?: unknown; error?: unknown };
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (obj.error !== undefined) return flattenModelError(obj.error);
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/**
 * 上游失败 → BrainLLMError（引擎按 retryable 决定要不要自动重试一次）。
 * 余额/配额类错误重试无意义，直接给可操作指引，不透传英文原文。
 */
export function modelErrorFromStatus(status: number, raw: unknown): BrainLLMError {
  const msg = flattenModelError(raw) || "模型调用失败 (" + status + ")";
  if (/insufficient.{0,40}balance|balance.{0,40}insufficient|quota|billing/i.test(msg)) {
    return new BrainLLMError(
      "模型服务额度不足（上游：" + msg + "）。请到模型连接设置里充值或切换备用模型后再试。",
      { retryable: false },
    );
  }
  return new BrainLLMError(msg, { retryable: status >= 500 || status === 429 });
}
