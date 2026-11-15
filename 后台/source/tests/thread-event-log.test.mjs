// P1-3 验收：append-only 事件流 + 崩溃重建 + 压缩覆盖 + 快照路由接线
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-thread-"));
process.env.XIAOLUO_THREAD_EVENTS_ROOT = TMP;

const { appendThreadEvents, readThreadEvents, rebuildThread, diffSnapshotEvents, threadEventPath } =
  await import("../app/xiaoluo-brain/lib/brain/event-log.ts");

test.afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const USER = "u1";
const CONV = "conv-a";

const msg = (role, content) => ({ role, content });

test("事件流 append-only：seq 单调、跨批次接续、读回顺序一致", async () => {
  await appendThreadEvents(USER, CONV, [
    { type: "messages_append", payload: { items: [msg("user", "你好")] } },
  ]);
  await appendThreadEvents(USER, CONV, [
    { type: "messages_append", payload: { items: [msg("assistant", "在的")] } },
    { type: "meta", payload: { usedTokens: 120 } },
  ]);
  const { events, recovered } = await readThreadEvents(USER, CONV);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], "seq 必须单调接续，重启后不能重复");
  assert.equal(recovered, false);
  assert.equal(rebuildThread(events).messages.length, 2);
});

test("崩溃恢复：末行写了一半也能读出前面的事件，并标记 recovered", async () => {
  const file = threadEventPath(USER, "conv-crash");
  await appendThreadEvents(USER, "conv-crash", [
    { type: "messages_append", payload: { items: [msg("user", "第一条")] } },
    { type: "messages_append", payload: { items: [msg("assistant", "第二条")] } },
  ]);
  // 模拟进程被强杀：末行只写进一半
  const broken = readFileSync(file, "utf8") + '{"seq":3,"ts":1,"type":"messages_append","payload":{"items":[{"role":"user","content":"第三';
  writeFileSync(file, broken, "utf8");

  const { events, recovered, skippedLines } = await readThreadEvents(USER, "conv-crash");
  assert.equal(recovered, true, "半份末行必须被识别为已恢复状态");
  assert.equal(skippedLines, 1);
  assert.equal(events.length, 2, "前面完整的事件一条都不能丢");
  assert.equal(rebuildThread(events).messages[1].content, "第二条");
});

test("压缩用 messages_replace 覆盖：重建后是压缩后的列表，旧消息不再残留", async () => {
  await appendThreadEvents(USER, "conv-zip", [
    { type: "messages_append", payload: { items: [msg("user", "A"), msg("assistant", "B")] } },
  ]);
  await appendThreadEvents(USER, "conv-zip", [
    {
      type: "messages_replace",
      payload: { items: [msg("system", "摘要：老板要 A"), msg("user", "继续")], reason: "compaction" },
    },
  ]);
  const rebuilt = rebuildThread((await readThreadEvents(USER, "conv-zip")).events);
  assert.equal(rebuilt.messages.length, 2);
  assert.equal(rebuilt.messages[0].role, "system");
  assert.equal(rebuilt.messages[0].content, "摘要：老板要 A");
  assert.equal(rebuilt.lastCompactionAt, 2);
});

test("快照 diff：纯追加只写增量，压缩/改写写整份替换，元数据单独记", () => {
  const prev = { messages: [msg("user", "A"), msg("assistant", "B")], usedTokens: 10, interrupted: false };
  const appended = diffSnapshotEvents(prev, {
    messages: [msg("user", "A"), msg("assistant", "B"), msg("user", "C")],
    usedTokens: 30,
    interrupted: false,
  });
  assert.deepEqual(appended.map((d) => d.type), ["messages_append", "meta"]);
  assert.equal(appended[0].payload.items.length, 1, "纯追加只带增量，不能每次重写全文");
  assert.equal(appended[1].payload.usedTokens, 30);

  const compacted = diffSnapshotEvents(prev, {
    messages: [msg("system", "摘要")],
    usedTokens: 30,
    interrupted: true,
  });
  assert.deepEqual(compacted.map((d) => d.type), ["messages_replace", "meta"]);
  assert.equal(compacted[0].payload.reason, "compaction");
  assert.equal(compacted[1].payload.interrupted, true);
});

test("路由接线：先追加事件再写快照；半份快照读路径改走事件流重建", async () => {
  const route = readFileSync(
    new URL("../app/api/v2/chat/[conversationId]/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /appendThreadEvents\(user\.id, conversationId, drafts\)/);
  assert.match(route, /diffSnapshotEvents/);
  // 写顺序：事件先于快照，否则尾部丢失
  assert.ok(
    route.indexOf("appendThreadEvents") < route.indexOf('fs.writeFile(file, text'),
    "必须先追加事件再写快照",
  );
  assert.match(route, /rebuildThread\(events\)/);
  assert.match(route, /rebuiltFromEvents: true/);
});
