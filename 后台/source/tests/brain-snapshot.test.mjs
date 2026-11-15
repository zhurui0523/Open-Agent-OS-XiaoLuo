// 快照回归：把关键中间态序列化成 JSON，改动必须显式 approve。
// 更新方式：XIAOLUO_SNAPSHOT_UPDATE=1 node node_modules/tsx/dist/cli.mjs --test tests/brain-snapshot.test.mjs
// 没有这个环境变量时，任何差异都判失败 —— 绝不允许测试自己悄悄改写基线。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Journal } from "../app/xiaoluo-brain/lib/brain/journal.ts";
import { applyEditHunks } from "../app/xiaoluo-brain/lib/brain/patch.ts";
import { truncateToolResult } from "../app/xiaoluo-brain/lib/brain/truncation.ts";
import { buildForkSnapshot, forkConversationId } from "../app/xiaoluo-brain/lib/brain/conversation.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP_FILE = join(HERE, "__snapshots__", "brain-snapshots.json");
const UPDATE = process.env.XIAOLUO_SNAPSHOT_UPDATE === "1";

/** 时间戳不影响语义，统一压成相对序号，否则每次跑都"变" */
function freezeJournal(entries) {
  const base = entries[0]?.ts ?? 0;
  return entries.map((entry) => ({ ...entry, ts: `+${entry.ts - base}ms` }));
}

function buildSnapshots() {
  const cases = {};

  // 1) 工具结果截断：首 60 / 尾 40，中间挖掉并要求能说清挖了多少
  const buildLog = Array.from({ length: 400 }, (_, i) => `line ${i} ok`).join("\n") + "\nFAIL src/a.ts:12 expected 1 got 2";
  cases.truncate = {
    "长日志（有换行，应保尾）": truncateToolResult(buildLog, 800),
    "单行超长（无换行，按字符硬切）": truncateToolResult("x".repeat(3000), 600),
    "刚好未超限（原样返回）": truncateToolResult("short result", 600),
    "极小上限（仍有省略说明）": truncateToolResult(buildLog, 200),
  };

  // 2) edit_file 容错命中：exact / trailing / trimmed / 未命中
  const source = "function add(a, b) {\n  return a + b;\n}\n";
  cases.patch = {
    "逐字符命中": applyEditHunks(source, [{ oldText: "  return a + b;", newText: "  return a + b; // sum" }]),
    "行尾空白差异（trailing）": applyEditHunks(source, [{ oldText: "  return a + b;   ", newText: "  return a + b; // trimmed-tail" }]),
    "行首尾都差（trimmed）": applyEditHunks(source, [{ oldText: "    return a + b;   ", newText: "  return a + b; // trimmed" }]),
    "未命中（整批不落地）": applyEditHunks(source, [{ oldText: "return a - b", newText: "return a - b" }]),
  };

  // 3) journal 事件序列：seq 单调、fold 聚合工具调用、recent 取尾部
  const journal = new Journal();
  journal.append("turn_start", "老板：帮我看下构建为什么失败");
  journal.append("tool_call", "调用 shell", { tool: "shell", argv: ["pnpm", "build"] });
  journal.append("tool_result", "构建失败：TS2345", { ok: false });
  journal.append("tool_call", "调用 read_file", { tool: "read_file", path: "src/a.ts" });
  journal.append("turn_end", "本轮结束：2 步，失败 1 次", { steps: 2, failures: 1 });
  cases.journal = {
    serialize: freezeJournal(journal.serialize()),
    recent2: freezeJournal(journal.recent(2)),
    fold: journal.fold(1200),
    fold窄上限: journal.fold(40),
  };

  // 4) 会话 fork：ask-card 必须被过滤掉，forkedFrom 指回源会话
  const persistence = {
    version: 1,
    conversationId: "conv-source",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "继续" },
      { role: "assistant", content: "好的" },
    ],
    usedTokens: 1234,
    uiMessages: [
      { kind: "user", text: "继续" },
      { kind: "ask-card", text: "选哪个?" },
      { kind: "assistant", text: "好的" },
    ],
  };
  cases.fork = {
    snapshot: buildForkSnapshot(persistence, "conv-fork", 1_700_000_000_000),
    id格式: forkConversationId("conv-source", 1_700_000_000_000).replace(/\d{6,}/g, "<epoch>"),
  };

  return cases;
}

function diffTree(expected, actual, path = "", out = []) {
  if (typeof expected !== typeof actual) {
    out.push(`${path}: 类型不同 (${typeof expected} → ${typeof actual})`);
    return out;
  }
  if (expected && typeof expected === "object") {
    const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
    for (const key of keys) diffTree(expected?.[key], actual?.[key], `${path}.${key}`, out);
    return out;
  }
  if (expected !== actual) out.push(`${path}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
  return out;
}

test("brain 快照：截断 / 补丁容错 / journal / fork 结构未被无意改动", () => {
  const fresh = buildSnapshots();
  mkdirSync(dirname(SNAP_FILE), { recursive: true });

  if (!existsSync(SNAP_FILE)) {
    if (!UPDATE) {
      throw new Error(
        `缺少基线快照 ${SNAP_FILE}。确认当前行为符合预期后，用 XIAOLUO_SNAPSHOT_UPDATE=1 生成一次。`,
      );
    }
    writeFileSync(SNAP_FILE, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    return;
  }

  const baseline = JSON.parse(readFileSync(SNAP_FILE, "utf8"));

  if (UPDATE) {
    writeFileSync(SNAP_FILE, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    return;
  }

  const diffs = diffTree(baseline, fresh, "snapshot");
  assert.equal(
    diffs.length,
    0,
    "快照发生变化，必须显式确认：\n" +
      diffs.slice(0, 12).join("\n") +
      "\n确认无误后用 XIAOLUO_SNAPSHOT_UPDATE=1 单独更新该文件，并 review diff。",
  );
});
