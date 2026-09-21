export interface PluginRuntimeLaunchInput {
  url: string;
  workspaceId: string;
  packageId?: string | null;
  packageKey?: string | null;
  packageName?: string | null;
}

interface PluginRuntimeLaunchPayload {
  url?: string;
  error?: string;
  code?: string;
  retryable?: boolean;
}

interface LaunchPluginRuntimeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [0, 700, 1_800, 3_500] as const;

export class PluginRuntimeLaunchError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status: number; code?: string; retryable: boolean },
  ) {
    super(message);
    this.name = "PluginRuntimeLaunchError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function isRetryablePluginLaunchStatus(status: number) {
  return (
    status === 0 ||
    status === 401 ||
    status === 404 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function waitForRetry(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function readLaunchPayload(response: Response) {
  try {
    return (await response.json()) as PluginRuntimeLaunchPayload;
  } catch {
    return {} as PluginRuntimeLaunchPayload;
  }
}

export async function launchPluginRuntime(
  input: PluginRuntimeLaunchInput,
  options: LaunchPluginRuntimeOptions = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: PluginRuntimeLaunchError | null = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    options.signal?.throwIfAborted();
    await waitForRetry(retryDelaysMs[attempt] ?? 0, options.signal);

    try {
      const response = await fetchImpl("/api/v2/packages/runtime/launch", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": input.workspaceId,
        },
        body: JSON.stringify(input),
        signal: options.signal,
      });
      const payload = await readLaunchPayload(response);
      if (response.ok && payload.url) return payload.url;

      const retryable =
        payload.retryable === true ||
        isRetryablePluginLaunchStatus(response.status);
      lastError = new PluginRuntimeLaunchError(
        payload.error || `插件启动失败（HTTP ${response.status}）`,
        {
          status: response.status,
          code: payload.code,
          retryable,
        },
      );
      if (!retryable) throw lastError;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof PluginRuntimeLaunchError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else {
        lastError = new PluginRuntimeLaunchError(
          error instanceof Error ? error.message : "插件启动请求失败",
          { status: 0, retryable: true },
        );
      }
    }
  }

  throw (
    lastError ??
    new PluginRuntimeLaunchError("插件启动失败，请稍后重试", {
      status: 0,
      retryable: true,
    })
  );
}
