/**
 * 第 7.6 项：技能隐式调用识别（Codex `skills/src/selection.rs` 的确定性最小版）
 *
 * 原来技能只在目录里列着，靠模型自己想起来 load_skill。现在每轮按老板原话做一次打分：
 * 显式点名 > 技能名出现 > 描述关键词重叠；命中就注入 [技能提示]，但仍由模型决定是否加载。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillHint, parseSkillCatalog, selectSkills, tokenize } from "../app/xiaoluo-brain/lib/brain/skill-selection.ts";
import { createChatAgent } from "../app/xiaoluo-brain/lib/brain/agent-host.ts";

const CATALOG = [
  "- 通用模型 (文本)",
  "[技能库：先 load_skill 读正文再照做]",
  "- weekly-report | skill | 汇总本周数据并生成周报，输出 Excel 表格",
  "- pdf-extract | skill | 从 PDF 抽取正文与表格，转换为 Markdown",
  "- 苏知柚人设 | skill | 抖音小红书虚拟人人设与口播稿写作",
].join("\n");

test("解析：只认 `- 名字 | skill | 描述`，其它清单行忽略", () => {
  const skills = parseSkillCatalog(CATALOG);
  assert.equal(skills.length, 3);
  assert.equal(skills[0].name, "weekly-report");
  assert.match(skills[0].description, /Excel/);
});

test("分词：英文按词，中文按二元组，去重", () => {
  const tokens = tokenize("生成周报 report");
  assert.ok(tokens.includes("周报"));
  assert.ok(tokens.includes("生成"));
  assert.ok(tokens.includes("report"));
  assert.equal(tokens.length, new Set(tokens).size);
});

test("选技能：显式点名最高分，描述重叠次之，不相关为零", () => {
  const explicit = selectSkills(CATALOG, "用 /pdf-extract 把这个 PDF 转成 Markdown");
  assert.equal(explicit[0].name, "pdf-extract");
  assert.equal(explicit[0].score, 100);

  const desc = selectSkills(CATALOG, "帮我汇总本周数据，写个周报");
  assert.equal(desc[0].name, "weekly-report");
  assert.ok(desc[0].score >= 8, "描述命中要过阈值");

  assert.deepEqual(selectSkills(CATALOG, "今天广州天气怎么样"), [], "不相关不能硬推");
  assert.deepEqual(selectSkills(CATALOG, "   "), []);
});

test("提示文案：带命中原因和描述，便于模型判断要不要加载", () => {
  const hint = buildSkillHint(selectSkills(CATALOG, "用 weekly-report 做周报"));
  assert.match(hint, /\[技能提示\]/);
  assert.match(hint, /weekly-report/);
  assert.match(hint, /原话点名了技能/);
  assert.match(hint, /load_skill/);
  assert.equal(buildSkillHint([]), "");
});

test("真跑：匹配技能时系统消息注入提示，换话题后旧提示不残留", async () => {
  const requests = [];
  const ports = {
    callLLM: async (req) => {
      requests.push(req);
      return { content: "收到。", usage: { promptTokens: 10, completionTokens: 5 } };
    },
    postUI: () => {},
  };
  const agent = createChatAgent({ ports, model: "stub-model", conversationId: "cid-skill-hint", capabilityCatalog: CATALOG });

  await agent.reply("帮我汇总本周数据并生成周报");
  const first = requests[0].messages.filter((m) => m.role === "system" && String(m.content).startsWith("[技能提示]"));
  assert.equal(first.length, 1, "该注入一条技能提示");
  assert.match(String(first[0].content), /weekly-report/);

  await agent.reply("今天广州天气怎么样");
  const systems = agent.serialize().messages.filter((m) => m.role === "system" && String(m.content).startsWith("[技能提示]"));
  assert.equal(systems.length, 0, "换话题后旧提示必须清掉，不能一直误导");
});
