/**
 * Anthropic messages 协议适配：小逻大脑网关的协议转换层。
 * 前端/ChatAgent 只讲 OpenAI chat/completions（非流式），
 * 服务端在此完成 messages 协议的消息格式 + tool calling 双向映射。
 */

type WireRole = "system" | "user" | "assistant" | "tool";

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface WireMessage {
  role: WireRole;
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Anthropic 要求 user/assistant 严格交替：合并相邻同角色轮、跳过空轮 */
function mergeAlternating(
  msgs: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }>,
): Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of msgs) {
    if (!m.content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

/** OpenAI wire 消息 → Anthropic messages（system 抽出，tool 结果并入 user 轮，相邻同角色合并） */
function toAnthropicMessages(messages: WireMessage[]): Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> {
  // 孤儿清理：LLM 中断保留会留下 "assistant 发了 tool_calls 但没有对应 tool 结果" 的轮，
  // Anthropic 会因 tool_use_id 不匹配永久拒收整个对话——转换前剔除孤儿 tool_use / tool_result
  const answered = new Set(messages.filter((m) => m.role === "tool" && m.tool_call_id).map((m) => m.tool_call_id as string));
  const knownCalls = new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.id ?? "")).filter(Boolean));
  const out: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const blocks: AnthropicBlock[] = [];
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && part.type === "image_url") {
            const url = part.image_url?.url ?? "";
            const dm = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
            if (dm) blocks.push({ type: "image", source: { type: "base64", media_type: dm[1], data: dm[2] } });
          } else {
            blocks.push({ type: "text", text: String((part as { text?: string }).text ?? "") });
          }
        }
      } else {
        blocks.push({ type: "text", text: m.content });
      }
      if (blocks.length) out.push({ role: "user", content: blocks });
      continue;
    }
    if (m.role === "assistant") {
      const content: AnthropicBlock[] = [];
      // 保留的工具调用（孤儿已剔）；空正文但有保留调用时以占位文本补齐
      const keptCalls = (m.tool_calls ?? []).filter((tc) => Boolean(tc.id) && answered.has(tc.id as string));
      if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
      else if (keptCalls.length) content.push({ type: "text", text: "(调用工具)" });
      for (const tc of keptCalls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* 参数解析失败则传空对象 */
        }
        content.push({
          type: "tool_use",
          id: tc.id ?? "tu_" + (content.length + 1),
          name: tc.function?.name ?? "",
          input,
        });
      }
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }
    // role === "tool"：工具结果须挂在 user 轮上（tool_result 块）；孤儿 tool_result 直接丢弃
    if (!m.tool_call_id || !knownCalls.has(m.tool_call_id)) continue;
    const block: AnthropicBlock = {
      type: "tool_result",
      tool_use_id: m.tool_call_id ?? "",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    };
    const last = out[out.length - 1];
    if (last && last.role === "user") last.content.push(block);
    else out.push({ role: "user", content: [block] });
  }
  return mergeAlternating(out);
}

/** OpenAI chat/completions 请求体 → Anthropic messages 请求体（非流式） */
export function buildAnthropicBody(opts: {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
  maxTokens?: number;
}): string {
  const systemParts = opts.messages
    .filter((m) => m.role === "system" && typeof m.content === "string" && m.content)
    .map((m) => m.content as string);
  const messages = toAnthropicMessages(opts.messages);
  const tools = (opts.tools ?? []) as Array<{
    type?: string;
    function?: { name?: string; description?: string; parameters?: unknown };
  }>;
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    messages,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function?.name ?? "",
      description: t.function?.description ?? "",
      input_schema: t.function?.parameters ?? { type: "object", properties: {} },
    }));
  }
  return JSON.stringify(body);
}

/** Anthropic 响应 → OpenAI chat/completions 响应（前端解析格式） */
export function anthropicToOpenAI(data: {
  content?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
}): string {
  const text: string[] = [];
  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
  for (const block of data.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({
        id: String(block.id ?? ""),
        type: "function",
        function: {
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: text.join(""),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
    },
  });
}

/** Anthropic 错误响应 → OpenAI 风格错误（前端按 { error } 展示） */
export function anthropicErrorToOpenAI(raw: string): string {
  try {
    const data = JSON.parse(raw) as { error?: { message?: string; type?: string } };
    return JSON.stringify({ error: data.error?.message ?? raw });
  } catch {
    return JSON.stringify({ error: raw || "Anthropic 调用失败" });
  }
}
