import { spawn, spawnSync } from "node:child_process";
import "./local-hybrid-env.mjs";

const children = [];

const mysql = spawnSync(
  process.execPath,
  ["scripts/local-mysql.mjs", "start"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  },
);
if (mysql.status !== 0) {
  process.exit(mysql.status ?? 1);
}

function start(args, name) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
  });
  children.push(child);
  return child;
}

const server = start(
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3001",
  ],
  "web",
);
start(["scripts/runtime-worker.mjs"], "runtime-worker");

if (
  process.env.ISOLATED_WORKER_ENDPOINT?.trim() &&
  process.env.ISOLATED_WORKER_TOKEN?.trim()
) {
  start(["isolated-worker/server.mjs"], "isolated-worker");
}

function stop(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

server.on("exit", (code, signal) => {
  stop(signal ?? "SIGTERM");
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
