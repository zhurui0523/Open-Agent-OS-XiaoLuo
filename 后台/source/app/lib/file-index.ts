/**
 * 文件索引 / 变更监听（第 7.7 项，学 Codex `fuzzy_file_search.rs` + `file-watcher`）
 *
 * 原来只有"每次全盘走一遍 + 正则匹配文件名"（`findSandboxFiles`）：大仓库慢，且只能精确正则。
 * 这里补两层：
 *   1. 工作区路径索引（跳过 node_modules/.git/dist 等），TTL 内复用；
 *   2. 模糊打分（basename 精确 > 前缀 > 子串 > 路径子串 > 子序列），按分数排序；
 *   3. fs.watch 变更即失效（防抖），下次检索自动重建；监听器 unref，不拖住进程。
 *
 * 边界：没有倒排/向量索引，索引是一次目录遍历；单工作区超过 maxFiles 会截断并标记 truncated。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "node:fs";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "dist2", "build", "out", "coverage",
  ".venv", "venv", "__pycache__", ".cache", ".idea", ".vscode", "target", "vendor",
]);
const MAX_FILES_DEFAULT = 20_000;
const TTL_MS_DEFAULT = 30_000;

export interface FileIndexSnapshot {
  root: string;
  paths: string[];
  truncated: boolean;
  builtAt: number;
  /** 建索引的本钱：遍历了多少目录/文件（排查"为什么慢"用） */
  scanned: number;
  /** 读不了的目录数（权限/瞬时锁），跳过但不影响其它分支 */
  skippedDirs: number;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** 目录遍历：不跟符号链接（防环），跳过常见产物目录，超过上限即停 */
export async function walkWorkspace(root: string, maxFiles = MAX_FILES_DEFAULT): Promise<FileIndexSnapshot> {
  const paths: string[] = [];
  let scanned = 0;
  let skippedDirs = 0;
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // 单个目录读不了（权限/瞬时锁）：计数后跳过，不影响其它分支
      skippedDirs += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      scanned += 1;
      if (paths.length >= maxFiles) {
        truncated = true;
        break;
      }
      paths.push(toPosix(path.relative(root, full)));
    }
    if (truncated) break;
  }
  return { root, paths, truncated, builtAt: Date.now(), scanned, skippedDirs };
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j += 1) {
    if (text[j] === query[i]) i += 1;
  }
  return i === query.length;
}

/**
 * 单个路径的模糊分：分档清晰，便于解释"为什么它排前面"。
 * 100 basename 全等 / 90 basename 前缀 / 80 basename 子串 / 70 路径子串 / 40 子序列
 */
export function scoreFilePath(query: string, relPath: string): number {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  const rel = relPath.toLowerCase();
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === q) return 100;
  if (base.startsWith(q)) return 90 + Math.max(0, 5 - (base.length - q.length) / 20);
  if (base.includes(q)) return 80;
  if (rel.includes(q)) return 70;
  if (q.length >= 3 && isSubsequence(q, rel)) return 40;
  return 0;
}

export interface FileSearchHit {
  path: string;
  score: number;
}

export function searchSnapshot(snapshot: FileIndexSnapshot, query: string, limit = 20, prefix?: string): FileSearchHit[] {
  const cap = Math.min(Math.max(limit, 1), 200);
  const normPrefix = prefix ? toPosix(prefix).replace(/^\.\//, "").replace(/\/$/, "") : "";
  const hits: FileSearchHit[] = [];
  for (const rel of snapshot.paths) {
    if (normPrefix && !rel.startsWith(normPrefix + "/") && rel !== normPrefix) continue;
    const score = scoreFilePath(query, rel);
    if (score <= 0) continue;
    hits.push({ path: rel, score });
    if (hits.length >= cap * 4) break; // 先收一批再排序，避免大仓库全量排序
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits.slice(0, cap);
}

export interface WorkspaceFileIndex {
  root: string;
  /** 检索（必要时先重建索引） */
  search(query: string, opts?: { limit?: number; path?: string }): Promise<{ hits: FileSearchHit[]; truncated: boolean; builtAt: number; fromCache: boolean }>;
  /** 强制重建 */
  refresh(): Promise<FileIndexSnapshot>;
  /** 读当前快照（不重建；测试/诊断用） */
  snapshot(): FileIndexSnapshot | null;
  /** 开始监听变更（幂等）；返回是否真的挂上了监听 */
  watch(): boolean;
  close(): Promise<void>;
}

export async function createWorkspaceFileIndex(
  root: string,
  opts?: { maxFiles?: number; ttlMs?: number },
): Promise<WorkspaceFileIndex> {
  const maxFiles = opts?.maxFiles ?? MAX_FILES_DEFAULT;
  const ttlMs = opts?.ttlMs ?? TTL_MS_DEFAULT;
  let snap: FileIndexSnapshot | null = null;
  let dirty = true;
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    snap = await walkWorkspace(root, maxFiles);
    dirty = false;
    return snap;
  };

  const search = async (query: string, searchOpts?: { limit?: number; path?: string }) => {
    const cached = Boolean(snap && !dirty && Date.now() - (snap as FileIndexSnapshot).builtAt <= ttlMs);
    if (!cached) await refresh();
    const current = snap as FileIndexSnapshot;
    return {
      hits: searchSnapshot(current, query, searchOpts?.limit ?? 20, searchOpts?.path),
      truncated: current.truncated,
      builtAt: current.builtAt,
      fromCache: cached,
    };
  };

  const startWatch = (): boolean => {
    if (watcher) return true;
    try {
      watcher = watch(root, { recursive: true }, () => {
        dirty = true;
        if (debounce) clearTimeout(debounce);
        // 防抖：一次批量写会连发几十个事件，只标脏并在 300ms 后允许下次检索重建
        debounce = setTimeout(() => {
          debounce = null;
        }, 300);
        if (debounce && typeof debounce.unref === "function") debounce.unref();
      });
      watcher.on("error", () => {
        // 监听失败（句柄上限/不支持的平台）不能让索引不可用：退回 TTL 轮询
        watcher = null;
        dirty = true;
      });
      if (typeof (watcher as { unref?: () => void }).unref === "function") (watcher as { unref: () => void }).unref();
      return true;
    } catch {
      // 平台不支持递归 watch：仍然可用，靠 TTL 过期重建
      watcher = null;
      return false;
    }
  };

  return {
    root,
    async search(query, searchOpts) {
      return await search(query, searchOpts);
    },
    refresh,
    snapshot: () => snap,
    watch: startWatch,
    async close() {
      if (debounce) clearTimeout(debounce);
      debounce = null;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      snap = null;
      dirty = true;
    },
  };
}

// ---------- 按工作区根复用的注册表（服务端 fs 口用；桌面端有自己的实例） ----------

type IndexRegistry = Map<string, WorkspaceFileIndex>;
const REGISTRY_KEY = "__xiaoluoWorkspaceFileIndexes";

function registry(): IndexRegistry {
  const g = globalThis as unknown as { [REGISTRY_KEY]?: IndexRegistry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY];
}

/** 取（或建）该工作区的索引并挂上监听；同根复用，避免每次调用全量遍历 */
export async function workspaceFileIndexFor(root: string): Promise<WorkspaceFileIndex> {
  const reg = registry();
  const existing = reg.get(root);
  if (existing) {
    existing.watch();
    return existing;
  }
  const idx = await createWorkspaceFileIndex(root);
  idx.watch();
  reg.set(root, idx);
  return idx;
}

/** 测试用：关掉全部索引监听 */
export async function resetWorkspaceFileIndexesForTests(): Promise<void> {
  const reg = registry();
  for (const idx of reg.values()) await idx.close();
  reg.clear();
}
