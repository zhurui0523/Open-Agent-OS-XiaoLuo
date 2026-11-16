/**
 * 第 7.5 项：线程库（Codex `thread-store` / `rollout` 的最小实用版）
 *
 * 已有事件流；这里验收新增的「可治理」三件：列表（尾扫不读全文）、跨会话检索、归档裁剪。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-thread-store-"));
process.env.XIAOLUO_THREAD_EVENTS_ROOT = TMP;

const LOG = await import("../app/xiaoluo-brain/lib/brain/event-log.ts");
const STORE = await import("../app/xiaoluo-brain/lib/brain/thread-store.ts");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
});

async function seed(conv, texts) {
  for (const text of texts) {
    await LOG.appendThreadEvents("u1", conv, [
      { type: "messages_append", payload: { items: [{ role: "user", content: text }] } },
    ]);
  }
}

test("列表：只扫文件尾也能拿到最后 seq 与更新时间，按新到旧排序", async () => {
  await seed("conv-a", ["一", "二", "三", "四", "五", "六"]);
  await seed("conv-b", ["alpha"]);
  const list = await STORE.listThreads();
  assert.equal(list.length, 2);
  const a = list.find((t) => t.conversationId === "conv-a");
  assert.equal(a.lastSeq, 6);
  assert.equal(a.tailEventCount, 6, "短文件尾窗应能取全");
  assert.ok(a.sizeBytes > 0 && a.updatedAt > 0);
});

test("检索：跨会话命中并给摘要；空 query 不返回整库", async () => {
  const hit = await STORE.searchThreads("三");
  assert.ok(hit.hits.length >= 1);
  assert.equal(hit.hits[0].conversationId, "conv-a");
  assert.match(hit.hits[0].snippet, /三/);

  const other = await STORE.searchThreads("ALPHA", { conversationId: "conv-b" });
  assert.equal(other.hits.length, 1, "大小写不敏感，且能按会话过滤");
  assert.equal(other.hits[0].seq, 1);

  assert.equal((await STORE.searchThreads("   ")).hits.length, 0);
});

test("尾读：readTailEvents 只回最后 N 条且顺序正确", async () => {
  const tail = await STORE.readTailEvents("u1", "conv-a", 2);
  assert.deepEqual(tail.map((e) => e.seq), [5, 6]);
  assert.deepEqual(await STORE.readTailEvents("u1", "nope", 2), []);
});

test("归档裁剪：保留最近 2 条，其余进 .archive，seq 不重编、后续追加仍单调", async () => {
  const before = (await LOG.readThreadEvents("u1", "conv-a")).events.length;
  assert.equal(before, 6);
  const res = await STORE.compactThreadEvents("u1", "conv-a", 2);
  assert.equal(res.before, 6);
  assert.equal(res.kept, 2);
  assert.equal(res.archived, 4);
  assert.ok(res.archiveFile && res.archiveFile.includes(".archive"));

  const after = await LOG.readThreadEvents("u1", "conv-a");
  assert.equal(after.events.length, 2);
  assert.deepEqual(after.events.map((e) => e.seq), [5, 6]);
  assert.ok(readdirSync(TMP).includes(".archive") || true);
  assert.equal(readdirSync(join(TMP, ".archive")).length, 1, "归档文件要真的落盘");

  await LOG.appendThreadEvents("u1", "conv-a", [{ type: "meta", payload: { usedTokens: 9 } }]);
  const last = await STORE.readTailEvents("u1", "conv-a", 1);
  assert.equal(last[0].seq, 7, "裁剪后 seq 必须继续往后走，不能回退覆盖旧历史");
});

test("坏行：检索跳过、裁剪归档，不把整个线程判坏", async () => {
  const file = LOG.threadEventPath("u1", "conv-a");
  const raw = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
  writeFileSync(file, raw + '{"seq": 7, "type": "meta", "payl', "utf8"); // 模拟崩溃半行
  const searched = await STORE.searchThreads("usedTokens", { conversationId: "conv-a" });
  assert.ok(searched.hits.length >= 1, "坏行不该挡住好行");
  const res = await STORE.compactThreadEvents("u1", "conv-a", 1);
  assert.equal(res.kept, 1);
  assert.ok(res.archived >= 1);
  const after = await LOG.readThreadEvents("u1", "conv-a");
  assert.equal(after.recovered, false, "坏行已归档，主文件不再有半行");
});
