const token = process.env.RUNTIME_WORKER_TOKEN?.trim();
const origin = process.env.LOCAL_APP_ORIGIN?.trim() || "http://127.0.0.1:3001";

if (!token) {
  throw new Error("RUNTIME_WORKER_TOKEN 未配置，Runtime Worker 拒绝启动");
}

let stopping = false;

async function tick() {
  try {
    const response = await fetch(`${origin}/api/v2/worker/tick`, {
      method: "POST",
      headers: { "x-runtime-worker-token": token },
      signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) {
      const message = await response.text();
      console.error(
        `[runtime-worker] tick failed: HTTP ${response.status} ${message.slice(0, 300)}`,
      );
    }
  } catch (error) {
    console.error(
      `[runtime-worker] ${new Date().toISOString()} ${
        error instanceof Error ? error.message : "tick failed"
      }`,
    );
  }
  if (!stopping) setTimeout(tick, 2_000);
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

console.log(`[runtime-worker] polling ${origin}`);
void tick();
