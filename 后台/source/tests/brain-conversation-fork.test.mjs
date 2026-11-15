/**
 * 对话分叉行为测试（P2-2 / P2-3）
 *
 * 分叉是存档级复制：conversation.ts 把 ChatPersistence 整份搬到新 cid，宿主切 cid 后走原有
 * 恢复链路重建 Agent。所以这里不看源码正则，直接拿真数据过一遍——
 * 带什么、丢什么、分支里再跑一轮会不会污染原对话，以及分支存档能不能被内核吃回去。
 * 全程纯 Node：没有 DOM、没有 localStorage。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildForkSnapshot, FORK_NOTE_TOOL, forkConversationId } from "../app/xiaoluo-brain/lib/brain/conversation.ts";
import { createChatAgent } from "../app/xiaoluo-brain/lib/brain/agent-host.ts";

assert.equal(typeof document, "undefined");
assert.equal(typeof window, "undefined");

const usage = { promptTokens: 800, completionTokens: 30 };

/** 一条聊过两轮、有代码产物、正在等反问回答、断点账齐全的主干存档 */
function trunkSnapshot() {
  return {
    version: 1,
    conversationId: "brain-canvas-7",
    messages: [
      { role: "system", content: "你是小逻" },
      { role: "user", content: "帮我写个抓取脚本" },
      { role: "assistant", content: "先问一句：要存成什么格式？" },
      { role: "user", content: "csv 就行" },
    ],
    usedTokens: 4321,
    pendingAsk: { id: "ask-1", question: "要存成什么格式？", options: ["csv", "json"] },
    lastCode: { files: [{ path: "grab.mjs", content: "export const x = 1;\n" }], language: "javascript" },
    uiMessages: [
      { id: "cm-1", kind: "user", content: "帮我写个抓取脚本" },
      { id: "cm-2", kind: "ask-card", content: "要存成什么格式？", meta: { ask: { id: "ask-1" } } },
      { id: "cm-3", kind: "assistant", content: "csv 就行，收到" },
    ],
    interrupted: true,
    goal: { goal: "把抓取脚本跑通", criteria: "能落地 csv", setAt: 1000 },
    dirtyCodeFiles: ["grab.mjs"],
    readPaths: ["README.md"],
    savedAt: 900,
  };
}

/** 服务端快照名的 sanitize 口径（api/v2/chat/[id] 的 [^A-Za-z0-9._-] → _） */
function sanitize(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

test("分支 id 只用文件名安全字符，且不同时刻分叉不会撞同一个快照", () => {
  const a = forkConversationId("brain-canvas-7", 1_700_000_000_000);
  const b = forkConversationId("brain-canvas-7", 1_700_000_000_001);

  assert.ok(a.startsWith("brain-canvas-7-fork-"), a);
  assert.notEqual(a, b, "同一秒内的两次分叉也得是两条快照");
  for (const id of [a, b]) {
    assert.equal(sanitize(id), id, "分支 id 必须原样通过服务端文件名 sanitize");
  }
  // 原 id 里带非法字符时，sanitize 后仍不会把两条不同分支合并成一条
  assert.notEqual(sanitize(forkConversationId("brain 中文#1", 1)), sanitize(forkConversationId("brain 中文#2", 1)));
});

test("分支带上历史与断点账：接着这条线换个走法，不用重新摸底", () => {
  const trunk = trunkSnapshot();
  const cid = forkConversationId(trunk.conversationId, 2000);
  const fork = buildForkSnapshot(trunk, cid, 2000);

  assert.equal(fork.conversationId, cid);
  assert.equal(fork.forkedFrom, trunk.conversationId, "血统要能追回原对话");
  assert.equal(fork.savedAt, 2000);
  assert.equal(fork.usedTokens, 4321, "预算跨对话延续，分支不能白手起家");
  assert.deepEqual(fork.messages, trunk.messages);
  assert.deepEqual(fork.goal, trunk.goal);
  assert.deepEqual(fork.dirtyCodeFiles, trunk.dirtyCodeFiles, "改完必跑闸跨分支不断链");
  assert.deepEqual(fork.readPaths, trunk.readPaths, "读后写纪律跨分支延续");
  assert.deepEqual(fork.lastCode, trunk.lastCode, "上次代码产物要能直接预览/继续改");

  const ui = fork.uiMessages;
  assert.deepEqual(
    ui.map((m) => m.kind),
    ["user", "assistant", "status"],
    JSON.stringify(ui),
  );
  assert.equal(ui[2].meta.tool, FORK_NOTE_TOOL);
  assert.equal(ui[2].meta.target, cid);
  assert.match(ui[2].content, /分叉/, ui[2].content);
});

test("分支丢掉挂起的反问与中断标记：那次回合还挂在主干上，点了也石沉大海", () => {
  const trunk = trunkSnapshot();
  const fork = buildForkSnapshot(trunk, forkConversationId(trunk.conversationId, 2000), 2000);

  assert.equal("pendingAsk" in fork, false, JSON.stringify(fork));
  assert.equal("interrupted" in fork, false);
  assert.ok(!fork.uiMessages.some((m) => m.kind === "ask-card"));
  // 主干自己的存档不受影响（宿主先写主干再写分支，不能被分叉顺手改坏）
  assert.equal(trunk.pendingAsk.id, "ask-1");
  assert.equal(trunk.uiMessages.length, 3);

  // 没有的字段不硬造空值：干净对话分叉出去，读侧的 if (snap.lastCode) 判断才有意义
  const clean = buildForkSnapshot(
    { version: 1, conversationId: "brain-canvas-8", messages: [], usedTokens: 0, uiMessages: [], savedAt: 1 },
    "brain-canvas-8-fork-x",
    2,
  );
  for (const key of ["lastCode", "goal", "dirtyCodeFiles", "readPaths", "pendingAsk", "interrupted"]) {
    assert.equal(key in clean, false, key);
  }
  assert.equal(clean.forkedFrom, "brain-canvas-8");
});

test("分支存档能被内核吃回去：断点账、产物与历史都接得上", async () => {
  const trunk = trunkSnapshot();
  const cid = forkConversationId(trunk.conversationId, 2000);
  const fork = buildForkSnapshot(trunk, cid, 2000);

  const requests = [];
  const events = [];
  const ports = {
    callLLM: async (req) => {
      requests.push(req);
      return { content: "换个思路：直接流式写盘。", usage };
    },
    postUI: (kind, content, meta) => events.push({ kind, content, meta }),
  };
  const agent = createChatAgent({ ports, model: "stub-model", conversationId: cid }, fork.messages, fork.lastCode);
  agent.resumeFrom({ goal: fork.goal, dirtyCodeFiles: fork.dirtyCodeFiles, readPaths: fork.readPaths });

  const next = agent.serialize();
  assert.deepEqual(next.lastCode, trunk.lastCode);
  assert.deepEqual(next.goal, trunk.goal);
  assert.deepEqual(next.dirtyCodeFiles, trunk.dirtyCodeFiles);
  assert.deepEqual(next.readPaths, trunk.readPaths);

  await agent.reply("那不用 csv 了，改 jsonl");
  const sent = requests[0].messages;
  assert.ok(
    sent.some((m) => m.role === "user" && m.content === "csv 就行"),
    "分支这一轮要带着主干历史问模型，否则就是新对话不是分叉",
  );
  assert.equal(events.at(-1).kind, "assistant");
});

test("在分支里写历史不碰主干存档：数组是复制不是引用", () => {
  const trunk = trunkSnapshot();
  const before = trunk.messages.length;
  const fork = buildForkSnapshot(trunk, forkConversationId(trunk.conversationId, 2000), 2000);

  fork.messages.push({ role: "user", content: "分支里的一轮" });
  fork.uiMessages.push({ id: "cm-x", kind: "user", content: "分支里的一轮" });

  assert.equal(trunk.messages.length, before, "往分支加一轮不能改动主干");
  assert.equal(trunk.uiMessages.length, 3);
});
