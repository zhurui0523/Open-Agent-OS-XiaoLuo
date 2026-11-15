/**
 * 小逻聊天轮次的两道收尾闸测试
 *
 * 背景（2026-11-13 老板反馈「还没有执行完任务就自己停下来了」）：
 * 一轮唯一的正常出口是「模型这条回复没带工具调用 → 直接收尾」，
 * 于是「收到，先做贪吃蛇」这种只宣布计划的正文也算合法收尾。
 *  - PROGRESS-GATE（空手收尾闸）：本轮零工具调用、零产物 → 拦一次逼它真动手；
 *  - TRUNC-GATE（输出截断闸）：finishReason=length/max_tokens 且无工具调用 → 判为被掐断，拆小批续跑。
 * 规则函数直接调用；闸门在 Agent 里的接法按仓库惯例做源码断言。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { looksLikeBuildRequest } from "../app/xiaoluo-brain/lib/brain/validate.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("build requests read as artifact requests, questions do not", () => {
  for (const text of [
    "你先帮我做一个贪吃蛇游戏",
    "写一个登录页面",
    "帮我把这个组件重构一下",
    "实现一个倒计时功能",
    "build a landing page for the shop",
  ]) {
    assert.equal(looksLikeBuildRequest(text), true, text);
  }
  for (const text of ["谢谢", "这段代码是什么意思", "你会写贪吃蛇吗？", "为什么刚才失败了", "现在几点了"]) {
    assert.equal(looksLikeBuildRequest(text), false, text);
  }
});

test("an empty-handed turn is blocked before closing instead of ending the turn", async () => {
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");

  // 零工具调用的计数入口：有工具调用就累加，闸门的放行前提是它仍为 0
  assert.match(chatAgent, /this\.turnToolCalls \+= toolCalls\.length;/);
  assert.match(chatAgent, /if \(this\.turnToolCalls > 0 \|\| this\.turnHadArtifact\) return false;/);
  // 触发条件：本轮/上轮清单还没做完，或老板这句话在要产物
  assert.match(chatAgent, /const wantsArtifact = looksLikeBuildRequest\(userText\);/);
  assert.match(chatAgent, /if \(pending\.length === 0 && !wantsArtifact\) return false;/);
  // 每轮最多拦一次，且必须给老板看得见的一行状态
  assert.match(chatAgent, /if \(this\.progressGateUsed \|\| this\.aborted\) return false;/);
  assert.match(chatAgent, /this\.progressGateUsed = true;/);
  assert.match(chatAgent, /收尾前强制动手闸/);
  // 预算/步数不足时放行但 journal 留痕，不能把轮次憋死
  assert.match(chatAgent, /空手收尾放行（预算\/步数不足）/);
  // 出口顺序：截断 → 改完必跑 → 空手，三闸都在 applyClosingCheck 之前
  assert.match(
    chatAgent,
    /if \(this\.enforceTruncationResume\(resp\.finishReason, step\)\) continue;[\s\S]{0,400}?if \(this\.enforceVerifyGate\(step\)\) continue;[\s\S]{0,200}?if \(this\.enforceProgressGate\(step, text\)\) continue;[\s\S]{0,200}?const finalContent = this\.applyClosingCheck/,
  );
});

test("the task checklist is kept on the agent so the gate can see unfinished steps", async () => {
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");

  assert.match(chatAgent, /this\.planTodos = todos\.map\(\(t\) => \(\{ content: t\.content, status: t\.status \}\)\);/);
  assert.match(chatAgent, /this\.planTodosTurnId = this\.turnId;/);
  // 轮首重置计数，且清单只宽限一轮：换了话题老清单不该把新轮次拽回去续跑
  assert.match(chatAgent, /this\.turnToolCalls = 0;\n\s*this\.progressGateUsed = false;/);
  assert.match(chatAgent, /if \(this\.planTodosTurnId !== this\.turnId && this\.planTodosTurnId !== this\.turnId - 1\) this\.planTodos = \[\];/);
});

test("a length-truncated reply resumes in smaller pieces instead of closing", async () => {
  const [agentPorts, llmWire] = await Promise.all([
    source("app/xiaoluo-brain/lib/brain/agent-ports.ts"),
    source("app/xiaoluo-brain/lib/brain/llm-wire.ts"),
  ]);
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");

  // finishReason 从端口类型一路透传到 Agent（此前是面板里的死字段）
  // 端口契约搬到 agent-ports.ts 了，续跑行为另有真跑测试：tests/brain-agent-protocol.test.mjs
  assert.match(agentPorts, /finishReason\?: string;/);
  // 非流式整包与流式拼包都在 llm-wire 里收口：两条路径各自都要把 finishReason 交给引擎，
  // 否则长度截断会被当成自愿收尾，续跑闸直接失效
  assert.match(llmWire, /finishReason: data\.choices\?\.\[0\]\?\.finish_reason,/);
  assert.match(llmWire, /finishReason: acc\.finishReason,/);
  // 两种协议各自的收口词都算截断；每轮最多 2 次防大文件反复撞墙
  assert.match(chatAgent, /if \(finishReason !== "length" && finishReason !== "max_tokens"\) return false;/);
  assert.match(chatAgent, /if \(this\.truncationRetries >= 2 \|\| this\.aborted\) return false;/);
  assert.match(chatAgent, /this\.truncationRetries \+= 1;/);
  assert.match(chatAgent, /输出被长度截断但预算\/步数不足/);
  // 引导拆分而不是原样重试
  assert.match(chatAgent, /一次 write_code 只给一个文件的全文/);
});
