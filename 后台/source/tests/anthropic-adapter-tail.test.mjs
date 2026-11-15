/**
 * Anthropic 协议转换层的收尾形状测试
 *
 * 背景（2026-11-13 实测）：ChatAgent 的强制续跑闸门会往历史尾部推一条 system 提醒再续跑，
 * 而 Anthropic messages 协议里 system 只能当顶层参数——转换后 messages 以 assistant 结尾，
 * 上游直接 400：「This model does not support assistant message pre-fill. The last message must not be role of assistant.」
 * 整轮被判中断。这里锁死转换后的收尾形状。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildAnthropicBody } from "../app/lib/anthropic-adapter.ts";

function toAnthropic(messages, tools) {
  return JSON.parse(buildAnthropicBody({ model: "claude-test", messages, tools }));
}

function lastTurn(b) {
  return b.messages[b.messages.length - 1];
}

test("a trailing system nudge rides as a user turn, not an assistant tail", () => {
  const b = toAnthropic([
    { role: "system", content: "你是小逻。" },
    { role: "user", content: "你先帮我做一个贪吃蛇游戏" },
    { role: "assistant", content: "分文件、小批量写。先把数据层和战斗内核。" },
    { role: "system", content: "[系统提示·输出截断] 上一条回复被长度上限掐断，拆小批续跑。" },
  ]);

  assert.equal(lastTurn(b).role, "user");
  assert.match(lastTurn(b).content[0].text, /输出截断/);
  // 尾部提醒已改挂 user 轮，system 参数里只剩真正的系统提示
  assert.equal(b.system, "你是小逻。");
  // system 抽到顶层后只剩 user/assistant 交替：0=user 1=assistant 2=提醒所在的 user 轮
  assert.equal(b.messages[1].role, "assistant");
  assert.equal(b.messages.length, 3);
});

test("an assistant-only tail still gets a user turn", () => {
  const b = toAnthropic([
    { role: "system", content: "你是小逻。" },
    { role: "user", content: "继续" },
    // 悬空工具调用被孤儿清理剥成纯正文后的形态
    { role: "assistant", content: "（已中断）" },
  ]);

  assert.equal(lastTurn(b).role, "user");
  assert.match(lastTurn(b).content[0].text, /上一步没有完成/);
});

test("tool results still ride on the user turn when a nudge follows", () => {
  const b = toAnthropic(
    [
      { role: "user", content: "做一个贪吃蛇游戏" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tu_1", type: "function", function: { name: "write_code", arguments: '{"files":[]}' } },
        ],
      },
      { role: "tool", tool_call_id: "tu_1", content: "已写入 js/game.js" },
      { role: "system", content: "[系统提示·空手收尾] 立刻动手把产物写出来。" },
    ],
    [{ type: "function", function: { name: "write_code" } }],
  );

  assert.equal(b.messages[1].role, "assistant");
  assert.equal(b.messages[1].content[1].type, "tool_use");
  // 提醒与工具结果同属 user 轮：相邻同角色合并，顺序不变
  assert.equal(lastTurn(b).role, "user");
  assert.equal(lastTurn(b).content[0].type, "tool_result");
  assert.match(lastTurn(b).content[1].text, /空手收尾/);
  assert.equal(b.tools[0].name, "write_code");
});
