/**
 * 小逻工具面两条 P0 纪律测试（对齐 Codex 的源码做法）
 *
 *  - 截断（truncation.ts）：以前只切头，命令/构建结果最关键的报错正文和 exit code
 *    都在结尾，正好被切掉。现在保首尾、中间挖除，且按工具给预算。
 *  - edit_file（patch.ts）：以前「逐字符 + 全文唯一」一条对不上就整批失败，
 *    而且只读前 2000 行，后半段的代码永远改不动。现在三级容错定位 + 一次多 hunk，
 *    全成或全不成。
 * 纯函数直接调用；在 Agent 里的接法按仓库惯例做源码断言。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyEditHunks, applyContextHunks, parsePatch } from "../app/xiaoluo-brain/lib/brain/patch.ts";
import { truncateToolResult } from "../app/xiaoluo-brain/lib/brain/truncation.ts";
import { DEFAULT_CHAT_AGENT_CONFIG } from "../app/xiaoluo-brain/lib/brain/agent-ports.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("长结果保首尾、中间挖除，尾部报错不再被切掉", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
  const text = lines.join("\n");
  const out = truncateToolResult(text, 800);

  assert.ok(out.length < text.length);
  assert.ok(out.startsWith("line 0 "), out.slice(0, 40));
  assert.ok(out.endsWith(lines[199]), out.slice(-40));
  assert.match(out, /中间省略 \d+ 字符/);
  // 截断标记必须说清怎么取回缺失部分，否则小逻只会原样重试
  assert.match(out, /offset\/limit|grep_files/);
});

test("没超预算的结果原样返回", () => {
  assert.equal(truncateToolResult("short output\nexit 0", 2000), "short output\nexit 0");
});

test("预算极小也不炸，仍然两头都留", () => {
  const out = truncateToolResult("y".repeat(4000), 100);
  assert.ok(out.length < 4000);
  assert.ok(out.startsWith("yyy"));
  assert.ok(out.endsWith("yyy"));
});

test("逐字符命中：包括不在行首的片段", () => {
  const src = "const total = price * qty;";
  const res = applyEditHunks(src, [{ oldText: "price * qty", newText: "price * qty * 0.9" }]);
  assert.equal(res.content, "const total = price * qty * 0.9;");
  assert.equal(res.outcomes[0].level, "exact");
});

test("行尾空白差一点也能命中（第二级）", () => {
  const src = ["const a = 1;  ", "const b = 2;"].join("\n");
  const res = applyEditHunks(src, [{ oldText: "const a = 1;\nconst b = 2;", newText: "const ab = 3" }]);
  assert.equal(res.content, "const ab = 3");
  assert.equal(res.outcomes[0].level, "trailing");
  assert.equal(res.outcomes[0].line, 1);
});

test("缩进写错也能命中（第三级），替换后按新文本的缩进落", () => {
  const src = ["export function add(a, b) {", "    const sum = a + b;", "    return sum;", "}"].join("\n");
  const res = applyEditHunks(src, [{ oldText: "  const sum = a + b;\n  return sum;", newText: "  return a + b;" }]);
  assert.equal(res.content, ["export function add(a, b) {", "  return a + b;", "}"].join("\n"));
  assert.equal(res.outcomes[0].level, "trimmed");
  assert.equal(res.outcomes[0].line, 2);
});

test("多处命中判不唯一，整批不落盘", () => {
  const src = ["a", "dup", "b", "dup", "c"].join("\n");
  const res = applyEditHunks(src, [{ oldText: "dup", newText: "x" }]);
  assert.equal(res.content, null);
  assert.match(res.outcomes[0].error, /不唯一/);
});

test("一次多 hunk：全部命中才改，有一处对不上整批不动", () => {
  const src = "alpha\nbeta\ngamma\ndelta";
  const both = applyEditHunks(src, [
    { oldText: "alpha", newText: "ALPHA" },
    { oldText: "delta", newText: "DELTA" },
  ]);
  assert.equal(both.content, "ALPHA\nbeta\ngamma\nDELTA");

  const broken = applyEditHunks(src, [
    { oldText: "alpha", newText: "ALPHA" },
    { oldText: "no such line", newText: "X" },
  ]);
  assert.equal(broken.content, null, "有一处没命中就不该给出新内容");
  assert.equal(broken.outcomes[0].ok, true);
  assert.equal(broken.outcomes[1].ok, false);
  assert.match(broken.outcomes[1].error, /三级都没匹配到/);
});

test("空白 oldText 直接拒，避免整文件被塞进空白", () => {
  const res = applyEditHunks("a\nb", [{ oldText: "   \n  ", newText: "x" }]);
  assert.equal(res.content, null);
  assert.match(res.outcomes[0].error, /全是空白/);
});

test("edit_file 接法：翻页读全文 + 三级匹配 + 全成或全不成", async () => {
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");

  assert.match(chatAgent, /import \{ applyEditHunks, applyContextHunks, parsePatch, type EditHunk \} from "\.\/patch"/);
  assert.match(chatAgent, /import \{ truncateToolResult \} from "\.\/truncation"/);
  // 以前只读前 2000 行，后半段代码永远定位不到
  assert.doesNotMatch(chatAgent, /readFile\(args\.path, \{ offset: 1, limit: 2000 \}\)/);
  assert.match(chatAgent, /private async readWholeFile\(path: string\)/);
  assert.match(chatAgent, /limit: EDIT_READ_WINDOW_LINES/);
  // 半份全文回写会削掉文件尾巴：翻页翻不动或行数不满时必须拒写
  assert.match(chatAgent, /read\.content === previous\) return null/);
  assert.match(chatAgent, /lines\.length < read\.totalLines\) return null/);
  assert.match(chatAgent, /patch\.content === null[\s\S]{0,700}文件未改动/);
  assert.match(chatAgent, /await ports\.fs\.writeFile\(args\.path, patch\.content\)/);
  // 容错命中必须回执，否则小逻不知道自己是靠放宽空白改上的
  assert.match(chatAgent, /忽略行尾空白.*忽略行首尾空白/s);
});

test("截断预算按工具类型给：命令/交付类的尾部留得住", async () => {
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  const limits = /const TOOL_RESULT_LIMITS: Record<string, number> = \{([\s\S]*?)\n\};/.exec(chatAgent);
  assert.ok(limits, "TOOL_RESULT_LIMITS 表还在");
  for (const tool of ["run_command", "git", "deploy_program", "package_program", "edit_file", "write_file"]) {
    assert.match(limits[1], new RegExp(`${tool}: \\d{4,}`), tool);
  }
  // 兜底预算从 2000 提到 4000：2000 时任何稍长的命令输出都只剩过程、看不到结果
  // 档位现在是端口协议的导出数据，直接读值断言（抄源码正则会随搬家一起烂）
  assert.equal(DEFAULT_CHAT_AGENT_CONFIG.maxToolResultChars, 4000);
});

test("edit_file 工具声明：单处与两种入参形态都说清", async () => {
  const chatTools = await source("app/xiaoluo-brain/lib/brain/chat-tools.ts");
  const schema = /const EDIT_FILE_SCHEMA = \{[\s\S]*?\n\};/.exec(chatTools);
  assert.ok(schema, "EDIT_FILE_SCHEMA 还在");
  assert.match(schema[0], /required: \["path"\]/);
  assert.match(schema[0], /hunks: \{[\s\S]*?type: "array"/);
  assert.match(schema[0], /全部命中才写盘/);
});

// ---------- 第 1 项：结构化补丁 apply_patch（@@ 上下文锚点） ----------

const PATCH_BASIC = `*** Begin Patch
*** Update File: src/a.ts
@@ function add
 export function add(a, b) {
-  return a + b;
+  return a + b; // sum
 }
*** End Patch`;

test("apply_patch 解析：update 段落带 @@ 锚点，+/-/空格前缀各归其位", () => {
  const { ops } = parsePatch(PATCH_BASIC);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "update");
  assert.equal(ops[0].path, "src/a.ts");
  const hunk = ops[0].hunks[0];
  assert.equal(hunk.anchor, "function add");
  assert.deepEqual(
    hunk.lines.map((l) => l.kind),
    ["context", "remove", "add", "context"],
  );
});

test("apply_patch 落地：上下文逐行匹配，只改被 - / + 标记的那一行", () => {
  const src = ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n");
  const { ops } = parsePatch(PATCH_BASIC);
  const res = applyContextHunks(src, ops[0].hunks);
  assert.equal(res.content, ["export function add(a, b) {", "  return a + b; // sum", "}", ""].join("\n"));
  assert.equal(res.outcomes[0].line, 1);
  assert.equal(res.outcomes[0].added, 1);
  assert.equal(res.outcomes[0].removed, 1);
});

test("apply_patch：上下文对不上就整批不落地（不做模糊匹配，也不猜）", () => {
  const src = ["export function add(a, b) {", "  return a - b;", "}"].join("\n");
  const { ops } = parsePatch(PATCH_BASIC);
  const res = applyContextHunks(src, ops[0].hunks);
  assert.equal(res.content, null);
  assert.match(res.outcomes[0].error, /上下文对不上/);
});

test("apply_patch：同一段上下文命中多处时用 @@ 锚点收敛，收敛不了就报不唯一", () => {
  const src = [
    "function a() {",
    "  const x = 1;",
    "}",
    "function b() {",
    "  const x = 1;",
    "}",
  ].join("\n");
  const patch = `*** Begin Patch
*** Update File: src/a.ts
@@ function b
-  const x = 1;
+  const x = 2;
*** End Patch`;
  const { ops } = parsePatch(patch);
  const res = applyContextHunks(src, ops[0].hunks);
  assert.ok(res.content, res.outcomes[0].error);
  assert.match(res.content, /function b\(\) \{\n  const x = 2;\n\}/);

  // 没有锚点、同一行又在两处出现：必须报不唯一，绝不能改错那个
  const noAnchor = `*** Begin Patch
*** Update File: src/a.ts
-  const x = 1;
+  const x = 2;
*** End Patch`;
  const ambiguous = applyContextHunks(src, parsePatch(noAnchor).ops[0].hunks);
  assert.equal(ambiguous.content, null);
  assert.match(ambiguous.outcomes[0].error, /不唯一/);
});

test("apply_patch：一次补丁可 update + add + delete 多个文件", () => {
  const patch = `*** Begin Patch
*** Update File: src/a.ts
@@ anchor
 keep
-remove me
+added
*** Add File: src/new.ts
+export const fresh = 1;
+export const more = 2;
*** Delete File: src/old.ts
*** End Patch`;
  const { ops } = parsePatch(patch);
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.path}`),
    ["update:src/a.ts", "add:src/new.ts", "delete:src/old.ts"],
  );
  assert.equal(ops[1].hunks[0].lines.filter((l) => l.kind === "add").length, 2);
});

test("apply_patch 格式错误必须带行号报出来，而不是猜着改", () => {
  assert.throws(() => parsePatch("*** Update File: a.ts\n x\n"), /Begin Patch/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Update File: a.ts\n@@ y\nx\n*** End Patch"), /第 4 行/);
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: a.ts\n*** End Patch"),
    /没有任何 @@ hunk|没有任何 hunk/,
  );
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Move to: b.ts\n*** End Patch"),
    /Move to/,
  );
});

test("apply_patch 接法：工具声明已注册、执行器先全算后落盘", async () => {
  const chatTools = await source("app/xiaoluo-brain/lib/brain/chat-tools.ts");
  assert.match(chatTools, /const APPLY_PATCH_SCHEMA = \{/);
  assert.match(chatTools, /EDIT_FILE_SCHEMA, APPLY_PATCH_SCHEMA/);
  assert.match(chatTools, /name: "apply_patch"/);

  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  assert.match(chatAgent, /case "apply_patch":/);
  assert.match(chatAgent, /private async execApplyPatch\(call: ToolCall\)/);
  // 全部文件都算完才写盘：只要一处锚不上就整批不动
  assert.match(chatAgent, /if \(failures\.length\) \{[\s\S]{0,400}全部文件都没动/);
  // 删除仍守"先看过再删"的纪律
  assert.match(chatAgent, /删除前先看一眼——本轮还没 read_file 过它/);
});

