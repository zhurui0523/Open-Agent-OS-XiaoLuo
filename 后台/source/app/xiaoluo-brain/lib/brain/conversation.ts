/**
 * 小逻 v3 —— 对话分叉（P2：thread/fork）
 *
 * 老板要从某条对话线换个思路试，又舍不得已经聊出来的上下文：把当前对话整份复制成一条
 * 新对话（新 conversationId），分支里怎么写都不动原对话。
 *
 * 分叉是「存档级」复制，不是进程级：复制的是 ChatPersistence（LLM 历史 + 断点账 + UI 消息流），
 * 宿主切到新 cid 后走原有的恢复链路重建 Agent，因此不新增任何 Agent 侧状态机。
 * 纯函数、无 DOM、无网络：任何宿主（面板 / CLI / 桌面）都能直接调用，也便于行为测试。
 */

import type { ChatPersistence } from "./types";

/** 分支留痕事件的工具名（宿主时间线按它归组，宿主不认识就按普通旁白渲染） */
export const FORK_NOTE_TOOL = "conversation_fork";

/**
 * 分支对话 id：在原 id 后接 `-fork-<时间戳 36 进制>`。
 * 只用 [A-Za-z0-9.-] 是刻意的——服务端快照名会 sanitize 非法字符，若用了 #、空格之类，
 * 两条不同分支可能落到同一个快照文件上互相覆盖。
 */
export function forkConversationId(fromConversationId: string, at: number = Date.now()): string {
  return `${fromConversationId}-fork-${at.toString(36)}`;
}

/** 分支首条可见留痕（宿主消息流里的弱化旁白；宿主不认识就按纯文本渲染） */
function forkNote(toConversationId: string, fromConversationId: string, at: number): Record<string, unknown> {
  return {
    id: `cm-fork-${at}`,
    kind: "status",
    content: `已分叉出分支对话：历史与产物已整份复制，接下来在分支里怎么写都不动原对话（分支自 ${fromConversationId}）。`,
    meta: { tool: FORK_NOTE_TOOL, target: toConversationId, ok: true },
    createdAt: at,
  };
}

/**
 * 由原对话存档生成分支存档。
 *
 * 带的：LLM 历史（含系统提示词轮）、累计 token、上次代码产物、goal、改完必跑账、读后写账
 *       —— 分叉要的是「接着这条线换个走法」，断点账断了就得重新摸底。
 * 不带：挂起的反问（pendingAsk 与反问卡）—— 那次回合还挂在原对话的 Agent 上，
 *       分支里点回答只会石沉大海；中断标记（分支从当前历史干净起步）。
 */
export function buildForkSnapshot(
  source: ChatPersistence,
  toConversationId: string,
  at: number = Date.now(),
): ChatPersistence {
  const uiMessages = (Array.isArray(source.uiMessages) ? source.uiMessages : []).filter(
    (m) => !(m && typeof m === "object" && (m as { kind?: unknown }).kind === "ask-card"),
  );
  return {
    version: 1,
    conversationId: toConversationId,
    forkedFrom: source.conversationId,
    messages: source.messages.slice(),
    usedTokens: source.usedTokens,
    uiMessages: [...uiMessages, forkNote(toConversationId, source.conversationId, at)],
    savedAt: at,
    ...(source.lastCode ? { lastCode: source.lastCode } : {}),
    ...(source.goal ? { goal: source.goal } : {}),
    ...(source.dirtyCodeFiles?.length ? { dirtyCodeFiles: source.dirtyCodeFiles } : {}),
    ...(source.readPaths?.length ? { readPaths: source.readPaths } : {}),
  };
}
