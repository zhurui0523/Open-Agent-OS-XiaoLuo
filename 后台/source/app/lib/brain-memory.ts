/**
 * 小逻 v3 —— 服务端长期记忆存储（.data/brain-memory/{userId}.json）
 *
 * 这份档原来只有 /api/v2/memory 一条路由在用：浏览器宿主把 localStorage 当真相源，
 * 后台把整份数组推上来做镜像（client owns merge）。app-server 化之后，跑在服务进程里的
 * 小逻也要读写同一份记忆，于是把读写本身抽到这里，路由与 Node 端口共用一份实现：
 *  - 路由只剩鉴权、限流、把数组当整包读写（HttpMemoryMirror 的 GET/PUT 契约不变）；
 *  - FileMemoryStore 的语义与 LocalStorageMemoryStore 逐字对齐（同 id 方案、同字段、
 *    add 不自行去重）——去重是引擎的事（execAddMemory 先 sanitize，轮末抽取才查重），
 *    存储层自己发明一套语义，两种宿主的小逻就会记出不一样的账。
 *
 * 变更一律过 per-user 串行队列：同进程里 add_memory 与轮末自动抽取会撞同一份文件。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryEntry, MemoryStore } from "../xiaoluo-brain/lib/brain/memory-store";

const DATA_DIR = path.join(process.cwd(), ".data", "brain-memory");

/** 落盘路径：owner 只留文件名安全字符，前导点一并换掉（id 恰好是 ".." 时会穿到上一级） */
function memoryPath(userId: string): string {
  const owner = String(userId ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_");
  return path.join(DATA_DIR, (owner || "_") + ".json");
}

function toEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is MemoryEntry => Boolean(e) && typeof (e as MemoryEntry).text === "string",
  );
}

/** 读整份记忆档；没有档 = 空列表（路由要区分 404，故另给 readMemoryText） */
export async function readMemoryEntries(userId: string): Promise<MemoryEntry[]> {
  try {
    return toEntries(JSON.parse(await fs.readFile(memoryPath(userId), "utf8")));
  } catch {
    return [];
  }
}

/** 路由 GET 用：原样交出文件文本，没有档返回 null（404 语义留给路由） */
export async function readMemoryText(userId: string): Promise<string | null> {
  try {
    return await fs.readFile(memoryPath(userId), "utf8");
  } catch {
    return null;
  }
}

/** 整包写入（镜像推送走这里：客户端持有合并权） */
export async function writeMemoryEntries(userId: string, entries: MemoryEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(memoryPath(userId), JSON.stringify(entries, null, 2), "utf8");
}

/** 变更串行队列：同一用户的读-改-写不交错，后一次不会把前一次的条目抹掉 */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const key = memoryPath(userId);
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  // 尾巴挂一个永不 reject 的占位：某次写失败不能把后续变更全带崩
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export class FileMemoryStore implements MemoryStore {
  constructor(private readonly userId: string) {}

  async list(): Promise<MemoryEntry[]> {
    return readMemoryEntries(this.userId);
  }

  async add(text: string, source = "agent"): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      source,
      updatedAt: Date.now(),
    };
    return serialized(this.userId, async () => {
      const entries = await readMemoryEntries(this.userId);
      entries.push(entry);
      await writeMemoryEntries(this.userId, entries);
      return entry;
    });
  }

  async remove(id: string): Promise<void> {
    await serialized(this.userId, async () => {
      const entries = await readMemoryEntries(this.userId);
      await writeMemoryEntries(
        this.userId,
        entries.filter((e) => e.id !== id),
      );
    });
  }

  async touch(id: string): Promise<void> {
    await serialized(this.userId, async () => {
      const entries = await readMemoryEntries(this.userId);
      const target = entries.find((e) => e.id === id);
      if (!target) return;
      target.usageCount = (target.usageCount ?? 0) + 1;
      target.lastUsedAt = Date.now();
      await writeMemoryEntries(this.userId, entries);
    });
  }
}
