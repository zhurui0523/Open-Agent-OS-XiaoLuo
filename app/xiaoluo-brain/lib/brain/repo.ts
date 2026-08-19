/**
 * 小逻 v3 —— 仓库上下文（代码能力三期：仓库级工程）
 *
 * 架构立场：
 *  - 仓库读取是代码任务的"备料"：由宿主在拼 write_code 提示词前调用，
 *    ChatAgent 循环本身不感知。
 *  - 本文件只定义契约与纯函数：适配器按契约实现（本地目录 / git 仓库 /
 *    用户上传的项目 zip 均可），不实现则三期降级为一期行为（只写新代码）。
 *
 * token 纪律：仓库上下文注入 Skill 提示词前必须裁剪（树摘要 + 关键文件截断），
 * 防大仓库把上下文撑爆——裁剪预算见 REPO_CONTEXT_LIMITS。
 */

import type { CodeArtifact, CodeFile } from "./types";

// ---------- 仓库口契约（适配器实现此口） ----------

export interface RepoFileEntry {
  /** 相对路径（统一 / 分隔符） */
  path: string;
  sizeBytes: number;
}

export interface RepoTree {
  /** 仓库根名（展示用，如 my-app） */
  root: string;
  /** 文件清单（已排除 node_modules/.git/dist 等噪音目录） */
  files: RepoFileEntry[];
}

export interface RepoFileContent {
  path: string;
  content: string;
  /** 内容被截断（超长文件只取头部） */
  truncated?: boolean;
}

/** 仓库适配器口：runNodes 适配器在代码节点"需要既有代码"时调用 */
export interface RepoAdapter {
  /** 列出文件树（实现方负责过滤噪音目录与二进制文件） */
  listTree(): Promise<RepoTree>;
  /** 读取指定文件内容（不存在的 path 跳过，不抛错） */
  readFiles(paths: string[]): Promise<RepoFileContent[]>;
}

/** 上下文注入预算（防大仓库撑爆 Skill 提示词） */
export const REPO_CONTEXT_LIMITS = {
  /** 树摘要最多展示的文件条数（超出折叠为统计行） */
  maxTreeEntries: 80,
  /** 单次最多读取的文件数 */
  maxReadFiles: 20,
  /** 单文件注入的最大字符数（超出截断并标记） */
  maxCharsPerFile: 8_000,
  /** 注入总预算 */
  maxTotalChars: 40_000,
} as const;

// ---------- 上下文组装（拼进 code-edit Skill 的提示词） ----------

/**
 * 组装 [仓库上下文] 文本块，供适配器拼进 code-edit/code-review 节点提示词。
 * @param adapter 仓库适配器
 * @param focusPaths 本次任务关注的文件（CEO 在 step.prompt 里指明，或适配器按目标粗选）
 */
export async function collectRepoContext(
  adapter: RepoAdapter,
  focusPaths?: string[],
): Promise<string> {
  const tree = await adapter.listTree();
  const parts: string[] = [`[仓库上下文] 项目「${tree.root}」共 ${tree.files.length} 个文件。`];

  // 树摘要（超预算折叠）
  const shown = tree.files.slice(0, REPO_CONTEXT_LIMITS.maxTreeEntries);
  parts.push("文件树：" + shown.map((f) => f.path).join("、"));
  if (tree.files.length > shown.length) {
    parts.push(`（另有 ${tree.files.length - shown.length} 个文件未列出）`);
  }

  // 关键文件内容（预算内截断）
  const toRead = (focusPaths ?? []).slice(0, REPO_CONTEXT_LIMITS.maxReadFiles);
  if (toRead.length > 0) {
    const contents = await adapter.readFiles(toRead);
    let budget = REPO_CONTEXT_LIMITS.maxTotalChars;
    for (const file of contents) {
      if (budget <= 0) break;
      const body = file.content.slice(0, Math.min(REPO_CONTEXT_LIMITS.maxCharsPerFile, budget));
      const truncatedMark =
        file.truncated || file.content.length > body.length ? "（已截断）" : "";
      parts.push(`--- ${file.path}${truncatedMark} ---\n${body}`);
      budget -= body.length;
    }
  }

  return parts.join("\n");
}

// ---------- 编辑合并（既有文件 + 修改产物 → 完整交付集 + 变更说明） ----------

export interface MergedEditResult {
  /** 合并后的完整文件集（修改文件用新内容，未动文件保留原样） */
  artifact: CodeArtifact;
  /** 变更摘要：新增 N / 修改 M（逐文件列出），供 CEO 汇报与 UI 展示 */
  changeSummary: string;
}

/**
 * 把 code-edit 节点的产物合并回仓库快照：
 *  - editResult.files 视为"变更后的完整文件内容"（不做 diff 级补丁，降低 LLM 出错面）
 *  - 命中既有路径 = 修改；未命中 = 新增
 * @param baseline 仓库当前内容（adapter.readFiles 的结果转 CodeFile）
 * @param editResult code-edit 节点产出的 CodeArtifact
 */
export function mergeEdits(
  baseline: CodeFile[],
  editResult: CodeArtifact,
): MergedEditResult {
  const baseMap = new Map(baseline.map((f) => [normalizePath(f.path), f]));
  const added: string[] = [];
  const modified: string[] = [];
  const merged = new Map<string, CodeFile>();

  for (const file of baseline) {
    merged.set(normalizePath(file.path), file);
  }
  for (const file of editResult.files) {
    const key = normalizePath(file.path);
    const before = baseMap.get(key);
    if (!before) {
      added.push(file.path);
    } else if (before.content !== file.content) {
      modified.push(file.path);
    }
    merged.set(key, file);
  }

  const artifact: CodeArtifact = {
    files: Array.from(merged.values()),
    entryFile: editResult.entryFile,
    notes: editResult.notes,
    testReport: editResult.testReport,
  };
  const lines = [
    `变更摘要：新增 ${added.length} 个 / 修改 ${modified.length} 个`,
    ...added.map((p) => `+ ${p}`),
    ...modified.map((p) => `~ ${p}`),
  ];
  return { artifact, changeSummary: lines.join("\n") };
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 集成备注（给 runNodes 适配器实现者）：
 * 1. code-edit/code-review 节点执行前：collectRepoContext(adapter, 关注文件)
 *    拼进 Skill 提示词头部；没有仓库（纯生成任务）则跳过。
 * 2. code-edit 节点返回后：mergeEdits(基线, 产物) → 完整交付集 + 变更摘要；
 *    changeSummary 拼进 outputSummary 喂 CEO，merged.artifact 挂 NodeRunResult.code。
 * 3. 仓库来源任选：老板选定的本地目录（Electron 文件对话框授权）/ 上传 zip 解压到临时目录；
 *    读写边界严格限定在授权目录内，与沙箱"不碰真实文件系统"原则一致。
 */
