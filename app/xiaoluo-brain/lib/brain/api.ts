/**
 * 小逻 v3 —— 服务端连接层（路线图⑦落地：持久化迁服务端）
 *
 * 当前阶段小逻的连接服务统一走 http://127.0.0.1:3001（本地服务）。
 * 本文件提供 ChatStore / TaskStore 的 HTTP 实现，useChatAgent 挂载时替换默认
 * localStorage 实现即可：
 *
 *   useChatAgent(cid, adapters, {
 *     store: new HttpChatStore(),
 *     taskStore: new HttpTaskStore(),
 *   });
 *
 * 接口约定（服务端按此实现即可）：
 *   GET  /api/v2/chat/{conversationId}      → ChatPersistence JSON（404 = 无快照）
 *   PUT  /api/v2/chat/{conversationId}      ← ChatPersistence JSON
 *   GET  /api/v2/tasks                      → TaskRecord[] JSON
 *   PUT  /api/v2/tasks/{taskId}             ← TaskRecord JSON（upsert）
 *   DELETE /api/v2/tasks/{taskId}
 *
 * 降级策略：服务未启动/请求失败时静默降级（load 返回 null、save 丢弃），
 * 对话本身不受影响——持久化是增益不是前置条件。
 */

import type { ChatPersistence, ChatStore, CodeFile, ProgramMeta, ProgramRecord } from "./types";
import type { TaskRecord, TaskStore } from "./tasks";

/** 当前阶段连接服务基址（本地服务；切环境时构造传入覆盖） */
export const XIAOLUO_API_BASE = "http://127.0.0.1:3001";

export interface HttpStoreOptions {
  /** 服务基址（默认 XIAOLUO_API_BASE） */
  base?: string;
  /** 请求超时毫秒（默认 5000：本地服务慢请求不应阻塞对话） */
  timeoutMs?: number;
}

/** 带超时的 fetch（AbortController；超时/断网统一抛错由调用方降级） */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 对话持久化（HttpChatStore） ----------

export class HttpChatStore implements ChatStore {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts?: HttpStoreOptions) {
    this.base = (opts?.base ?? XIAOLUO_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts?.timeoutMs ?? 5000;
  }

  async load(conversationId: string): Promise<ChatPersistence | null> {
    try {
      const resp = await fetchWithTimeout(
        `${this.base}/api/v2/chat/${encodeURIComponent(conversationId)}`,
        { method: "GET" },
        this.timeoutMs,
      );
      if (resp.status === 404 || !resp.ok) return null;
      return (await resp.json()) as ChatPersistence;
    } catch {
      /* 服务未启动/断网：静默降级，从零开始对话 */
      return null;
    }
  }

  async save(conversationId: string, data: ChatPersistence): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.base}/api/v2/chat/${encodeURIComponent(conversationId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
        this.timeoutMs,
      );
    } catch {
      /* 上报失败不阻断对话；下次存档会再带上完整历史，天然自愈 */
    }
  }
}

// ---------- 任务档案（HttpTaskStore） ----------

export class HttpTaskStore implements TaskStore {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts?: HttpStoreOptions) {
    this.base = (opts?.base ?? XIAOLUO_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts?.timeoutMs ?? 5000;
  }

  async list(): Promise<TaskRecord[]> {
    try {
      const resp = await fetchWithTimeout(`${this.base}/api/v2/tasks`, { method: "GET" }, this.timeoutMs);
      if (!resp.ok) return [];
      const data = (await resp.json()) as TaskRecord[];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<TaskRecord | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }

  async save(record: TaskRecord): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.base}/api/v2/tasks/${encodeURIComponent(record.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        },
        this.timeoutMs,
      );
    } catch {
      /* 静默降级 */
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await fetchWithTimeout(`${this.base}/api/v2/tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }, this.timeoutMs);
    } catch {
      /* 静默降级 */
    }
  }
}

// ---------- 程序库（HttpProgramStore） ----------

/** 程序库保存入参（write_code 自动落盘与手动保存共用） */
export interface ProgramSaveInput {
  name: string;
  entry?: string;
  files: CodeFile[];
  conversationId: string;
  model?: string;
}

/** 程序库持久化口：失败一律静默降级（持久化是增益不是前置条件） */
export interface ProgramStore {
  list(): Promise<ProgramMeta[]>;
  get(id: string): Promise<ProgramRecord | null>;
  save(input: ProgramSaveInput): Promise<ProgramMeta | null>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class HttpProgramStore implements ProgramStore {
  private base: string;
  private timeoutMs: number;

  constructor(opts?: HttpStoreOptions) {
    this.base = (opts?.base ?? XIAOLUO_API_BASE).replace(/\/$/, "");
    this.timeoutMs = opts?.timeoutMs ?? 5000;
  }

  async list(): Promise<ProgramMeta[]> {
    try {
      const resp = await fetchWithTimeout(
        `${this.base}/api/v2/brain/programs`,
        { method: "GET" },
        this.timeoutMs,
      );
      if (!resp.ok) return [];
      const data = (await resp.json()) as ProgramMeta[];
      return Array.isArray(data) ? data : [];
    } catch {
      /* 服务未启动/断网：静默降级 */
      return [];
    }
  }

  async get(id: string): Promise<ProgramRecord | null> {
    try {
      const resp = await fetchWithTimeout(
        `${this.base}/api/v2/brain/programs/${encodeURIComponent(id)}`,
        { method: "GET" },
        this.timeoutMs,
      );
      if (!resp.ok) return null;
      return (await resp.json()) as ProgramRecord;
    } catch {
      return null;
    }
  }

  async save(input: ProgramSaveInput): Promise<ProgramMeta | null> {
    try {
      const resp = await fetchWithTimeout(
        `${this.base}/api/v2/brain/programs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        this.timeoutMs,
      );
      if (!resp.ok) return null;
      return (await resp.json()) as ProgramMeta;
    } catch {
      return null;
    }
  }

  async rename(id: string, name: string): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.base}/api/v2/brain/programs/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
        this.timeoutMs,
      );
    } catch {
      /* 静默降级 */
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await fetchWithTimeout(
        `${this.base}/api/v2/brain/programs/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        this.timeoutMs,
      );
    } catch {
      /* 静默降级 */
    }
  }
}
