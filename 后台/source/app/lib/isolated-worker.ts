import { createHmac } from "node:crypto";

export type IsolatedRuntime = "node" | "python" | "cli";
export type IsolatedExecutionStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface IsolatedExecutionPolicy {
  memoryMb: number;
  cpuMs: number;
  wallTimeMs: number;
  networkOrigins: string[];
  filesystem: "ephemeral";
  packageFilesystem: "read-only";
  processLimit: number;
  outputBytes: number;
}
export interface IsolatedExecutionRequest {
  jobId: string;
  package: {
    id: string;
    key: string;
    version: string;
    integritySha256: string;
    entry: string;
  };
  runtime: IsolatedRuntime;
  args: string[];
  stdin: string | null;
  secretRefIds: string[];
  policy: IsolatedExecutionPolicy;
}

export interface IsolatedExecutionResult {
  executionId: string;
  status: IsolatedExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

function integerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function workerConfig() {
  const endpoint = process.env.ISOLATED_WORKER_ENDPOINT?.trim();
  const token = process.env.ISOLATED_WORKER_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Response(
      JSON.stringify({ error: "隔离 Worker 集群尚未绑定" }),
      {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ISOLATED_WORKER_ENDPOINT 无效");
  }
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new Error("隔离 Worker 必须使用 HTTPS");
  }
  return {
    endpoint: url.toString().replace(/\/+$/, ""),
    token,
    timeoutMs: integerEnv(
      "ISOLATED_WORKER_TIMEOUT_MS",
      20_000,
      2_000,
      60_000,
    ),
  };
}

export async function probeIsolatedWorker() {
  const config = workerConfig();
  const startedAt = Date.now();
  const response = await fetch(`${config.endpoint}/healthz`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 8_000)),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    running?: number;
  };
  return {
    ok: response.ok && payload.ok === true,
    endpointOrigin: new URL(config.endpoint).origin,
    running: Number(payload.running) || 0,
    latencyMs: Date.now() - startedAt,
  };
}

export function isolatedExecutionPolicy(
  networkOrigins: string[],
): IsolatedExecutionPolicy {
  const safeOrigins = Array.from(
    new Set(
      networkOrigins.flatMap((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" ? [url.origin] : [];
        } catch {
          return [];
        }
      }),
    ),
  ).slice(0, 20);
  return {
    memoryMb: integerEnv(
      "ISOLATED_WORKER_MAX_MEMORY_MB",
      512,
      64,
      2_048,
    ),
    cpuMs: integerEnv(
      "ISOLATED_WORKER_MAX_CPU_MS",
      30_000,
      1_000,
      120_000,
    ),
    wallTimeMs: integerEnv(
      "ISOLATED_WORKER_MAX_WALL_MS",
      60_000,
      2_000,
      300_000,
    ),
    networkOrigins: safeOrigins,
    filesystem: "ephemeral",
    packageFilesystem: "read-only",
    processLimit: 16,
    outputBytes: 2_000_000,
  };
}

function signedHeaders(
  body: string,
  token: string,
): Record<string, string> {
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", token)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-xiaoluo-timestamp": timestamp,
    "x-xiaoluo-signature": signature,
  };
}

async function workerRequest<T>(
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
) {
  const config = workerConfig();
  const body = init.body === undefined ? "" : JSON.stringify(init.body);
  const response = await fetch(`${config.endpoint}${path}`, {
    method: init.method,
    headers: signedHeaders(body, config.token),
    ...(body ? { body } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const text = await response.text();
  if (text.length > 2_000_000) {
    throw new Error("隔离 Worker 返回内容超过 2 MB");
  }
  const payload = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error ??
        `隔离 Worker 请求失败（${response.status}）`,
    );
  }
  return payload;
}

function normalizeStatus(value: unknown): IsolatedExecutionStatus {
  return value === "queued" ||
    value === "dispatched" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
    ? value
    : "running";
}

function normalizeResult(
  value: Partial<IsolatedExecutionResult> & { id?: string },
): IsolatedExecutionResult {
  const executionId =
    typeof value.executionId === "string"
      ? value.executionId
      : typeof value.id === "string"
        ? value.id
        : "";
  if (!executionId) throw new Error("隔离 Worker 未返回 executionId");
  return {
    executionId,
    status: normalizeStatus(value.status),
    exitCode: Number.isInteger(value.exitCode) ? Number(value.exitCode) : null,
    stdout: typeof value.stdout === "string" ? value.stdout.slice(0, 1_000_000) : "",
    stderr: typeof value.stderr === "string" ? value.stderr.slice(0, 1_000_000) : "",
    output: value.output ?? null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    completedAt:
      typeof value.completedAt === "string" ? value.completedAt : null,
  };
}

export async function submitIsolatedExecution(
  request: IsolatedExecutionRequest,
) {
  const payload = await workerRequest<
    Partial<IsolatedExecutionResult> & { id?: string }
  >("/v1/executions", { method: "POST", body: request });
  return normalizeResult(payload);
}

export async function inspectIsolatedExecution(executionId: string) {
  const payload = await workerRequest<
    Partial<IsolatedExecutionResult> & { id?: string }
  >(`/v1/executions/${encodeURIComponent(executionId)}`, { method: "GET" });
  return normalizeResult(payload);
}

export async function cancelIsolatedExecution(executionId: string) {
  const payload = await workerRequest<
    Partial<IsolatedExecutionResult> & { id?: string }
  >(`/v1/executions/${encodeURIComponent(executionId)}`, {
    method: "DELETE",
  });
  return normalizeResult(payload);
}
