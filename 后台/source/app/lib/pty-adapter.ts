/**
 * 真 PTY 适配层（第 3 项追平 Codex 的 utils/pty）。
 *
 * 为什么不是直接 `import "node-pty"`：
 *  - 它是原生模块（Windows 走 ConPTY，POSIX 走 openpty），装不上就整个构建挂掉；
 *  - 小逻的 CI 是干净检出（`npm ci`），不想让门禁成败取决于原生编译工具链。
 * 所以这里做成"能力探测 + 惰性加载"：宿主装了 node-pty 就用真终端，没装就如实降级成
 * 现有管道会话（isatty=false），并把原因回流给老板，而不是假装有 PTY。
 */

export type PtyBackend = "conpty" | "openpty" | "none";

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
  /** 只关输入不杀进程（npm 这类等 EOF 才收尾的程序用） */
  end?(): void;
}

export interface PtyProbe {
  available: boolean;
  backend: PtyBackend;
  /** 不可用/降级时给小逻看的原因，别静默 */
  reason?: string;
}

interface NodePtyLike {
  spawn(file: string, args: string[], opts: Record<string, unknown>): {
    pid: number;
    write(data: string): void;
    onData(cb: (chunk: string) => void): void;
    onExit(cb: (e: { exitCode: number }) => void): void;
    kill(signal?: string): void;
  };
}

let cached: NodePtyLike | null | undefined;
/** 最近一次 PTY 失败原因（不吞异常：给 probe / 工具结果一个可追溯的旁证） */
let lastPtyError: string | null = null;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 惰性加载 node-pty：用原生 import 的字符串形式，避开打包器把它当硬依赖 */
export async function loadNodePty(): Promise<NodePtyLike | null> {
  if (cached !== undefined) return cached;
  try {
    const importer = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
    const mod = (await importer("node-pty")) as { default?: NodePtyLike } & NodePtyLike;
    const candidate = (mod.default ?? mod) as NodePtyLike;
    cached = typeof candidate?.spawn === "function" ? candidate : null;
    if (!cached) lastPtyError = "node-pty 导出了，但没有 spawn 方法（版本不兼容）";
  } catch (error) {
    cached = null;
    lastPtyError = describe(error);
  }
  return cached;
}

/** 最近一次 PTY 失败原因（供 probe 与工具结果引用；null = 没失败过） */
export function lastPtyErrorReason(): string | null {
  return lastPtyError;
}

/** 探测当前机器能不能开真 PTY（不实际起进程） */
export async function probePty(): Promise<PtyProbe> {
  const backend: PtyBackend = process.platform === "win32" ? "conpty" : "openpty";
  const mod = await loadNodePty();
  if (mod) return { available: true, backend };
  return {
    available: false,
    backend: "none",
    reason:
      "没装 node-pty，真终端不可用；已退化为管道会话（isatty=false）。要真 PTY 请在宿主执行 npm i node-pty（需要本机编译工具链或预编译包）。",
  };
}

/** 开一个真 PTY 进程；模块缺失或起进程失败返回 null（调用方按降级处理） */
export async function openPty(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number },
  loader: () => Promise<NodePtyLike | null> = loadNodePty,
): Promise<PtyHandle | null> {
  const mod = await loader();
  if (!mod) return null;
  try {
    const term = mod.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: opts.env,
      // Windows 上 ConPTY 需要 utf8；POSIX 直接用环境里的 LANG
      ...(process.platform === "win32" ? { useConpty: true } : {}),
    });
    return {
      pid: term.pid,
      write: (data) => term.write(data),
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit((e) => cb(e.exitCode)),
      kill: () => {
        try {
          term.kill();
        } catch (error) {
          lastPtyError = "kill 失败（进程可能已退出）：" + describe(error);
        }
      },
      end: () => {
        // node-pty 没有 stdin.end：关输入靠发 EOF 字节
        try {
          term.write("\u0004");
        } catch (error) {
          lastPtyError = "发送 EOF 失败（进程可能已退出）：" + describe(error);
        }
      },
    };
  } catch (error) {
    lastPtyError = "起 PTY 进程失败：" + describe(error);
    return null;
  }
}

/** 测试用：清掉模块缓存，模拟"装了/没装 node-pty"的两种机器 */
export function resetPtyCacheForTests(): void {
  cached = undefined;
  lastPtyError = null;
}
