/**
 * 小逻大脑 · 长期记忆存储（模块三）
 * 跨对话记住老板的偏好 / 项目约定 / 反复出现的需求。
 * 一期落 localStorage（与对话存档同级），接口预留服务端替换位。
 */

export interface MemoryEntry {
  id: string;
  /** 记忆正文：一句简洁的陈述事实 */
  text: string;
  /** 来源：agent = 小逻主动记下；user = 老板手动添加 */
  source: string;
  updatedAt: number;
}

export interface MemoryStore {
  list(): Promise<MemoryEntry[]>;
  add(text: string, source?: string): Promise<MemoryEntry>;
  remove(id: string): Promise<void>;
}

/** 把记忆条目拼成系统提示词段落（空则返回空串） */
export function buildMemorySection(entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.text}`).join("\n");
  return `[长期记忆] 以下是你跨对话记住的事实（老板认可后才可修改/删除；新事实用 add_memory 工具记入）：\n${lines}`;
}

const STORAGE_KEY = "xiaoluo-brain-memory-v1";

export class LocalStorageMemoryStore implements MemoryStore {
  private read(): MemoryEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.filter((e) => e && typeof e.text === "string") : [];
    } catch {
      return [];
    }
  }

  private write(entries: MemoryEntry[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* 存储满/隐私模式：降级为本次会话内有效 */
    }
  }

  async list(): Promise<MemoryEntry[]> {
    return this.read();
  }

  async add(text: string, source = "agent"): Promise<MemoryEntry> {
    const entries = this.read();
    const entry: MemoryEntry = {
      id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text,
      source,
      updatedAt: Date.now(),
    };
    entries.push(entry);
    this.write(entries);
    return entry;
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((e) => e.id !== id));
  }
}
