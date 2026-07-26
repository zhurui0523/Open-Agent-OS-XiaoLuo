import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

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

function startProcess({ args, stdoutPath, stderrPath, pidPath }) {
  const activePid = running(pidPath);
  if (activePid) return activePid;
  const stdout = openSync(stdoutPath, "a");
  const stderr = openSync(stderrPath, "a");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env,
  });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  writeFileSync(pidPath, String(child.pid), "utf8");
  return child.pid;
}

let serverAlreadyRunning = false;
try {
  const response = await fetch("http://127.0.0.1:3001/api/v2/health/live", {
    signal: AbortSignal.timeout(800),
  });
  serverAlreadyRunning = response.ok;
} catch {
  serverAlreadyRunning = false;
}

const serverPid = serverAlreadyRunning
  ? "existing"
  : startProcess({
      args: [
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
    });
const workerPid = startProcess({
  args: ["--env-file=.env.local", "scripts/runtime-worker.mjs"],
  stdoutPath: ".wrangler/runtime-worker.stdout.log",
  stderrPath: ".wrangler/runtime-worker.stderr.log",
  pidPath: ".wrangler/runtime-worker.pid",
});

console.log(`server_pid=${serverPid}`);
console.log(`runtime_worker_pid=${workerPid}`);
