// 登录档开发板编排器：本地 MySQL + 远程 OSS + 账号密码登录（端口 3002）。
// 与 start-local-detached.mjs 的差异：
// 1) 不导入 local-hybrid-env.mjs —— 不注入 XIAOLUO_MODE=standalone，
//    让 serverRuntimeConfig() 按 .env.local-dev 走 MySQL + OSS 分支；
// 2) 前端用生产形态 `vinext start -p 3002`（同目录只能有一个 next dev 实例，
//    免登录档已占 3001），与打包客户端运行形态一致；源码变更后需先 `pnpm build`；
// 3) 注入 XIAOLUO_RUNTIME_ENV=1 绕过生产守卫（本地 MySQL 无 TLS，DB_SSL_MODE=disabled）；
// 4) 前端 3002、独立日志与 pid 文件名，可与免登录档（3001）并行；
// 5) runtime-worker 轮询 3002；isolated-worker 用 8789 端口并同步覆盖
//    ISOLATED_WORKER_ENDPOINT，避免与免登录档的 8788 冲突。
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

if (!process.env.SECRET_ENCRYPTION_KEY?.trim()) {
  throw new Error(
    ".env.local-dev 缺少 SECRET_ENCRYPTION_KEY；请通过 pnpm dev:login 启动（脚本带 --env-file）",
  );
}
if (!existsSync("dist/server") && !existsSync("dist/index.html")) {
  throw new Error("dist 产物不存在；请先运行 pnpm build 再启动登录档");
}

const APP_PORT = "3002";
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const ISOLATED_PORT = "8789";

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
      // 进程已停止。
    }
  }
}

async function startProcess({
  args,
  stdoutPath,
  stderrPath,
  pidPath,
  env = process.env,
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
      env,
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
      fetch(`${APP_ORIGIN}/api/v2/health/live`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
      fetch(`${APP_ORIGIN}/`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
    ]);
    return healthResponse.ok && pageResponse.ok;
  } catch {
    return false;
  }
}

async function waitForServer(pid, timeoutMs = 60_000) {
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
      console.log(`登录档前端仍在启动（${seconds}s）...`);
      nextProgressAt += 2_000;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return serverIsReady(5_000);
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
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const progressTimer = setInterval(() => {
      console.log("本地 MySQL 仍在启动...");
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
    mysql.once("exit", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`本地 MySQL 启动命令异常退出（code=${code ?? "null"}）。`));
    });
  });
}

await ensureLocalMysql();

console.log("正在检查登录档服务（端口 3002）...");
const serverAlreadyRunning = await serverIsReady();
const serverPid = serverAlreadyRunning
  ? running(".wrangler/login-dev.pid") || "existing"
  : await startProcess({
      args: [
        "node_modules/vinext/dist/cli.js",
        "start",
        "--port",
        APP_PORT,
      ],
      // 覆盖隔离 worker 端点为 8789，避免与免登录档（8788）冲突；
      // XIAOLUO_RUNTIME_ENV=1 表示显式本地部署，绕过生产环境 SSL 守卫
      env: {
        ...process.env,
        NODE_ENV: "production",
        XIAOLUO_RUNTIME_ENV: "1",
        ISOLATED_WORKER_ENDPOINT: `http://127.0.0.1:${ISOLATED_PORT}`,
      },
      stdoutPath: ".wrangler/login-dev.stdout.log",
      stderrPath: ".wrangler/login-dev.stderr.log",
      pidPath: ".wrangler/login-dev.pid",
      restart: true,
    });

if (!serverAlreadyRunning) {
  console.log(`正在启动登录档前端（PID ${serverPid}）...`);
  if (!(await waitForServer(serverPid))) {
    console.error("登录档前端未就绪。标准输出末尾：");
    console.error(logTail(".wrangler/login-dev.stdout.log"));
    console.error("错误日志末尾：");
    console.error(logTail(".wrangler/login-dev.stderr.log"));
    process.exit(1);
  }
}

// runtime-worker 是轮询器：登录档的 worker 必须轮询 3002，否则任务会被免登录档领走
const workerPid = await startProcess({
  args: ["scripts/runtime-worker.mjs"],
  env: { ...process.env, LOCAL_APP_ORIGIN: APP_ORIGIN },
  stdoutPath: ".wrangler/login-runtime-worker.stdout.log",
  stderrPath: ".wrangler/login-runtime-worker.stderr.log",
  pidPath: ".wrangler/login-runtime-worker.pid",
  restart: true,
});
const isolatedWorkerPid =
  process.env.ISOLATED_WORKER_TOKEN?.trim()
    ? await startProcess({
        args: ["isolated-worker/server.mjs"],
        env: {
          ...process.env,
          PORT: ISOLATED_PORT,
          ISOLATED_WORKER_ENDPOINT: `http://127.0.0.1:${ISOLATED_PORT}`,
        },
        stdoutPath: ".wrangler/login-isolated-worker.stdout.log",
        stderrPath: ".wrangler/login-isolated-worker.stderr.log",
        pidPath: ".wrangler/login-isolated-worker.pid",
        restart: true,
      })
    : "not-configured";

console.log(`login_web=ready url=http://0.0.0.0:${APP_PORT} pid=${serverPid}`);
console.log(`runtime_worker_pid=${workerPid}`);
console.log(`isolated_worker_pid=${isolatedWorkerPid}`);
