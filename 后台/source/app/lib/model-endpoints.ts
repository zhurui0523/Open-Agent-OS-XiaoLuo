export type ModelEndpointKind =
  | "chat-completions"
  | "image-generations"
  | "responses"
  | "messages"
  | "videos"
  | "gemini-generate-content"
  | "custom";

export function modelEndpointKind(raw: string): ModelEndpointKind {
  let pathname: string;
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

export function resolveModelApiEndpoint(
  baseUrl: string,
) {
  return baseUrl;
}
