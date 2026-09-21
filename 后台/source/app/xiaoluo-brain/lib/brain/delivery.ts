/**
 * 小逻大脑 v2 —— 交付包（三期：把"写完"变成"交付出去"）
 *
 * 定位：代码写出来 ≠ 交付。交付 = 文件集 + 清单（manifest）+ 怎么装 + 怎么跑。
 *  - buildDeliveryPackage：由 code-deliver 节点（或适配器在 finish 前）调用，
 *    把 CodeArtifact 组装成结构化交付包；
 *  - renderDeliveryMarkdown：给 CEO 的 finish summary 与 UI 交付卡共用同一份文案，
 *    保证"对话器里说的"与"卡片里展示的"一致；
 *  - 导出 manifest JSON：UI 侧打包下载（zip）时把 manifest.json 放进包内，
 *    老板解压后照清单落盘即可。
 */

import type { CodeArtifact, CodeFile } from "./types";
import { scanCodeRisk } from "./code";

// ---------- 交付包结构 ----------

export interface DeliveryFileMeta {
  path: string;
  language: string;
  chars: number;
}

export interface DeliveryManifest {
  /** 任务目标（CEO 计划里的 goal） */
  goal: string;
  /** 生成时间（ISO） */
  generatedAt: string;
  /** 主入口文件（落盘引导用） */
  entryFile?: string;
  files: DeliveryFileMeta[];
  /** 依赖安装指引（按依赖文件自动推断，推断不出为空） */
  installHint?: string;
  /** 运行指引（按入口文件语言推断） */
  runHint?: string;
  /** 风险告警（继承一期风险扫描，落盘前请人工核对） */
  warnings: string[];
}

export interface DeliveryPackage {
  artifact: CodeArtifact;
  manifest: DeliveryManifest;
}

// ---------- 组装 ----------

export function buildDeliveryPackage(goal: string, artifact: CodeArtifact): DeliveryPackage {
  const manifest: DeliveryManifest = {
    goal,
    generatedAt: new Date().toISOString(),
    entryFile: artifact.entryFile,
    files: artifact.files.map((f) => ({
      path: f.path,
      language: f.language,
      chars: f.content.length,
    })),
    installHint: inferInstallHint(artifact.files),
    runHint: inferRunHint(artifact),
    warnings: scanCodeRisk(artifact),
  };
  return { artifact, manifest };
}

// ---------- 安装 / 运行指引推断 ----------

const INSTALL_RULES: Array<{ file: string; hint: string }> = [
  { file: "package.json", hint: "npm install（或 pnpm install / yarn）" },
  { file: "requirements.txt", hint: "pip install -r requirements.txt" },
  { file: "pyproject.toml", hint: "pip install -e .（或 poetry install）" },
  { file: "go.mod", hint: "go mod tidy" },
  { file: "Cargo.toml", hint: "cargo build" },
];

/** 按交付集里的依赖文件推断安装命令；多个都命中时全部列出 */
export function inferInstallHint(files: CodeFile[]): string | undefined {
  const paths = new Set(files.map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
  const hits = INSTALL_RULES.filter((r) => hasFile(paths, r.file)).map((r) => r.hint);
  return hits.length > 0 ? hits.join("；") : undefined;
}

function hasFile(paths: Set<string>, name: string): boolean {
  for (const p of paths) {
    if (p === name || p.endsWith(`/${name}`)) return true;
  }
  return false;
}

/** 按入口文件的语言推断运行命令；推断不出返回 undefined（notes 兜底） */
export function inferRunHint(artifact: CodeArtifact): string | undefined {
  const entry = artifact.files.find((f) => f.path === artifact.entryFile);
  const target = entry ?? artifact.files[0];
  if (!target) return undefined;
  const lang = target.language.toLowerCase();
  const path = target.path.replace(/\\/g, "/");
  if (lang.includes("typescript") || lang === "ts") {
    return path.endsWith(".tsx") ? undefined : `npx tsx ${path}`;
  }
  if (lang === "javascript" || lang === "js") return `node ${path}`;
  if (lang === "python") return `python ${path}`;
  if (lang === "go") return `go run ${path}`;
  if (lang === "rust") return "cargo run";
  if (lang === "shell" || lang === "bash") return `bash ${path}`;
  return undefined;
}

// ---------- 渲染（finish summary 与 UI 交付卡共用） ----------

/**
 * 渲染交付说明 markdown：
 * CEO 的 finish summary 直接用它，UI 交付卡按同一结构渲染——口径唯一。
 */
export function renderDeliveryMarkdown(pkg: DeliveryPackage): string {
  const { manifest, artifact } = pkg;
  const lines: string[] = [];

  lines.push(`代码交付完成：${manifest.files.length} 个文件。`);
  if (manifest.entryFile) lines.push(`入口文件：${manifest.entryFile}`);

  lines.push("");
  lines.push("文件清单：");
  for (const f of manifest.files) {
    const mark = f.path === manifest.entryFile ? "⭐ " : "- ";
    lines.push(`${mark}${f.path}（${f.language}，${f.chars} 字符）`);
  }

  if (manifest.installHint) {
    lines.push("", `安装依赖：${manifest.installHint}`);
  }
  if (manifest.runHint) {
    lines.push(`运行方式：${manifest.runHint}`);
  }
  if (artifact.notes) {
    lines.push("", `使用说明：${artifact.notes}`);
  }
  if (manifest.warnings.length > 0) {
    lines.push("", "⚠ 风险提醒（落盘前请人工核对）：");
    for (const w of manifest.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

/** manifest JSON（UI 打包 zip 时放入包内，老板解压照单落盘） */
export function manifestToJson(pkg: DeliveryPackage): string {
  return JSON.stringify(pkg.manifest, null, 2);
}

/**
 * 集成备注：
 * 1. CODE_SKILLS 里的 code-deliver 节点执行时：取上游代码节点的 NodeRunResult.code
 *    → buildDeliveryPackage(goal, artifact) → 挂 NodeRunResult.delivery；
 *    outputSummary 用 `${files.length} 个文件已组包，入口 ${entryFile}`。
 * 2. UI 交付卡：result.delivery 存在时渲染文件清单 + "下载 zip"；
 *    zip 内放 manifest.json + 各文件（按 path 建目录）。
 * 3. CEO finish 时：summary 可直接引用 renderDeliveryMarkdown 的口径，
 *    保证对话器文案与卡片一致。
 */
