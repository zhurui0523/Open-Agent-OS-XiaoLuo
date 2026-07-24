import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";

mkdirSync(".wrangler", { recursive: true });

const stdout = openSync(".wrangler/local-dev.stdout.log", "a");
const stderr = openSync(".wrangler/local-dev.stderr.log", "a");
const child = spawn(
  process.execPath,
  [
    "node_modules/vinext/dist/cli.js",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3001",
  ],
  {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env,
  },
);

child.unref();
closeSync(stdout);
closeSync(stderr);
console.log(`pid=${child.pid}`);
