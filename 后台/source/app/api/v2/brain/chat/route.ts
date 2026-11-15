/**
 * Xiaoluo Brain (xiaoluo-brain ChatAgent) LLM gateway proxy.
 * Frontend callLLM adapter hits here; the reusable core lives in app/lib/brain-llm-gateway.ts
 * (credential resolution, protocol translation, orphan-tool pruning), so the server-side
 * app-server can drive the same model connection without looping back over HTTP.
 * This file keeps only the HTTP concerns: auth, rate limit, param validation, Response shape.
 * Keys never leave the server.
 */

import { jsonError, requireUser } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import {
  BrainGatewayError,
  callBrainModel,
  type ChatWireMessage,
} from "../../../../lib/brain-llm-gateway";

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
    const call = await callBrainModel({
      userId: user.id,
      canvasId,
      modelId,
      messages: payload.messages,
      tools: payload.tools,
      stream: payload.stream,
      signal: request.signal,
    });
    if (call.streamBody) {
      return new Response(call.streamBody, {
        status: 200,
        headers: { "content-type": call.contentType ?? "text/event-stream", "cache-control": "no-cache" },
      });
    }
    return new Response(call.body ?? "", {
      status: call.status,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // 网关侧可预期的失败保持原状态码与文案；其余照旧走统一错误出口
    if (error instanceof BrainGatewayError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return jsonError(error, "智能创作模型调用失败");
  }
}
