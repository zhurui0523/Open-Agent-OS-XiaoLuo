const token = process.env.RUNTIME_WORKER_TOKEN?.trim();
const origin = process.env.LOCAL_APP_ORIGIN?.trim() || "http://127.0.0.1:3001";

if (!token) {
  throw new Error("RUNTIME_WORKER_TOKEN 未配置，Runtime Worker 拒绝启动");
}

let stopping = false;
const minimumDelayMs = 2_000;
const maximumDelayMs = 30_000;
let nextDelayMs = minimumDelayMs;
let lastFailure = "";

async function tick() {
  try {
    const response = await fetch(`${origin}/api/v2/worker/tick`, {
      method: "POST",
      headers: { "x-runtime-worker-token": token },
      signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) {
      const message = await response.text();
      const failure = `HTTP ${response.status} ${message.slice(0, 300)}`;
      if (failure !== lastFailure) {
        console.error(`[runtime-worker] tick failed: ${failure}`);
        lastFailure = failure;
      }
      nextDelayMs = Math.min(maximumDelayMs, nextDelayMs * 2);
    } else {
      nextDelayMs = minimumDelayMs;
      lastFailure = "";
    }
  } catch (error) {
    const failure =
      error instanceof Error ? error.message : "tick failed";
    if (failure !== lastFailure) {
      console.error(`[runtime-worker] ${new Date().toISOString()} ${failure}`);
      lastFailure = failure;
    }
    nextDelayMs = Math.min(maximumDelayMs, nextDelayMs * 2);
  }
  if (!stopping) setTimeout(tick, nextDelayMs);
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

console.log(`[runtime-worker] polling ${origin}`);
void tick();
