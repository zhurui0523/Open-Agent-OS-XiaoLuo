#!/usr/bin/env node
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

// INPROC-SCHEDULER：独立部署没有 Cloudflare cron，也不依赖外部 runtime-worker 进程。
// 异步生成任务 / 内核运行全靠 /api/v2/worker/tick 推进；无人 tick 时重启服务后
// 在途任务永远停在“正在生成中”（第三方已完成也无人取回）。这里把 tick 内置为
// 常驻循环：任何启动方式（ensure-server.ps1 / start.bat / 手动）都自带调度器。
function startInprocScheduler() {
  const token = process.env.RUNTIME_WORKER_TOKEN?.trim();
  if (!token) {
    console.error(
      "[inproc-scheduler] RUNTIME_WORKER_TOKEN 未配置，跳过常驻调度（异步任务将无人轮询）",
    );
    return;
  }
  const origin = `http://127.0.0.1:${port}`;
  const minimumDelayMs = 5_000;
  const maximumDelayMs = 30_000;
  let nextDelayMs = minimumDelayMs;
  let lastFailure = "";
  const tick = async () => {
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
          console.error(`[inproc-scheduler] tick failed: ${failure}`);
          lastFailure = failure;
        }
        nextDelayMs = Math.min(maximumDelayMs, nextDelayMs * 2);
      } else {
        nextDelayMs = minimumDelayMs;
        lastFailure = "";
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : "tick failed";
      if (failure !== lastFailure) {
        console.error(`[inproc-scheduler] ${new Date().toISOString()} ${failure}`);
        lastFailure = failure;
      }
      nextDelayMs = Math.min(maximumDelayMs, nextDelayMs * 2);
    }
    setTimeout(tick, nextDelayMs);
  };
  setTimeout(tick, minimumDelayMs);
  console.log(`[inproc-scheduler] 常驻调度已启动，轮询 ${origin}`);
}

startProdServer({
  port,
  host,
  outDir: join(import.meta.dirname, "dist"),
})
  .then(() => {
    startInprocScheduler();
  })
  .catch((error) => {
    console.error("[vinext] Failed to start standalone server");
    console.error(error);
    process.exit(1);
  });
