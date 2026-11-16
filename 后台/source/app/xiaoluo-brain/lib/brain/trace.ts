/**
 * 可观测性（第 7.12 项，学 Codex `otel` 的 span 模型，落成本地 JSONL）
 *
 * 目标不是接 OTLP collector，而是让"这一轮慢在哪、哪个工具在拖"可查：
 *   - 每轮一个 traceId，工具调用与模型调用各一个 span（父 span = 轮）；
 *   - span 只记元信息（工具名、参数体积、耗时、状态、token 数），**绝不记消息正文/命令/output**；
 *   - 默认关闭：设置 `XIAOLUO_TRACE_DIR` 才落盘（目录下按天 JSONL，超过 8MB 轮转一份 .1）；
 *   - 写失败不拖垮对话：错误只累加计数，导出 `traceStats()` 供诊断。
 *
 * 边界：不是 OTel 协议（没有 OTLP 导出、没有 trace 后端），时间精度毫秒；跨进程不串。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface TraceSpanInput {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  startTimeMs: number;
  durationMs: number;
  status: "ok" | "error" | "aborted";
  attributes?: Record<string, string | number | boolean | undefined>;
}

export interface TraceSpan extends TraceSpanInput {
  service: "xiaoluo-brain";
  endTimeMs: number;
}

const stats = { enabled: false, written: 0, writeErrors: 0, dropped: 0 };
const writeChain = new Map<string, Promise<void>>();
const pendingWrites = new Set<Promise<void>>();
let dirReady: Promise<void> | null = null;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function tracesEnabled(): boolean {
  const dir = process.env.XIAOLUO_TRACE_DIR;
  stats.enabled = Boolean(dir && dir.trim());
  return stats.enabled;
}

export function traceStats(): typeof stats {
  return { ...stats };
}

export function newTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** 清掉属性里的大对象/敏感字段：只留标量，字符串截 200 字 */
function sanitizeAttributes(attrs?: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "number") out[key] = Number.isFinite(value) ? value : 0;
    else if (typeof value === "boolean") out[key] = value;
    else out[key] = String(value).slice(0, 200);
  }
  return out;
}

/** 追加一行 span；按天分文件，超限轮转。失败只计数，不抛。 */
export async function recordSpan(span: TraceSpan): Promise<void> {
  if (!tracesEnabled()) return;
  const dir = process.env.XIAOLUO_TRACE_DIR as string;
  const day = new Date(span.startTimeMs).toISOString().slice(0, 10);
  const file = path.join(dir, "trace-" + day + ".jsonl");
  try {
    if (!dirReady) dirReady = fs.mkdir(dir, { recursive: true }).then(() => undefined);
    await dirReady;
    const st = await fs.stat(file).catch(() => null);
    if (st && st.size > MAX_FILE_BYTES) {
      await fs.rename(file, file + ".1").catch(() => {
        stats.writeErrors += 1;
      });
    }
  } catch {
    stats.writeErrors += 1;
    return;
  }
  const previous = writeChain.get(file) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await fs.appendFile(file, JSON.stringify(span) + "\n", "utf8");
      stats.written += 1;
    })
    .catch(() => {
      stats.writeErrors += 1;
    });
  writeChain.set(file, next);
  await next;
}

export interface ActiveSpan {
  traceId: string;
  spanId: string;
  end(status: "ok" | "error" | "aborted", attributes?: Record<string, string | number | boolean | undefined>): void;
}

/** 开一个 span；end() 幂等（重复调用忽略） */
export function startSpan(
  name: string,
  opts?: { traceId?: string; parentId?: string; attributes?: Record<string, string | number | boolean | undefined> },
): ActiveSpan {
  const traceId = opts?.traceId ?? newTraceId();
  const spanId = newSpanId();
  const startTimeMs = Date.now();
  let ended = false;
  return {
    traceId,
    spanId,
    end(status, attributes) {
      if (ended) return;
      ended = true;
      const span: TraceSpan = {
        service: "xiaoluo-brain",
        traceId,
        spanId,
        ...(opts?.parentId ? { parentId: opts.parentId } : {}),
        name,
        startTimeMs,
        durationMs: Date.now() - startTimeMs,
        endTimeMs: Date.now(),
        status,
        attributes: sanitizeAttributes({ ...opts?.attributes, ...attributes }),
      };
      const pending = recordSpan(span);
      pendingWrites.add(pending);
      void pending.finally(() => {
        pendingWrites.delete(pending);
      });
    },
  };
}

/** 清空写入队列（测试用：保证落盘后再读文件） */
export async function flushTracesForTests(): Promise<void> {
  await Promise.all(Array.from(pendingWrites));
  await Promise.all(Array.from(writeChain.values()));
  writeChain.clear();
}

/** 测试用：重置统计与目录缓存 */
export function resetTraceStateForTests(): void {
  stats.enabled = false;
  stats.written = 0;
  stats.writeErrors = 0;
  stats.dropped = 0;
  writeChain.clear();
  pendingWrites.clear();
  dirReady = null;
}
