import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const port = Number(process.env.PORT ?? 8788);
const token = process.env.ISOLATED_WORKER_TOKEN ?? "";
const packageRoot = resolve(process.env.PACKAGE_ROOT ?? "/packages");
const maximumConcurrency = Math.max(1, Number(process.env.MAX_CONCURRENCY ?? 2));
const executions = new Map();
let running = 0;

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求超过 1 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request, body) {
  if (!token) return false;
  const timestamp = request.headers["x-xiaoluo-timestamp"];
  const signature = request.headers["x-xiaoluo-signature"];
  if (typeof timestamp !== "string" || typeof signature !== "string") return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 60_000) return false;
  const expected = createHmac("sha256", token).update(`${timestamp}.${body}`).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeEntry(job) {
  const key = String(job.package?.key ?? "");
  const version = String(job.package?.version ?? "");
  const entry = String(job.package?.entry ?? "");
  if (!/^[a-zA-Z0-9._-]+$/.test(key) || !/^[a-zA-Z0-9._-]+$/.test(version)) {
    throw new Error("Package key/version 非法");
  }
  const root = resolve(packageRoot, key, version);
  const result = resolve(root, entry);
  if (!result.startsWith(`${root}${sep}`)) throw new Error("入口文件越出只读 Package 目录");
  return { root, entry: result };
}

function validate(job) {
  if (!job?.jobId || !["node", "python", "cli"].includes(job.runtime)) {
    throw new Error("执行请求无效");
  }
  const policy = job.policy ?? {};
  if (policy.filesystem !== "ephemeral" || policy.packageFilesystem !== "read-only") {
    throw new Error("执行策略不允许持久文件系统");
  }
  if ((policy.networkOrigins ?? []).length) {
    throw new Error("当前高安全集群默认禁网；请部署独立 egress 代理后再启用网络白名单");
  }
  return safeEntry(job);
}

async function execute(job) {
  if (running >= maximumConcurrency) throw new Error("Worker 已达到并发上限");
  const location = validate(job);
  const marker = (await readFile(join(location.root, ".integrity-sha256"), "utf8")).trim();
  if (marker !== job.package.integritySha256) throw new Error("Package 完整性校验失败");
  const cwd = await mkdtemp(join(tmpdir(), "xiaoluo-job-"));
  const executionId = `isolated_${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const state = {
    executionId,
    status: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    output: null,
    startedAt,
    completedAt: null,
    child: null,
  };
  executions.set(executionId, state);
  running += 1;
  try {
    const command =
      job.runtime === "node" ? "node" : job.runtime === "python" ? "python3" : location.entry;
    const args = job.runtime === "cli" ? job.args ?? [] : [location.entry, ...(job.args ?? [])];
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: cwd,
        TMPDIR: cwd,
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    state.child = child;
    const outputLimit = Math.min(2_000_000, Number(job.policy.outputBytes ?? 2_000_000));
    const append = (key, chunk) => {
      state[key] = `${state[key]}${chunk.toString("utf8")}`.slice(0, outputLimit);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    if (job.stdin) child.stdin.end(String(job.stdin));
    else child.stdin.end();
    const timeout = setTimeout(
      () => child.kill("SIGKILL"),
      Math.min(300_000, Math.max(2_000, Number(job.policy.wallTimeMs ?? 60_000))),
    );
    const exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    clearTimeout(timeout);
    state.exitCode = Number(exitCode);
    state.status = exitCode === 0 ? "succeeded" : "failed";
    state.completedAt = new Date().toISOString();
    try {
      state.output = state.stdout.trim() ? JSON.parse(state.stdout) : null;
    } catch {
      state.output = state.stdout;
    }
    return { ...state, child: undefined };
  } finally {
    running -= 1;
    state.child = null;
    await rm(cwd, { recursive: true, force: true });
  }
}

createServer(async (request, response) => {
  try {
    if (request.url === "/healthz") return json(response, 200, { ok: true, running });
    const body = await bodyOf(request);
    if (!authorized(request, body)) return json(response, 401, { error: "签名无效" });
    if (request.method === "POST" && request.url === "/v1/executions") {
      const result = await execute(JSON.parse(body));
      return json(response, 201, result);
    }
    const match = request.url?.match(/^\/v1\/executions\/([^/?]+)$/);
    if (match && request.method === "GET") {
      const state = executions.get(decodeURIComponent(match[1]));
      return state
        ? json(response, 200, { ...state, child: undefined })
        : json(response, 404, { error: "执行不存在" });
    }
    if (match && request.method === "DELETE") {
      const state = executions.get(decodeURIComponent(match[1]));
      if (!state) return json(response, 404, { error: "执行不存在" });
      state.child?.kill("SIGKILL");
      state.status = "canceled";
      state.completedAt = new Date().toISOString();
      return json(response, 200, { ...state, child: undefined });
    }
    return json(response, 404, { error: "路由不存在" });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "执行失败" });
  }
}).listen(port, "0.0.0.0", () => {
  process.stdout.write(`isolated-worker listening on ${port}\n`);
});
