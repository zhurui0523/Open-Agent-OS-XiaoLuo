/**
 * 扩散引擎（图片/视频）的模拟实现（开发/验证用）：
 * OpenAI 风格 /v1/images/generations 与 /v1/videos，返回占位资产。
 * 正式版替换为捆绑的 sd-server.exe（desktop/runtime-local-ai/sd-server.exe）。
 */
import { createServer } from "node:http";

const port = Number(process.env.XIAOLUO_MOCK_PORT || 12235);
const alias = process.env.XIAOLUO_MOCK_ALIAS || "xiaoluo-local-diffusion-mock";

// 1x1 透明 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// 占位视频字节（含 ftyp 头，仅用于链路验证，非可播放内容）
const VIDEO_B64 = Buffer.from(
  "MOCKVIDEO:" + alias + ":" + new Date().toISOString(),
).toString("base64");

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function json(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    json(res, 200, { status: "ok" });
    return;
  }
  if (req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: alias, object: "model" }] });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    const body = await readBody(req);
    let prompt = "";
    try { prompt = JSON.parse(body).prompt || ""; } catch {}
    // 模拟生成耗时
    await new Promise((r) => setTimeout(r, 300));
    json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: PNG_B64, revised_prompt: prompt.slice(0, 200) }],
    });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/videos") {
    const body = await readBody(req);
    let prompt = "";
    try { prompt = JSON.parse(body).prompt || ""; } catch {}
    await new Promise((r) => setTimeout(r, 500));
    json(res, 200, {
      created: Math.floor(Date.now() / 1000),
      model: alias,
      data: [{ b64: VIDEO_B64, prompt: prompt.slice(0, 200) }],
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log("xiaoluo mock diffusion engine listening on 127.0.0.1:" + port);
});
