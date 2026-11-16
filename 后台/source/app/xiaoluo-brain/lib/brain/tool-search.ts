/**
 * 工具检索面（P1-5 对齐 Codex `tools/src/tool_search.rs`）。
 *
 * 工具少时全量注册没问题；工具多了模型开始选错（40+ 时已经出现「该读文件去跑命令」）。
 * 这里提供：目录构建 + 关键词打分检索 + 只回命中项的精简说明，
 * 让模型先检索再调用，而不是在每个 schema 里堆同义词。
 */

export interface ToolSchemaLike {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  /** name 拆开的标记（snake_case 分词），用于精确命中 */
  tokens: string[];
}

export interface ToolMatch {
  name: string;
  description: string;
  score: number;
}

/** 中英口语 → 工具名的同义词桥：模型描述任务时未必用工具名 */
const SYNONYMS: Record<string, string[]> = {
  读出来: ["read_file"],
  读出: ["read_file"],
  读文件: ["read_file"],
  看文件: ["read_file"],
  目录: ["list_dir"],
  列出当前: ["list_dir"],
  注释: ["grep_files"],
  搜一下: ["grep_files"],
  搜代码: ["grep_files"],
  搜索内容: ["grep_files"],
  搜内容: ["grep_files"],
  文件名: ["find_files"],
  找文件: ["find_files"],
  写进: ["write_file"],
  写入: ["write_file"],
  写文件: ["write_file"],
  改掉: ["edit_file"],
  改成: ["edit_file"],
  改文件: ["edit_file"],
  编辑: ["edit_file"],
  补丁: ["edit_file", "apply_patch"],
  打补丁: ["apply_patch"],
  上下文补丁: ["apply_patch"],
  锚点: ["apply_patch"],
  按行改: ["apply_patch"],
  跑一下: ["run_command"],
  看报错: ["run_command"],
  执行命令: ["run_command"],
  命令: ["run_command"],
  git: ["git"],
  提交: ["git"],
  仓库: ["git"],
  服务: ["start_service", "stop_service", "service_status", "setup_service"],
  端口: ["locate_local_service", "service_status"],
  打开网页: ["browse_page"],
  看正文: ["browse_page"],
  浏览器: ["browse_page", "web_operate", "web_navigate"],
  截图: ["inspect_screen", "desktop_screenshot", "web_screenshot"],
  看界面: ["inspect_screen"],
  桌面: ["desktop_operate", "desktop_screenshot", "desktop_inspect"],
  技能: ["load_skill", "save_skill"],
  记住: ["add_memory"],
  偏好: ["add_memory"],
  记忆: ["add_memory", "query_ledger"],
  待办: ["todo_write"],
  清单: ["todo_write"],
  交付: ["package_program", "deploy_program"],
  产品图: ["generate_media"],
  生成一张: ["generate_media"],
  生成图片: ["generate_media"],
  视频: ["generate_media"],
  图片: ["generate_media"],
  写一个: ["write_code"],
  带图表: ["write_code"],
  页面: ["write_code"],
  联网: ["web_search"],
  搜索网络: ["web_search"],
  检索: ["web_search", "grep_files", "find_files"],
  远程: ["ssh_exec"],
  输入: ["write_stdin"],
  上下文: ["context_meter"],
  工具: ["tool_search"],
};

/** 中文没有空格：用二元组重叠兜底，避免整句 substring 匹配不上 */
function bigrams(text: string): Set<string> {
  const clean = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

function tokenizeName(name: string): string[] {
  return name
    .split(/[_\W]+/)
    .map((item) => item.toLowerCase())
    .filter(Boolean);
}

export function buildToolCatalog(schemas: ToolSchemaLike[]): ToolCatalogEntry[] {
  return schemas
    .filter((schema) => schema?.function?.name)
    .map((schema) => ({
      name: schema.function.name,
      description: (schema.function.description ?? "").trim(),
      tokens: tokenizeName(schema.function.name),
    }));
}

export function scoreTool(entry: ToolCatalogEntry, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const words = needle.split(/[\s,，。;；/]+/).filter(Boolean);
  const haystack = (entry.name + " " + entry.description).toLowerCase();
  let score = 0;

  if (entry.name.toLowerCase() === needle) score += 100;
  if (entry.name.toLowerCase().includes(needle)) score += 40;
  for (const word of words) {
    if (entry.tokens.includes(word)) score += 25;
    else if (entry.name.toLowerCase().includes(word)) score += 15;
    if (entry.description.toLowerCase().includes(word)) score += 8;
  }

  // 中文二元组重叠：处理「把 src 里的文件读出来看看」这类整句口语
  const queryGrams = bigrams(needle);
  if (queryGrams.size) {
    const toolGrams = bigrams(haystack);
    let shared = 0;
    for (const gram of queryGrams) if (toolGrams.has(gram)) shared += 1;
    score += Math.min(30, shared * 4);
  }

  // 同义词命中：中文任务描述直接映射到工具名（越长越具体，给足权重）
  for (const [phrase, names] of Object.entries(SYNONYMS)) {
    if (needle.includes(phrase) && names.includes(entry.name)) score += 35 + phrase.length * 3;
  }
  return score;
}

export function searchTools(
  schemas: ToolSchemaLike[],
  query: string,
  limit = 5,
): { matches: ToolMatch[]; catalogSize: number } {
  const catalog = buildToolCatalog(schemas);
  const scored = catalog
    .map((entry) => ({ name: entry.name, description: entry.description, score: scoreTool(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit));
  return { matches: scored, catalogSize: catalog.length };
}
