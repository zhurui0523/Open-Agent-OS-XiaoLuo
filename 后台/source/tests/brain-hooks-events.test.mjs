/**
 * 第 2 项：hooks 事件面追平（Codex hooks crate 的 session/prompt/permission 事件）
 *
 * 原来只有"工具前后"两个点，规则写在 chat-agent 的私有解析器里、改不动也测不了。
 * 现在解析/匹配/模板替换抽成 hooks.ts，工具面接上四个新事件：
 *   session_start / session_end / user_prompt_submit / permission_request
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseHooks, hookMatches, fillCommand, normalizeEvent } from "../app/xiaoluo-brain/lib/brain/hooks.ts";
import { createChatAgent } from "../app/xiaoluo-brain/lib/brain/agent-host.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("解析：[[hook]] 块 + 老写法（不写 when）默认 pre，未知事件整条丢弃", () => {
  const raw = `
# 老写法：工具前置拦截
[[hook]]
tool = "run_command"
match = "rm -rf"
message = "禁止递归删除"

# 新事件：会话开始跑一次体检
[[hook]]
when = "session_start"
command = "node scripts/health.mjs"

[[hook]]
when = "permission_request"
match = "git push"
message = "推送前先让人看一眼"

[[hook]]
when = "不是个事件"
command = "echo x"
`;
  const hooks = parseHooks(raw);
  assert.equal(hooks.length, 3);
  assert.equal(hooks[0].when, "pre");
  assert.equal(hooks[1].when, "session_start");
  assert.equal(hooks[2].when, "permission_request");
  // 认不出的事件名不许静默降级成 pre（那会把观测钩子变成拦截器）
  assert.ok(!hooks.some((h) => h.command === "echo x"));
});

test("事件名归一：大小写、驼峰、横线写法都认，乱写返回 null", () => {
  assert.equal(normalizeEvent(undefined), "pre");
  assert.equal(normalizeEvent("PreToolUse"), "pre");
  assert.equal(normalizeEvent("post-tool-use"), "post");
  assert.equal(normalizeEvent("SessionStart"), "session_start");
  assert.equal(normalizeEvent("session-end"), "session_end");
  assert.equal(normalizeEvent("PermissionRequest"), "permission_request");
  assert.equal(normalizeEvent("user-prompt-submit"), "user_prompt_submit");
  assert.equal(normalizeEvent("乱写"), null);
});

test("匹配：事件 + 工具 + 正则三重门，正则写坏不命中也不炸", () => {
  const rule = { when: "permission_request", match: "git push", command: "check.sh" };
  assert.equal(hookMatches(rule, "permission_request", { text: "git push origin main" }), true);
  assert.equal(hookMatches(rule, "pre", { text: "git push origin main" }), false, "事件不对不命中");
  assert.equal(hookMatches(rule, "permission_request", { text: "ls" }), false, "文本不命中");

  const toolRule = { when: "pre", tool: "run_command", match: "rm -rf" };
  assert.equal(hookMatches(toolRule, "pre", { tool: "run_command", argsJson: '{"command":"rm -rf /"}' }), true);
  assert.equal(hookMatches(toolRule, "pre", { tool: "write_file", argsJson: '{"content":"rm -rf"}' }), false);

  const broken = { when: "pre", match: "([", command: "x" };
  assert.equal(hookMatches(broken, "pre", { argsJson: "a" }), false);
});

test("命令模板：{command} {prompt} {tool} {path} 都替换，未声明的占位符原样留着（看出写错）", () => {
  assert.equal(
    fillCommand("node check.mjs --cmd '{command}' --tool {tool}", { command: "git push", tool: "run_command" }),
    "node check.mjs --cmd 'git push' --tool run_command",
  );
  // 没传的占位符不悄悄清空：留原样，老板一眼能看出命令写错了
  assert.equal(fillCommand("echo {missing}", {}), "echo {missing}");
  assert.equal(fillCommand("echo {command}", { command: "" }), "echo ");
});

test("接线：四个新事件都在 chat-agent 里落地，旧私有解析器已删除", async () => {
  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  assert.match(chatAgent, /import \{ parseHooks, hookMatches, fillCommand, type HookRule, type HookEvent \} from "\.\/hooks"/);
  assert.doesNotMatch(chatAgent, /parseHooksToml/, "解析器搬走后旧方法不该留");
  assert.match(chatAgent, /private async runEventHooks\(/);
  // session_start 只在会话首轮跑，别每轮都体检一遍
  assert.match(chatAgent, /if \(this\.turnId === 1\)[\s\S]{0,220}session_start/);
  assert.match(chatAgent, /runEventHooks\("user_prompt_submit"/);
  assert.match(chatAgent, /runEventHooks\("session_end"/);
  assert.match(chatAgent, /runEventHooks\("permission_request"/);
  // permission_request 退出码非 0 必须挡住命令，而不是只提醒
  assert.match(chatAgent, /if \(verdict\.blocked\)[\s\S]{0,600}命令被工作区 hooks\.toml 的 permission_request 钩子拒绝/);
  // 钩子跑外部命令是有限额的，否则每轮能无限烧
  assert.match(chatAgent, /postHookRunsThisTurn >= 6/);
});

/** 真跑一轮：桩端口 + 脚本化模型，验事件钩子真的在轮首/轮末/命令前落地 */
function runtimeHarness(hooksToml, scriptedSteps) {
  const events = [];
  const ran = [];
  const requests = [];
  let step = 0;
  const ports = {
    callLLM: async (req) => {
      requests.push(req);
      if (req.messages[0]?.role === "system" && String(req.messages[0].content).includes("交付物核对员")) {
        return { content: '{"ok": true, "gaps": []}', usage: { promptTokens: 10, completionTokens: 5 } };
      }
      const s = scriptedSteps[Math.min(step, scriptedSteps.length - 1)];
      step += 1;
      if (s.toolCall) {
        return {
          content: s.content ?? "",
          toolCalls: [{ id: "call-" + step, name: s.toolCall.name, arguments: s.toolCall.arguments }],
          usage: { promptTokens: 20, completionTokens: 8 },
          finishReason: "tool_calls",
        };
      }
      return { content: s.content ?? "好的。", usage: { promptTokens: 20, completionTokens: 8 } };
    },
    postUI: (kind, content, meta) => events.push({ kind, content, meta }),
    fs: { readFile: async () => ({ content: hooksToml }) },
    command: {
      run: async (cmd) => {
        ran.push(cmd);
        // 钩子命令按前缀决定结果：deny-* 一律失败（模拟否决）；业务命令照常成功
        return { stdout: "", stderr: "", exitCode: cmd.startsWith("deny-") ? 1 : 0 };
      },
    },
  };
  const agent = createChatAgent({ ports, model: "stub-model", conversationId: "cid-hooks-events" });
  return { agent, events, ran, requests };
}

test("真跑：session_start / user_prompt_submit 在轮首执行，permission_request 非 0 直接拒命令", async () => {
  const hooks = `
[[hook]]
when = "session_start"
command = "check-start"

[[hook]]
when = "user_prompt_submit"
command = "check-prompt"

[[hook]]
when = "permission_request"
match = "rm -rf"
command = "deny-rm"
message = "不许递归删"
`;
  const { agent, events, ran } = runtimeHarness(hooks, [
    { toolCall: { name: "run_command", arguments: { command: "rm -rf build" } } },
    { content: "这命令被拦了，我换个做法。" },
  ]);
  const outcome = await agent.reply("把 build 目录删了");
  assert.equal(outcome.steps, 2);

  // 轮首两个事件各跑一次
  assert.equal(ran.filter((c) => c === "check-start").length, 1, ran.join("|"));
  assert.equal(ran.filter((c) => c === "check-prompt").length, 1, ran.join("|"));
  // 权限钩子命中 -> 真命令没下发，模型拿到的是拒绝回流
  assert.ok(ran.includes("deny-rm"), ran.join("|"));
  assert.ok(!ran.includes("rm -rf build"), "被拒的命令不该真的执行");
  const toolMsg = agent.serialize().messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content ?? ""), /permission_request 钩子拒绝/);
  assert.match(String(toolMsg?.content ?? ""), /不许递归删/);
  assert.ok(events.some((e) => String(e.content).includes("permission_request 钩子拒绝")));
});

test("真跑：钩子命令失败只提醒不阻断（session_end 失败照样交付），且不误伤未命中的命令", async () => {
  const hooks = `
[[hook]]
when = "session_end"
command = "deny-end"

[[hook]]
when = "permission_request"
match = "git push"
command = "deny-push"
`;
  const { agent, ran, events } = runtimeHarness(hooks, [
    { toolCall: { name: "run_command", arguments: { command: "node scripts/gate.mjs --fast" } } },
    { content: "跑完了。" },
  ]);
  const outcome = await agent.reply("跑一遍门禁");
  assert.equal(outcome.steps, 2);
  // 未命中 permission_request 规则 -> 命令照常执行
  assert.ok(ran.includes("node scripts/gate.mjs --fast"), ran.join("|"));
  // session_end 失败不改变答复
  assert.ok(ran.includes("deny-end"), "轮末事件钩子该跑");
  assert.ok(
    events.some((e) => e.kind === "assistant" && /跑完了/.test(String(e.content))),
    JSON.stringify(events.map((e) => e.kind + ":" + String(e.content).slice(0, 40))),
  );
});

test("第 7 批：model_request 每轮一次、stop 在交付后一次；四个新事件都能被识别", async () => {
  const hooks = `
[[hook]]
when = "model_request"
command = "check-model"

[[hook]]
when = "stop"
command = "check-stop"

[[hook]]
when = "compact"
command = "check-compact"
`;
  const { agent, ran } = runtimeHarness(hooks, [
    { toolCall: { name: "run_command", arguments: { command: "echo hi" } } },
    { content: "好了。" },
  ]);
  await agent.reply("随便跑一下");
  assert.equal(ran.filter((c) => c === "check-model").length, 1, "model_request 一轮只该跑一次：" + ran.join("|"));
  assert.equal(ran.filter((c) => c === "check-stop").length, 1, "stop 交付后该跑一次：" + ran.join("|"));
  assert.ok(!ran.includes("check-compact"), "没触发压缩就不该跑 compact 钩子");

  // 事件名归一覆盖新增四个
  assert.equal(normalizeEvent("ModelRequest"), "model_request");
  assert.equal(normalizeEvent("auto-compact"), "compact");
  assert.equal(normalizeEvent("stop"), "stop");
  assert.equal(normalizeEvent("abort"), "interrupt");

  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  assert.match(chatAgent, /runEventHooks\("model_request"/);
  assert.match(chatAgent, /runEventHooks\("compact"/);
  assert.match(chatAgent, /runEventHooks\("interrupt"/);
  assert.match(chatAgent, /runEventHooks\("stop"/);
});
