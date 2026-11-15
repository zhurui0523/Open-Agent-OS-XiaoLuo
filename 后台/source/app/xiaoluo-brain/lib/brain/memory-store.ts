/**
 * 小逻大脑 · 长期记忆存储（模块三）
 * 跨对话记住老板的偏好 / 项目约定 / 反复出现的需求。
 * 一期落 localStorage（与对话存档同级），接口预留服务端替换位。
 */

export interface MemoryEntry {
  id: string;
  /** 记忆正文：一句简洁的陈述事实 */
  text: string;
  /** 来源：agent = 小逻主动记下；user = 老板手动添加；auto = 轮末流水线自动抽取 */
  source: string;
  updatedAt: number;
  /** 使用计数（注入后在对话中真实被引用才 +1，注入段按它排序截断） */
  usageCount?: number;
  /** 最近一次被真实引用的时刻 */
  lastUsedAt?: number;
}

export interface MemoryStore {
  list(): Promise<MemoryEntry[]>;
  add(text: string, source?: string): Promise<MemoryEntry>;
  remove(id: string): Promise<void>;
  /** 使用记账（可选实现）：记忆在对话中被真实引用时调用，usage 排序依据 */
  touch?(id: string): Promise<void>;
}

/** 注入段最多展示条数：超出按 usage 排序截断（旧的没用过的先沉底） */
const MEMORY_SECTION_LIMIT = 30;

/**
 * 敏感信息脱敏：记忆是长期存储，密钥/口令类内容绝不落账（命中即抹掉）。
 * 覆盖：OpenAI 风格密钥、AKIA 访问键、JWT、GitHub 令牌、私钥块、口令赋值、Bearer 令牌。
 */
export function sanitizeMemoryText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[sS]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[已脱敏:私钥]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[已脱敏:密钥]")
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, "[已脱敏:访问密钥]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[已脱敏:令牌]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[已脱敏:令牌]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "bearer [已脱敏:令牌]")
    .replace(/(password|passwd|pwd|secret|api_?key|access_?token)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi, "$1$2[已脱敏]");
}

/** 归一化键：忽略大小写与空白差异的重复判定依据 */
function normalizeMemoryKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 记忆去重判定：与既有条目完全一致、去空白后一致或互为包含 → 视为重复 */
export function isDuplicateMemory(text: string, existing: MemoryEntry[]): boolean {
  const key = normalizeMemoryKey(text);
  if (!key) return true;
  const keyNoWs = key.replace(/\s/g, "");
  return existing.some((e) => {
    const k = normalizeMemoryKey(e.text);
    if (k === key) return true;
    const kNoWs = k.replace(/\s/g, "");
    if (kNoWs && kNoWs === keyNoWs) return true;
    return key.length >= 8 && (k.includes(key) || key.includes(k));
  });
}

/** 把记忆条目拼成系统提示词段落（空则返回空串）：按真实使用次数排（同分看最近使用），超量截断 */
export function buildMemorySection(entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  const ranked = [...entries].sort((a, b) => {
    const ua = a.usageCount ?? 0;
    const ub = b.usageCount ?? 0;
    if (ub !== ua) return ub - ua;
    return (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt);
  });
  const picked = ranked.slice(0, MEMORY_SECTION_LIMIT);
  const lines = picked.map((e) => `- ${e.text}`).join("\n");
  const omitted = ranked.length - picked.length;
  const tail = omitted > 0 ? `\n（另有 ${omitted} 条较少使用的记忆未展示；需要时让老板补充或用 add_memory 修正）` : "";
  return `[长期记忆] 以下是你跨对话记住的事实（老板认可后才可修改/删除；新事实用 add_memory 工具记入）：\n${lines}${tail}`;
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

  async touch(id: string): Promise<void> {
    const entries = this.read();
    const target = entries.find((e) => e.id === id);
    if (!target) return;
    target.usageCount = (target.usageCount ?? 0) + 1;
    target.lastUsedAt = Date.now();
    this.write(entries);
  }
}

// ---------- 混合记忆存储（B5：本地真相 + 服务端镜像） ----------

/** 记忆镜像口（HttpMemoryMirror 实现；未接入则纯本地） */
export interface MemoryMirror {
  pull(): Promise<MemoryEntry[] | null>;
  push(entries: MemoryEntry[]): Promise<void>;
}

/**
 * 混合记忆存储（B5 服务端持久化增强）：
 *  - 本地 localStorage 是真相源，读写即时；
 *  - 每次变更后台推服务端镜像（失败静默，不阻塞对话）；
 *  - 首次使用时若本地为空而服务端有档 → 按 id 并集回填（换设备/清缓存不丢记忆）。
 */
export class HybridMemoryStore implements MemoryStore {
  private readonly local: LocalStorageMemoryStore;
  private readonly mirror?: MemoryMirror;
  private backfilled = false;

  constructor(mirror?: MemoryMirror) {
    this.local = new LocalStorageMemoryStore();
    this.mirror = mirror;
  }

  /** 首次拉取回填：本地空、服务端有 → 灌入本地；之后不再拉（本地为真相） */
  private async ensureBackfill(): Promise<void> {
    if (this.backfilled || !this.mirror) return;
    this.backfilled = true;
    try {
      if ((await this.local.list()).length > 0) return;
      const remote = await this.mirror.pull();
      if (remote && remote.length) {
        for (const e of remote) {
          await this.local.add(e.text, e.source || "agent");
        }
        await this.mirror.push(await this.local.list());
      }
    } catch {
      /* 回填失败静默：本地从零起步，与无镜像时行为一致 */
    }
  }

  private sync(): void {
    if (!this.mirror) return;
    void this.local.list().then((all) => this.mirror?.push(all)).catch(() => undefined);
  }

  async list(): Promise<MemoryEntry[]> {
    void this.ensureBackfill();
    return this.local.list();
  }

  async add(text: string, source?: string): Promise<MemoryEntry> {
    await this.ensureBackfill();
    const entry = await this.local.add(text, source);
    this.sync();
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.local.remove(id);
    this.sync();
  }

  async touch(id: string): Promise<void> {
    await this.local.touch(id);
    // usage 记账频率高：只落本地，镜像随下次 add/remove 一并推，省请求
  }
}
