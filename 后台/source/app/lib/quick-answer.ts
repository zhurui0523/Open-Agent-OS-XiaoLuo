export interface QuickAnswerHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export const QUICK_ANSWER_CAPABILITY_ID = "system.quick-answer";

export function buildQuickAnswerPrompt(
  question: string,
  history: QuickAnswerHistoryMessage[] = [],
) {
  const recentHistory = history
    .slice(-12)
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "助手"}：${message.content.trim()}`,
    )
    .filter((line) => !line.endsWith("："));

  return [
    "你处于“小逻快速问答”模式。",
    "直接、准确地回答用户问题；可以正常解释、分析并给出纯文本建议。",
    "不要生成 Intent 执行计划，不要创建或运行画布节点，不要调用工具，也不要声称读取了当前画布。",
    ...(recentHistory.length
      ? ["以下仅是快速问答模式中的最近对话：", recentHistory.join("\n")]
      : []),
    `用户当前问题：${question.trim()}`,
  ].join("\n\n");
}
