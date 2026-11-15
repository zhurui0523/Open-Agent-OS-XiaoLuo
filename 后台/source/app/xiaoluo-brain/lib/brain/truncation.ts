/**
 * 工具结果截断（学 Codex `TruncationPolicy` 的 middle-elision）
 *
 * 为什么要保尾：命令/构建/测试类结果最有信息量的部分在结尾
 * （报错正文、exit code、汇总行），以前只切头，模型看到的是
 * 「一大段过程 + 一句被截断」，然后基于残缺结果继续判断。
 * 现在首 60% / 尾 40% 都保留，中间挖掉并明说挖了多少。
 */

/** 省略标记预留字数：够写清「省略了多少字符 + 怎么取回缺失部分」 */
const NOTICE_RESERVE = 200;

/** 行边界回退的最大距离：超过就当没这行边界，按字符硬切 */
const LINE_SNAP_WINDOW = 60;

function headCut(text: string, index: number): number {
  const nl = text.indexOf("\n", index);
  return nl === -1 || nl - index > LINE_SNAP_WINDOW ? index : nl;
}

function tailCut(text: string, index: number): number {
  const nl = text.lastIndexOf("\n", index);
  return nl === -1 || index - nl > LINE_SNAP_WINDOW ? index : nl + 1;
}

export function truncateToolResult(result: string, maxChars: number): string {
  if (result.length <= maxChars) return result;
  const body = Math.max(120, maxChars - NOTICE_RESERVE);
  const headBudget = Math.ceil(body * 0.6);
  const head = headCut(result, headBudget);
  const tail = tailCut(result, result.length - (body - headBudget));
  const elided = tail - head;
  if (elided <= 0) return result.slice(0, maxChars);
  const notice = `\n\n……（中间省略 ${elided} 字符，首尾均已保留；需要缺失部分请用 offset/limit 分段读或 grep_files 定点检索）\n\n`;
  return `${result.slice(0, head)}${notice}${result.slice(tail)}`;
}
