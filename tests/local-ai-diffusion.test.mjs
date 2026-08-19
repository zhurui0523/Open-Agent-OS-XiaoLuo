import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 18935;
const BASE = "http://127.0.0.1:" + PORT;
const here = dirname(fileURLToPath(import.meta.url));
const mockPath = join(here, "..", "desktop", "local-ai", "mock-diffusion.mjs");

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/health", { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("mock-diffusion 未在时限内就绪");
}

test("mock diffusion engine serves the local-diffusion contract", async (t) => {
  const child = spawn(process.execPath, [mockPath], {
    env: { ...process.env, XIAOLUO_MOCK_PORT: String(PORT) },
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await waitForServer();

  // 健康探测（服务端 probeEngineHealth 依赖）
  const health = await fetch(BASE + "/health");
  assert.equal(health.ok, true);

  // 图片：OpenAI 风格 b64_json（执行器 localDiffusionArtifactBytes 依赖）
  const imageRes = await fetch(BASE + "/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "flux-schnell", prompt: "一只在月光下奔跑的白狐", n: 1 }),
  });
  assert.equal(imageRes.ok, true);
  const imagePayload = await imageRes.json();
  const b64 = imagePayload.data?.[0]?.b64_json;
  assert.ok(typeof b64 === "string" && b64.length > 64, "图片应返回 b64_json");
  const pngBytes = Buffer.from(b64, "base64");
  assert.deepEqual([...pngBytes.slice(1, 4)], [0x50, 0x4e, 0x47], "应为 PNG 魔数");

  // 视频：/v1/videos 同步返回（执行器 20 分钟超时链路）
  const videoRes = await fetch(BASE + "/v1/videos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "wan2.2-ti2v-5b", prompt: "海浪拍打礁石" }),
  });
  assert.equal(videoRes.ok, true);
  const videoPayload = await videoRes.json();
  const videoB64 = videoPayload.data?.[0]?.b64;
  assert.ok(typeof videoB64 === "string" && videoB64.length > 8, "视频应返回 b64");
  assert.match(Buffer.from(videoB64, "base64").toString("utf8"), /^MOCKVIDEO:/);

  // 未知路径 404：执行器端点协商回退 A1111 的探测依据
  const missing = await fetch(BASE + "/v1/unknown");
  assert.equal(missing.status, 404);
});
