/**
 * 小逻大脑 v2 —— 代码能力扩展（一期：代码即交付物）
 *
 * 设计立场（v3 对话型同样适用）：
 *  - 代码任务由 write_code 工具承接（对话型）或 code 模态节点（画布生成）；
 *    本文件的验收/风险扫描/Skill 目录两条链路共用。
 *  - 一期不执行任何代码：所有代码是"文件集交付物"，由老板在自己的环境验证；
 *    因此无需沙箱（对齐既有决策：gvisor 类开销不引入）。
 *  - 验收做两件事：结构完整性（文件集可落盘）+ 风险签名扫描（risky 信号
 *    不阻断交付，但以"警告"形式喂给 CEO，由其如实告知老板）。
 *
 * 接线（三处，详见文件末）：
 *  1. adapters.capabilityCatalog：追加 CODE_SKILL_CATALOG_LINES；
 *  2. adapters.runNodes：代码节点把模型输出解析为 CodeArtifact 挂到
 *     NodeRunResult.code（解析失败时 status="failed" + error，走循环重试/熔断）；
 *  3. UI（intent-console.tsx 结果摘要卡）：code 产物渲染文件清单
 *     （路径 + 语言 + 复制/下载按钮），entryFile 置顶高亮。
 */

import type { CodeArtifact, CodeFile, NodeRunResult } from "./types";
import type { ValidationVerdict } from "./validate";

// ---------- 代码 Skill 目录（追加到 capabilityCatalog） ----------

export interface CodeSkillEntry {
  skillId: string;
  name: string;
  input: string;
}

/**
 * 一期代码 Skill 清单。行格式与现有 capabilityCatalog 一致：
 * skillId | 模态 | 名称 | 需要的输入素材
 */
export const CODE_SKILLS: CodeSkillEntry[] = [
  {
    skillId: "code-generate",
    name: "生成代码文件集",
    input: "需求描述 + 技术栈要求",
  },
  {
    skillId: "code-edit",
    name: "修改既有代码",
    input: "既有代码（引用素材）+ 修改需求",
  },
  {
    skillId: "code-review",
    name: "代码审查报告",
    input: "待审代码（引用素材）+ 关注点",
  },
  {
    skillId: "code-test-spec",
    name: "测试规格与验证清单",
    input: "代码交付物（上游节点）+ 验收标准",
  },
  {
    skillId: "code-deliver",
    name: "组装交付包",
    input: "代码交付物（上游节点）+ 任务目标；产出清单/安装/运行指引",
  },
];

/** 拼成目录行，适配器直接追加到 capabilityCatalog 末尾 */
export const CODE_SKILL_CATALOG_LINES: string = CODE_SKILLS.map(
  (s) => `${s.skillId} | code | ${s.name} | ${s.input}`
).join("\n");

// ---------- 风险签名扫描（不阻断，只告警） ----------

interface RiskPattern {
  label: string;
  pattern: RegExp;
}

/**
 * 一期不执行代码，但仍扫描交付物中的高危签名：
 * 让 CEO 在 finish 时对老板如实提示（例如"含 rm -rf，落盘前请人工核对"）。
 * 二期接入受控执行后，这些签名将升级为审批门。
 */
const RISK_PATTERNS: RiskPattern[] = [
  { label: "破坏性删除命令（rm -rf / Remove-Item -Recurse）", pattern: /rm\s+-rf|Remove-Item\s+.*-Recurse/i },
  { label: "管道直执行远程脚本（curl | sh）", pattern: /curl\s+[^\n|]*\|\s*(sh|bash|powershell)/i },
  { label: "不可逆数据库操作（DROP/TRUNCATE）", pattern: /\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i },
  { label: "动态执行（eval / exec 拼接）", pattern: /\beval\s*\(|\bexec\s*\(\s*['"`]/i },
  { label: "疑似硬编码密钥（key/token/password 赋值）", pattern: /(api[_-]?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{8,}['"]/i },
];

/**
 * 扫描代码交付物的风险签名。
 * 返回人类可读的告警列表（含文件路径）；空数组表示未发现。
 */
export function scanCodeRisk(artifact: CodeArtifact): string[] {
  const warnings: string[] = [];
  for (const file of artifact.files) {
    for (const risk of RISK_PATTERNS) {
      if (risk.pattern.test(file.content)) {
        warnings.push(`[风险] ${file.path}：${risk.label}`);
      }
    }
  }
  return warnings;
}

// ---------- 验收：代码步骤（validate.ts 的 modality="code" 分支调用） ----------

/** 单个代码文件的最低正文长度（防占位符交付） */
const MIN_CODE_FILE_CHARS = 20;
/** 文件集上限（防 LLM 发散式铺量） */
const MAX_CODE_FILES = 24;
/** 单文件路径合法性：相对路径、无目录穿越、无绝对盘符 */
const SAFE_PATH = /^(?!.*\.\.[/\\])[\w.\-/\\]+$/;

export function validateCodeResult(result: NodeRunResult): ValidationVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const code = result.code;

  if (!code || !Array.isArray(code.files)) {
    problems.push("缺少结构化代码产物（code 字段）");
    return { ok: false, problems };
  }
  if (code.files.length === 0) {
    problems.push("文件集为空");
    return { ok: false, problems };
  }
  if (code.files.length > MAX_CODE_FILES) {
    problems.push(`文件数 ${code.files.length} 超过上限 ${MAX_CODE_FILES}，请拆分任务`);
  }

  const paths = new Set<string>();
  for (const file of code.files) {
    const fileProblems = validateCodeFile(file);
    if (fileProblems.length > 0) {
      problems.push(...fileProblems.map((p) => `${file.path || "(无路径)"}：${p}`));
      continue;
    }
    if (paths.has(file.path)) {
      problems.push(`${file.path}：路径重复`);
    }
    paths.add(file.path);
  }

  if (code.entryFile && !paths.has(code.entryFile)) {
    problems.push(`entryFile（${code.entryFile}）不在文件集内`);
  }
  // 单文件时默认其为入口，便于 UI 展示
  if (!code.entryFile && code.files.length === 1 && paths.has(code.files[0].path)) {
    code.entryFile = code.files[0].path;
  }

  // 风险扫描：不阻断，记入 warnings
  warnings.push(...scanCodeRisk(code));

  // 二期实测信号：若沙箱回填了 testReport，失败用例视为不合格
  const report = code.testReport;
  if (report && typeof report.failed === "number" && report.failed > 0) {
    const passedText = typeof report.passed === "number" ? `${report.passed} 通过 / ` : "";
    problems.push(`实测 ${passedText}${report.failed} 个用例失败${report.summary ? `（${report.summary}）` : ""}`);
  }

  return { ok: problems.length === 0, problems, warnings };
}

function validateCodeFile(file: CodeFile): string[] {
  const problems: string[] = [];
  if (!file.path || !file.path.trim()) {
    problems.push("缺少文件路径");
  } else if (!SAFE_PATH.test(file.path)) {
    problems.push("文件路径非法（须为相对路径且不含 ..）");
  }
  if (!file.language || !file.language.trim()) {
    problems.push("缺少语言标识");
  }
  if (!file.content || file.content.trim().length < MIN_CODE_FILE_CHARS) {
    problems.push(`正文为空或少于 ${MIN_CODE_FILE_CHARS} 字符`);
  } else if (/```/.test(file.content)) {
    // 内容里残留 markdown 代码围栏 → 说明适配器解析没剥干净，退回重生成
    problems.push("正文含未剥离的 markdown 代码围栏");
  }
  return problems;
}

/** REF-INTEGRITY: HTML 里 script src / link href 引用的本地相对文件必须存在于产物文件集（外链/站内绝对路径不校验） */
export function checkArtifactRefs(artifact: CodeArtifact): string[] {
  const paths = new Set(artifact.files.map((f) => f.path));
  const problems: string[] = [];
  const refRes = [
    /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<link[^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const file of artifact.files) {
    if (!/\.html?$/i.test(file.path)) continue;
    const missing = new Set<string>();
    for (const re of refRes) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.content))) {
        const ref = m[1].trim().split(/[?#]/)[0];
        if (!ref || /^(https?:|data:|blob:|mailto:|\/\/)/i.test(ref) || ref.startsWith("/")) continue;
        const norm = ref.replace(/^\.\//, "");
        if (!paths.has(norm) && ![...paths].some((p) => p.endsWith("/" + norm))) missing.add(m[1]);
      }
    }
    for (const ref of missing) problems.push(`${file.path} 引用的本地文件 "${ref}" 不在产物文件集内`);
  }
  return problems;
}

// ---------- 摘要（喂给 CEO 观察，控制 token） ----------

/** 生成喂给 CEO 的代码产物摘要（与 outputSummary 口径一致：只给结论不给全文） */
export function summarizeCodeArtifact(artifact: CodeArtifact): string {
  const list = artifact.files
    .map((f) => `${f.path}(${f.language}, ${f.content.length} 字符)`)
    .join("；");
  const entry = artifact.entryFile ? `，入口 ${artifact.entryFile}` : "";
  return `代码交付物 ${artifact.files.length} 个文件${entry}：${list}`;
}

// ---------- 接线备注（给集成方） ----------
/**
 * adapters.runNodes 侧的建议解析流程（代码节点）：
 * 1. 模型输出约定为 JSON：{ files, entryFile?, notes? }（在 Skill 提示词里锁定格式）；
 * 2. 解析失败 → 返回 { status: "failed", error: "代码产物解析失败: ..." }，
 *    循环会带错误上下文重试（stuckThreshold 熔断兜底）；
 * 3. 解析成功 → 挂 NodeRunResult.code，outputSummary 用 summarizeCodeArtifact()；
 * 4. UI 侧对 code 产物提供"按文件下载"，notes 显示为使用说明区。
 */
