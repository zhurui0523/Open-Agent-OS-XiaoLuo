export function modelResponseText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => modelResponseText(item) ?? "")
      .filter(Boolean)
      .join("\n");
    return joined || undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.result === "string") return record.result;
  if (typeof record.output_text === "string") return record.output_text;

  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as
      | { message?: { content?: unknown }; text?: string }
      | undefined;
    const messageText = modelResponseText(first?.message?.content);
    if (messageText) return messageText;
    if (typeof first?.text === "string") return first.text;
  }

  const candidates = record.candidates;
  if (Array.isArray(candidates)) {
    const parts = (
      candidates[0] as { content?: { parts?: Array<{ text?: string }> } }
    )?.content?.parts;
    const joined = parts
      ?.map((part) => part.text ?? "")
      .filter(Boolean)
      .join("\n");
    if (joined) return joined;
  }

  const contentText = modelResponseText(record.content);
  if (contentText) return contentText;
  return modelResponseText(record.output);
}

export function modelResponseAssetUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    const direct = value.trim();
    if (/^(?:https?:\/\/|data:image\/)/i.test(direct)) return direct;
    const markdownImage = direct.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
    return markdownImage?.[1];
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["assetUrl", "url", "video_url", "image_url"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (typeof record.b64_json === "string" && record.b64_json) {
    return `data:image/png;base64,${record.b64_json}`;
  }
  for (const key of ["inlineData", "inline_data"]) {
    const inline = record[key];
    if (inline && typeof inline === "object") {
      const payload = inline as Record<string, unknown>;
      if (typeof payload.data === "string" && payload.data) {
        const mimeType =
          typeof payload.mimeType === "string"
            ? payload.mimeType
            : typeof payload.mime_type === "string"
              ? payload.mime_type
              : "image/png";
        return `data:${mimeType};base64,${payload.data}`;
      }
    }
  }
  for (const key of [
    "data",
    "choices",
    "message",
    "candidates",
    "content",
    "parts",
    "results",
    "images",
    "image",
    "image_url",
    "output",
  ]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = modelResponseAssetUrl(item);
        if (found) return found;
      }
    } else if (nested) {
      const found = modelResponseAssetUrl(nested);
      if (found) return found;
    }
  }
  return undefined;
}
