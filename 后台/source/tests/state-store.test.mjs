// P1-3 第二步验收：状态库（派生状态可查）+ 压缩按百分比触发 + 轮末压缩
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultConfig, resolveConfig } from "../shared/agent-config.mjs";

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-state-"));
process.env.XIAOLUO_WORKSPACE_ROOT = TMP;
process.chdir(TMP); // 状态库落在 cwd/.data/brain-state

test.after(async () => {
  // Windows 上 sqlite 文件句柄释放有延迟（同 brain-service-setup 的 EBUSY 教训）：退避重试，超时就不清理
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

test("快照事实抽取：按 tool 轮与 assistant.toolCalls 记工具账本，不吃正文长度溢出", async () => {
  const { extractSnapshotFacts } = await import("../app/lib/brain-state-store.ts");
  const facts = extractSnapshotFacts({
    conversationId: "c1",
    userId: "u1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "读一下 README" },
      { role: "assistant", content: "我来读", toolCalls: [{ name: "read_file" }] },
      { role: "tool", toolName: "read_file", content: "x".repeat(120) },
      { role: "assistant", content: "读完了" },
    ],
    usedTokens: 1234,
  });
  assert.equal(facts.messageCount, 5);
  assert.equal(facts.usedTokens, 1234);
  assert.deepEqual(facts.toolCalls.map((c) => c.tool).sort(), ["read_file", "read_file"]);
  assert.equal(facts.toolCalls.find((c) => c.resultChars > 0).resultChars, 120);
});

test("状态库可写可查：同一会话覆盖写不重复记账，查询拿得到消息数与 token", async () => {
  const store = await import("../app/lib/brain-state-store.ts");
  const base = { conversationId: "conv-1", userId: "state-user", usedTokens: 800, messages: [{ role: "user", content: "hi" }] };
  const first = await store.recordThreadSnapshot(base);
  assert.ok(["sqlite", "ndjson"].includes(first.backend));
  const rows = await store.listThreadState("state-user");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversationId, "conv-1");
  assert.equal(rows[0].messageCount, 1);
  assert.equal(rows[0].usedTokens, 800);

  await store.recordThreadSnapshot({ ...base, usedTokens: 1600, messages: [...base.messages, { role: "assistant", content: "yo" }] });
  const updated = await store.listThreadState("state-user");
  assert.equal(updated[0].usedTokens, 1600, "覆盖写应更新而不是累加 token");
  assert.equal(updated[0].messageCount, 2);
  // 别的用户查不到这条
  assert.deepEqual(await store.listThreadState("someone-else"), []);
});

test("压缩触发线改成百分比：默认 80%，配置可调且被夹在 [40,100]", () => {
  assert.equal(defaultConfig()["agent.compactAtContextPct"], 80);
  const resolved = resolveConfig({ project: { "agent.compactAtContextPct": 70 } });
  assert.equal(resolved.values["agent.compactAtContextPct"], 70);
  const tooLow = resolveConfig({ project: { "agent.compactAtContextPct": 5 } });
  assert.equal(tooLow.values["agent.compactAtContextPct"], 80, "越界值退回默认，不许把阈值调到离谱的低位");
  assert.match(tooLow.warnings.join("|"), /范围内|范围/);
});

test("接线：压缩闸门用 compactThresholdTokens，且轮末会主动压一次", () => {
  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /private compactThresholdTokens\(\)/);
  assert.match(agent, /compactAtContextPct \?\? 80/);
  assert.match(agent, /measureContext\(\)\.tokens <= threshold/);
  assert.match(agent, /轮末压缩/);
  assert.match(agent, /compactHistoryIfNeeded\(\)/, "轮末要真的调用压缩");
  assert.ok(!/tokens <= config\.contextBudget/.test(agent), "旧的全撑满才压判断应已替换");

  const host = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/agent-host.ts", import.meta.url), "utf8");
  assert.match(host, /compactAtContextPct: Number\(values\["agent\.compactAtContextPct"\]\)/);
});

test("文件变更账：从工具参数派生，写/移动/删除都记账，重复 PUT 不重复记", async () => {
  const store = await import("../app/lib/brain-state-store.ts");
  const facts = {
    conversationId: "conv-files",
    userId: "file-user",
    usedTokens: 100,
    messages: [
      { role: "user", content: "改一下" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "write_file", arguments: { path: "src/a.ts" } },
          { name: "edit_file", arguments: { path: "src/a.ts" } },
          { name: "move_file", arguments: { from: "src/a.ts", to: "src/b.ts" } },
          { name: "delete_file", arguments: { path: "src/old.ts" } },
          { name: "read_file", arguments: { path: "src/b.ts" } },
        ],
      },
    ],
  };
  const derived = store.extractFileChanges(facts);
  assert.deepEqual(
    derived.map((c) => `${c.op}:${c.path}`),
    ["write:src/a.ts", "move:src/b.ts", "delete:src/old.ts"],
    "同一路径写两次只记一次；只读工具不进变更账",
  );
  assert.equal(derived.find((c) => c.op === "move").from, "src/a.ts");

  await store.recordThreadSnapshot(facts);
  const first = await store.listFileChanges("file-user", "conv-files");
  assert.equal(first.length, 3);
  await store.recordThreadSnapshot(facts);
  const again = await store.listFileChanges("file-user", "conv-files");
  assert.equal(again.length, 3, "快照全量覆盖，重复 PUT 不该把同一条变更记成两条");
  const rows = await store.listThreadState("file-user");
  assert.equal(rows[0].fileChanges, 3);
});

test("接线：状态接口不吐正文，文件变更接口要 conversationId", () => {
  const files = readFileSync(new URL("../app/api/v2/state/files/route.ts", import.meta.url), "utf8");
  assert.match(files, /conversationId 必填/);
  assert.match(files, /listFileChanges/);
  assert.ok(!/content/.test(files), "变更接口不该吐文件内容");
});

test("接线：存档 PUT 会记账，且记账失败不拖垮存档；状态接口只回派生状态", () => {
  const chat = readFileSync(
  new URL("../app/api/v2/chat/[conversationId]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(chat, /recordThreadSnapshot/);
  assert.match(chat, /catch \{\s*state = null;/s, "记账失败必须被吞掉，不能影响存档");

  const route = readFileSync(new URL("../app/api/v2/state/threads/route.ts", import.meta.url), "utf8");
  assert.match(route, /listThreadState/);
  assert.ok(!/messages/.test(route), "状态接口不该把消息正文吐出去");
});
