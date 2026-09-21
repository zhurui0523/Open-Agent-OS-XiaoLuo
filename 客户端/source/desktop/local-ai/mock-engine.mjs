/**
 * 本地引擎的模拟实现（开发/验证用）：OpenAI 兼容的最小 HTTP 服务。
 * 正式版替换为捆绑的 llama-server.exe（desktop/runtime-local-ai/llama-server.exe）。
 */
import { createServer } from "node:http";

const port = Number(process.env.XIAOLUO_MOCK_PORT || 11435);
const alias = process.env.XIAOLUO_MOCK_ALIAS || "xiaoluo-local-mock";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: alias, object: "model" }] }));
    return;
  }
  if (req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let userText = "";
      try {
        const parsed = JSON.parse(body);
        const last = [...(parsed.messages || [])].reverse().find((m) => m.role === "user");
        userText = typeof last?.content === "string" ? last.content.slice(0, 80) : "";
      } catch {}
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: alias,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "这是小逻本地模拟引擎的回复。收到内容：" + userText },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log("xiaoluo mock engine listening on 127.0.0.1:" + port);
});
