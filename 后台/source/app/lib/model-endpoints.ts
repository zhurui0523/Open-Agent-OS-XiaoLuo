export type ModelEndpointKind =
  | "chat-completions"
  | "image-generations"
  | "responses"
  | "messages"
  | "videos"
  | "gemini-generate-content"
  | "custom";

export function modelEndpointKind(raw: string): ModelEndpointKind {  let pathname: string;
  try {
    pathname = new URL(raw).pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "custom";
  }
  if (pathname.endsWith("/chat/completions")) return "chat-completions";
  if (pathname.endsWith("/images/generations")) return "image-generations";
  if (pathname.endsWith("/responses")) return "responses";
  if (pathname.endsWith("/messages")) return "messages";
  if (pathname.endsWith("/videos")) return "videos";
  if (pathname.endsWith(":generatecontent")) {
    return "gemini-generate-content";
  }
  return "custom";
}

/** 对话可用端点：仅 OpenAI chat/completions 与 Anthropic messages（其余是生成/专用端点） */
export function isChatEndpointKind(raw: string): boolean {
  if (!raw?.trim()) return true; // 未填端点按默认 chat 兼容处理
  const kind = modelEndpointKind(raw);
  return kind === "chat-completions" || kind === "messages";
}

export function resolveModelApiEndpoint(
  baseUrl: string,
) {
  return baseUrl;
}
