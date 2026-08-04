import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import "./local-hybrid-env.mjs";

mkdirSync(".wrangler", { recursive: true });

function running(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function stopProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process already stopped.
    }
  }
}

async function startProcess({
  args,
  stdoutPath,
  stderrPath,
  pidPath,
  restart = false,
}) {
  const activePid = running(pidPath);
  if (activePid && !restart) return activePid;
  if (activePid) stopProcessTree(activePid);

  writeFileSync(pidPath, "", "utf8");
  const stdout = openSync(resolve(stdoutPath), "w");
  const stderr = openSync(resolve(stderrPath), "w");
  let child;

  try {
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    });

    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(
        () => rejectPromise(new Error(`启动进程超时：${args.join(" ")}`)),
        3_000,
      );
      child.once("spawn", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }

  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`进程未返回有效 PID：${args.join(" ")}`);
  }

  child.unref();
  writeFileSync(pidPath, String(child.pid), "utf8");
  return child.pid;
}

async function serverIsReady(timeoutMs = 1_500) {
  try {
    const [healthResponse, pageResponse] = await Promise.all([
      fetch("http://127.0.0.1:3001/api/v2/health/live", {
        signal: AbortSignal.timeout(timeoutMs),
      }),
      fetch("http://127.0.0.1:3001/", {
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ]);
    return healthResponse.ok && pageResponse.ok;
  } catch {
    return false;
  }
}

async function waitForServer(pid, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let nextProgressAt = startedAt + 2_000;

  while (Date.now() - startedAt < timeoutMs) {
    if (await serverIsReady(800)) return true;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }

    if (Date.now() >= nextProgressAt) {
      const seconds = Math.ceil((Date.now() - startedAt) / 1_000);
      console.log(`前端仍在启动（${seconds}s）...`);
      nextProgressAt += 2_000;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

function logTail(path, count = 18) {
  if (!existsSync(path)) return "未生成日志";
  return readFileSync(path, "utf8").split(/\r?\n/).slice(-count).join("\n");
}

async function ensureLocalMysql(timeoutMs = 20_000) {
  console.log("正在检查本地 MySQL...");
  const mysql = spawn(process.execPath, ["scripts/local-mysql.mjs", "start"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let elapsedSeconds = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const progressTimer = setInterval(() => {
      elapsedSeconds += 2;
      console.log(`本地 MySQL 仍在启动（${elapsedSeconds}s）...`);
    }, 2_000);
    const timeoutTimer = setTimeout(() => {
      stopProcessTree(mysql.pid);
      finish(
        new Error(
          `本地 MySQL 在 ${Math.round(timeoutMs / 1_000)} 秒内未就绪，请检查 .local-data/logs/mysql-error.log。`,
        ),
      );
    }, timeoutMs);

    mysql.once("error", (error) => finish(error));
    mysql.once("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `本地 MySQL 启动命令异常退出（code=${code ?? "null"}, signal=${signal ?? "none"}）。`,
        ),
      );
    });
  });
}

await ensureLocalMysql();

console.log("正在检查本地服务...");
const serverAlreadyRunning = await serverIsReady();
const serverPid = serverAlreadyRunning
  ? running(".wrangler/local-dev.pid") || "existing"
  : await startProcess({
      args: [
        // Local APIs use native Node drivers (mysql2 and ali-oss). Running
        // them inside Miniflare turns valid MySQL TCP/TLS connections into
        // opaque `internal error` responses, so local desktop development
        // must use Next's Node runtime. Vinext remains the production build.
        "node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3001",
      ],
      stdoutPath: ".wrangler/local-dev.stdout.log",
      stderrPath: ".wrangler/local-dev.stderr.log",
      pidPath: ".wrangler/local-dev.pid",
      restart: true,
    });

if (!serverAlreadyRunning) {
  console.log(`正在启动前端服务（PID ${serverPid}）...`);
  if (!(await waitForServer(serverPid))) {
    console.error("前端服务未在 15 秒内就绪。标准输出末尾：");
    console.error(logTail(".wrangler/local-dev.stdout.log"));
    console.error("错误日志末尾：");
    console.error(logTail(".wrangler/local-dev.stderr.log"));
    process.exit(1);
  }
}

const workerPid = await startProcess({
  args: ["scripts/runtime-worker.mjs"],
  stdoutPath: ".wrangler/local-runtime-worker.stdout.log",
  stderrPath: ".wrangler/local-runtime-worker.stderr.log",
  pidPath: ".wrangler/local-runtime-worker.pid",
});
const isolatedWorkerPid =
  process.env.ISOLATED_WORKER_ENDPOINT?.trim() &&
  process.env.ISOLATED_WORKER_TOKEN?.trim()
    ? await startProcess({
        args: ["isolated-worker/server.mjs"],
        stdoutPath: ".wrangler/local-isolated-worker.stdout.log",
        stderrPath: ".wrangler/local-isolated-worker.stderr.log",
        pidPath: ".wrangler/local-isolated-worker.pid",
      })
    : "not-configured";

console.log(`local_web=ready url=http://127.0.0.1:3001 pid=${serverPid}`);
console.log(`runtime_worker_pid=${workerPid}`);
console.log(`isolated_worker_pid=${isolatedWorkerPid}`);
