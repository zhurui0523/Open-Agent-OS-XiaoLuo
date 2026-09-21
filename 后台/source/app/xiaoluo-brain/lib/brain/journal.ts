/**
 * 小逻 v3 —— 事件溯源 journal（路线图④：长周期任务的审计与折叠）
 *
 * 对齐 AgentCore journal fold：对话中每个关键动作 append-only 入账，
 * 用途：
 *  1. 审计回放：出问题时能还原"小逻当时干了什么"；
 *  2. 上下文折叠：历史太长时 fold() 压成摘要注入，替代逐条重放；
 *  3. 任务档案的原始素材（tasks.ts 从 journal 抽时间线）。
 *
 * 内存窗口 + IndexedDB 追加式落盘（学 Codex rollout：append-only 崩溃安全）：
 *  - bindTopic(topic) 后每次 append 异步追加写 IndexedDB（串行队列保序，失败静默）；
 *  - restoreTopic(topic) 重建历史账（刷新/崩溃恢复），seq 接续单调；
 *  - 每对话保留上限 PERSIST_LIMIT，超出懒淘汰最旧；
 *  - SSR/无 IndexedDB 环境自动降级为纯内存。
 */

export type JournalKind =
  | "turn_start" //   老板发消息（新一轮开始）
  | "turn_end" //     本轮结束（带步数/消耗/结局标记）
  | "tool_call" //    工具调用（name + 参数摘要）
  | "tool_result" //  工具结果（成功/失败 + 摘要）
  | "llm_error" //    LLM 中断/重试
  | "steer" //        老板中途插话
  | "ask" //          反问挂起
  | "answer" //       反问应答
  | "budget" //       预算事件（软顶提示/硬顶截断）
  | "assistant"; //   小逻对老板说的话（账本铁律：可见即留痕）

export interface JournalEntry {
  /** 会话内自增序号 */
  seq: number;
  ts: number;
  kind: JournalKind;
  /** 事件摘要（人可读，折叠与 UI 展示共用） */
  note: string;
  /** 结构化负载（审计回放用，保持小而扁） */
  payload?: Record<string, unknown>;
}

/** 账本容量上限：超出淘汰最旧（保留最近的活动窗口） */
const JOURNAL_LIMIT = 400;

// ---------- IndexedDB 追加式落盘（对话 topic 分区，append-only） ----------

const DB_NAME = "xiaoluo-journal-v1";
const STORE = "entries";
/** 每对话持久化上限：超出懒淘汰最旧（内存窗口之外的审计纵深） */
const PERSIST_LIMIT = 800;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("indexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("topic", "topic", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("open failed"));
    });
    dbPromise.catch(() => {
      dbPromise = null; // 打开失败不缓存，下次重试
    });
  }
  return dbPromise;
}

interface StoredEntry extends JournalEntry {
  topic: string;
}

async function persistEntry(topic: string, entry: JournalEntry): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ topic, ...entry } as StoredEntry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  // 懒淘汰：每 64 条检查一次，超出上限删最旧，避免每条都 count
  if (entry.seq % 64 !== 0) return;
  const rows = await readTopic(topic, PERSIST_LIMIT + 100);
  if (rows.length <= PERSIST_LIMIT) return;
  const excess = rows.slice(0, rows.length - PERSIST_LIMIT);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const idx = store.index("topic");
    for (const row of excess) {
      const req = idx.openCursor(IDBKeyRange.only(topic));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const v = cursor.value as StoredEntry & { id: number };
        if (v.seq === row.seq) cursor.delete();
        else cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("trim failed"));
  });
}

async function readTopic(topic: string, limit: number): Promise<StoredEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("topic").getAll(IDBKeyRange.only(topic));
    req.onsuccess = () => {
      const rows = (req.result as StoredEntry[]).sort((a, b) => a.seq - b.seq);
      resolve(rows.slice(-limit));
    };
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
}

export class Journal {
  private entries: JournalEntry[] = [];
  private seq = 0;
  /** 落盘分区（= conversationId）；未绑定时纯内存 */
  private topic: string | null = null;
  /** 串行写队列：保序 + 上一条失败不影响下一条 */
  private writeQueue: Promise<void> = Promise.resolve();

  /** 绑定落盘分区（对话 id）；之后的 append 追加写 IndexedDB */
  bindTopic(topic: string): void {
    this.topic = topic.trim() || null;
  }

  /**
   * 重建历史账（刷新/崩溃恢复）：仅当前账为空时灌入，seq 接续单调。
   * 返回恢复条数；无持久层/读取失败返回 0。
   */
  async restoreTopic(topic: string): Promise<number> {
    try {
      const rows = await readTopic(topic, JOURNAL_LIMIT);
      if (!rows.length || this.entries.length > 0) return 0;
      this.entries = rows.map(({ seq, ts, kind, note, payload }) => ({ seq, ts, kind, note, payload }));
      this.seq = this.entries[this.entries.length - 1]?.seq ?? 0;
      return this.entries.length;
    } catch {
      return 0;
    }
  }

  /** append-only 入账 */
  append(kind: JournalKind, note: string, payload?: Record<string, unknown>): void {
    this.seq += 1;
    const entry: JournalEntry = { seq: this.seq, ts: Date.now(), kind, note, payload };
    this.entries.push(entry);
    if (this.entries.length > JOURNAL_LIMIT) this.entries.shift();
    if (this.topic) {
      const topic = this.topic;
      this.writeQueue = this.writeQueue
        .then(() => persistEntry(topic, entry))
        .catch(() => {
          /* 落盘失败静默：内存账不受影响 */
        });
    }
  }

  all(): JournalEntry[] {
    return [...this.entries];
  }

  /** 最近 N 条（任务档案时间线用） */
  recent(n: number): JournalEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * fold：把全部事件折叠成一段紧凑摘要（长对话注入上下文用）。
   * 规则：工具调用按名聚合计数，其余事件取 note 串；总长受 maxChars 约束。
   */
  fold(maxChars = 1200): string {
    if (this.entries.length === 0) return "";
    const toolCounts = new Map<string, number>();
    const others: string[] = [];
    for (const e of this.entries) {
      if (e.kind === "tool_call") {
        const name = String(e.payload?.tool ?? "unknown");
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      } else if (e.kind === "turn_start" || e.kind === "turn_end" || e.kind === "budget") {
        others.push(e.note);
      }
    }
    const toolLine =
      toolCounts.size > 0
        ? `工具调用：${[...toolCounts.entries()].map(([k, v]) => `${k}×${v}`).join("、")}`
        : "";
    const text = [toolLine, ...others].filter(Boolean).join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  /** 序列化（宿主落盘/上报） */
  serialize(): JournalEntry[] {
    return this.all();
  }
}
