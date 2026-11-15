// P1-5 验收：工具检索命中率（20 条任务描述）、上下文自省、截断保尾、注册接线
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildToolCatalog, searchTools } from "../app/xiaoluo-brain/lib/brain/tool-search.ts";
import { buildChatToolSchemas } from "../app/xiaoluo-brain/lib/brain/chat-tools.ts";
import { truncateToolResult } from "../app/xiaoluo-brain/lib/brain/truncation.ts";

const CAPS = {
  webSearchEnabled: true,
  fsEnabled: true,
  commandEnabled: true,
  interactiveEnabled: true,
  gitEnabled: true,
  browserEnabled: true,
  serviceEnabled: true,
  memoryEnabled: true,
  deployEnabled: true,
  visionEnabled: true,
  desktopEnabled: true,
  uiaEnabled: true,
  webEnabled: true,
  reviewEnabled: true,
  sshEnabled: true,
};

test("工具目录覆盖全部注册 schema，且新工具都在里面", () => {
  const schemas = buildChatToolSchemas(CAPS);
  const catalog = buildToolCatalog(schemas);
  assert.ok(catalog.length >= 34, "目录至少覆盖 34 个工具，实际 " + catalog.length);
  for (const name of ["tool_search", "context_meter", "read_file", "run_command", "git", "load_skill"]) {
    assert.ok(catalog.some((entry) => entry.name === name), "目录缺 " + name);
  }
});

test("20 条任务描述：检索命中率 ≥ 90%（模型不该靠猜工具名）", () => {
  const schemas = buildChatToolSchemas(CAPS);
  const tasks = [
    ["把 src 里的文件读出来看看", "read_file"],
    ["列出当前目录都有什么", "list_dir"],
    ["在代码里搜一下 TODO 注释", "grep_files"],
    ["按文件名找所有 .test 文件", "find_files"],
    ["把这段说明写进 notes.md", "write_file"],
    ["把第 3 行那个函数名改掉", "edit_file"],
    ["跑一下 pnpm build 看报错", "run_command"],
    ["继续往刚才的进程里输入 yes", "write_stdin"],
    ["把改动提交到仓库", "git"],
    ["起一个 dev server 预览", "start_service"],
    ["这个 3001 端口是谁在跑", "locate_local_service"],
    ["打开网页看看文档正文", "browse_page"],
    ["截个图确认界面渲染对不对", "inspect_screen"],
    ["加载技能库里的公众号写作技能", "load_skill"],
    ["记住老板要求回复用中文", "add_memory"],
    ["把这一轮做了什么列成待办清单", "todo_write"],
    ["帮我生成一张产品图", "generate_media"],
    ["写一个带图表的网页", "write_code"],
    ["当前上下文还剩多少", "context_meter"],
    ["有哪些工具能做文件搜索", "tool_search"],
  ];

  let hit = 0;
  const misses = [];
  for (const [task, expectName] of tasks) {
    const { matches } = searchTools(schemas, task, 5);
    if (matches.some((m) => m.name === expectName)) hit += 1;
    else misses.push(task + " → 期望 " + expectName + "，实际 " + matches.map((m) => m.name).join("/"));
  }
  const rate = hit / tasks.length;
  assert.ok(rate >= 0.9, "命中率 " + (rate * 100).toFixed(0) + "% 低于 90%\n" + misses.join("\n"));
});

test("检索不会串味：查「git 提交」不该把文件读取排第一", () => {
  const schemas = buildChatToolSchemas(CAPS);
  const { matches } = searchTools(schemas, "git 提交", 3);
  assert.equal(matches[0].name, "git");
  assert.ok(!matches.slice(0, 1).some((m) => m.name === "read_file"));
});

test("截断保尾：2000 行以上输出仍能看到最后的报错行", () => {
  const log = Array.from({ length: 2400 }, (_, i) => `line ${i}`).join("\n") + "\nERROR TS2345 at final line";
  const cut = truncateToolResult(log, 2000);
  assert.ok(cut.length <= 2100, "不能超上限（含省略说明预留）");
  assert.match(cut, /ERROR TS2345 at final line/, "尾部报错被切掉了，模型会看残缺结果继续瞎猜");
  assert.match(cut, /省略/);
});

test("接线：两个新工具都注册进 schema，且 dispatch 有对应分支", () => {
  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /case "tool_search":/);
  assert.match(agent, /case "context_meter":/);
  assert.match(agent, /searchTools\(schemas, query, limit\)/);
  assert.match(agent, /measureContext\(\)/);

  const tools = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-tools.ts", import.meta.url), "utf8");
  assert.match(tools, /name: "tool_search"/);
  assert.match(tools, /name: "context_meter"/);
});
