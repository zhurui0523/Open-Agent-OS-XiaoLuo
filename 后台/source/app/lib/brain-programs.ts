/**
 * 小逻程序库 —— 用户程序的落盘存储层（仅服务端引用）。
 *
 * 结构：.data/brain-programs/{owner}/{程序文件夹}/(meta.json + 代码文件)
 *  - 一个程序一个文件夹，文件夹名即程序 id（时间戳-名称slug）
 *  - 同一对话的程序 upsert：write_code 每次成功即覆盖文件并 version+1，
 *    不会堆积大量文件夹（自动落盘策略 A）
 *  - 所有路径 resolve 后校验不越出程序目录，防遍历；文件数与总量受限
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  ProgramFile,
  ProgramMeta,
  ProgramRecord,
} from "../xiaoluo-brain/lib/brain/types";

const ROOT = path.join(process.cwd(), ".data", "brain-programs");
const MAX_FILES = 100;
const MAX_TOTAL_CHARS = 5 * 1024 * 1024;

/** 程序文件夹名白名单：Unicode 字母/数字 + 点横线下划线（无路径分隔符，中文程序名可用） */
const ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;

function ownerDir(owner: string): string {
  const safe = owner.replace(/[^A-Za-z0-9._-]/g, "_") || "anon";
  return path.join(ROOT, safe);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/** 程序名 → 文件夹 slug：去非法字符，中文保留 */
function slugify(name: string): string {
  const s = name
    .trim()
    .replace(/[\\/:*?"<>|.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return s || "program";
}

/** 相对路径安全化：resolve 后必须仍在 base 内，否则返回 null */
function safeResolve(base: string, rel: string): string | null {
  if (!rel || typeof rel !== "string" || path.isAbsolute(rel)) return null;
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function readMeta(programDir: string): Promise<ProgramMeta | null> {
  return fs
    .readFile(path.join(programDir, "meta.json"), "utf8")
    .then((text) => JSON.parse(text) as ProgramMeta)
    .catch(() => null);
}

/** 程序列表（只读 meta，不含文件内容；按更新时间倒序） */
export async function listPrograms(owner: string): Promise<ProgramMeta[]> {
  const base = ownerDir(owner);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ProgramMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
    const meta = await readMeta(path.join(base, entry.name));
    if (meta) out.push(meta);
  }
  out.sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1));
  return out;
}

export interface SaveProgramInput {
  name: string;
  entry?: string;
  files: ProgramFile[];
  conversationId: string;
  model?: string;
}

/**
 * 保存程序（upsert）：同一 conversationId 已有程序则覆盖文件 + version+1，
 * 否则新建文件夹。返回最新 meta。
 */
export async function saveProgram(
  owner: string,
  input: SaveProgramInput,
): Promise<ProgramMeta> {
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new Error("程序文件列表为空");
  if (files.length > MAX_FILES) throw new Error("文件数超过上限（100）");
  const totalChars = files.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
  if (totalChars > MAX_TOTAL_CHARS) throw new Error("程序总大小超过上限（5MB）");
  if (!input.conversationId || !input.conversationId.trim()) {
    throw new Error("conversationId 必填");
  }

  const base = ownerDir(owner);
  const existing = (await listPrograms(owner)).find(
    (m) => m.source?.conversationId === input.conversationId,
  );
  const now = new Date().toISOString();
  const id = existing?.id ?? stamp() + "-" + slugify(input.name || "");
  const dir = path.join(base, id);

  // 覆盖式落盘：先清理旧文件（保留目录本身），避免残留已删除的文件
  if (existing) {
    const oldEntries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of oldEntries) {
      if (e.name === "meta.json") continue;
      await fs.rm(path.join(dir, e.name), { recursive: true, force: true });
    }
  } else {
    await fs.mkdir(dir, { recursive: true });
  }

  for (const file of files) {
    const full = safeResolve(dir, file.path);
    if (!full) throw new Error("非法文件路径：" + file.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content ?? "", "utf8");
  }

  const meta: ProgramMeta = {
    id,
    name: (input.name || "").trim() || id,
    entry: input.entry || files[0].path,
    files: files.map((f) => ({
      path: f.path,
      language: f.language,
      chars: f.content?.length ?? 0,
    })),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
    source: { conversationId: input.conversationId },
    model: input.model,
  };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

/** 读单个程序全量：meta + 文件内容（文件缺失时跳过） */
export async function getProgram(
  owner: string,
  id: string,
): Promise<ProgramRecord | null> {
  if (!ID_PATTERN.test(id)) return null;
  const dir = path.join(ownerDir(owner), id);
  const meta = await readMeta(dir);
  if (!meta) return null;
  const contents: ProgramFile[] = [];
  for (const f of meta.files ?? []) {
    const full = safeResolve(dir, f.path);
    if (!full) continue;
    try {
      contents.push({ path: f.path, language: f.language, content: await fs.readFile(full, "utf8") });
    } catch {
      /* 文件缺失：跳过 */
    }
  }
  return { ...meta, contents };
}

/** 重命名程序（仅改 meta.name，文件夹不动，id 保持稳定） */
export async function renameProgram(
  owner: string,
  id: string,
  name: string,
): Promise<ProgramMeta | null> {
  if (!ID_PATTERN.test(id)) return null;
  const dir = path.join(ownerDir(owner), id);
  const meta = await readMeta(dir);
  if (!meta) return null;
  const next = (name || "").trim();
  if (!next) throw new Error("程序名不能为空");
  meta.name = next.slice(0, 60);
  meta.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

/** 删除程序（整个文件夹） */
export async function removeProgram(owner: string, id: string): Promise<boolean> {
  if (!ID_PATTERN.test(id)) return false;
  const dir = path.join(ownerDir(owner), id);
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}
