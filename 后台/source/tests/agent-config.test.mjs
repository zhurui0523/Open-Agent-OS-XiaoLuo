// P2-6 验收：配置 schema / 分层优先级 / 非法值不生效 / feature flag 灰度 / 三端一致
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONFIG_SCHEMA,
  ENV_MAP,
  defaultConfig,
  envLayer,
  parseFlags,
  resolveConfig,
  resolveFlags,
  validateValue,
} from "../shared/agent-config.mjs";

test("schema 覆盖引擎全部预算档位，默认值与引擎实现一致", () => {
  const defaults = defaultConfig();
  assert.equal(defaults["agent.maxStepsPerTurn"], 40);
  assert.equal(defaults["agent.tokenBudgetSoft"], 120000);
  assert.equal(defaults["agent.tokenBudgetHard"], 200000);
  assert.equal(defaults["agent.contextBudget"], 140000);
  assert.equal(defaults["agent.maxCompactsPerTurn"], 3);
  assert.equal(defaults["agent.maxToolResultChars"], 4000);
  assert.equal(defaults["agent.turnWallClockSoftMs"], 600000);
  assert.equal(defaults["agent.turnWallClockHardMs"], 1500000);
  assert.equal(defaults["security.approvalMode"], "on-request");
  assert.equal(defaults["security.networkDefault"], "open");
  assert.equal(defaults["security.winMic"], "auto");
  for (const spec of CONFIG_SCHEMA) assert.ok(spec.describe, spec.key + " 缺说明");
});

test("分层优先级：Project > Workspace > User > Default，且每项能说出自己来自哪层", () => {
  const resolved = resolveConfig({
    user: { "agent.maxStepsPerTurn": 60 },
    workspace: { "agent.maxStepsPerTurn": 80 },
    project: { "agent.maxStepsPerTurn": 100, "security.approvalMode": "never" },
    env: { "agent.maxStepsPerTurn": 120 },
  });
  assert.equal(resolved.values["agent.maxStepsPerTurn"], 120, "env 是运维临时开关，应最高");
  assert.equal(resolved.sources["agent.maxStepsPerTurn"], "env");
  assert.equal(resolved.values["security.approvalMode"], "never", "项目层应覆盖默认层");
  assert.equal(resolved.sources["security.approvalMode"], "project");
  assert.equal(resolved.sources["agent.contextBudget"], "default");

  const noEnv = resolveConfig({
    user: { "agent.maxStepsPerTurn": 60 },
    workspace: { "agent.maxStepsPerTurn": 80 },
  });
  assert.equal(noEnv.values["agent.maxStepsPerTurn"], 80, "没有 project/env 时应落在 workspace");
  assert.equal(noEnv.sources["agent.maxStepsPerTurn"], "workspace");
});

test("非法值不静默改行为：退回上一层有效值并留告警", () => {
  const resolved = resolveConfig({
    workspace: { "agent.maxStepsPerTurn": 80 },
    project: { "agent.maxStepsPerTurn": 9999, "security.approvalMode": "sometimes" },
  });
  assert.equal(resolved.values["agent.maxStepsPerTurn"], 80, "越界值不该把生效值改坏");
  assert.equal(resolved.values["security.approvalMode"], "on-request");
  assert.ok(resolved.warnings.length >= 2, "每个非法值都要有一条告警");
  assert.match(resolved.warnings.join("|"), /超出范围/);
  assert.match(resolved.warnings.join("|"), /只接受/);
});

test("未知配置项被丢弃并告警，不会悄悄塞进引擎", () => {
  const resolved = resolveConfig({ user: { "agent.magicSwitch": true } });
  assert.ok(!("agent.magicSwitch" in resolved.values));
  assert.match(resolved.warnings.join("|"), /未知配置项 agent.magicSwitch/);
});

test("env 映射只认显式表，不靠猜变量名", () => {
  const layer = envLayer({ XIAOLUO_MAX_STEPS_PER_TURN: "77", XIAOLUO_SOMETHING_ELSE: "x" });
  assert.equal(layer["agent.maxStepsPerTurn"], "77");
  assert.equal(Object.keys(layer).length, 1);
  assert.equal(ENV_MAP.XIAOLUO_SANDBOX_WIN_MIC, "security.winMic");
});

test("同一份输入在三端解析结果一致（配置治理的核心承诺）", () => {
  const layers = {
    user: { "agent.maxStepsPerTurn": 50 },
    workspace: { "security.networkDefault": "loopback" },
    project: { "agent.maxToolResultChars": 6000 },
    env: { "agent.contextBudget": "150000" },
  };
  const serverView = resolveConfig(layers);
  const desktopView = resolveConfig(layers);
  const cliView = resolveConfig(layers);
  assert.deepEqual(serverView.values, desktopView.values);
  assert.deepEqual(desktopView.values, cliView.values);
  assert.deepEqual(serverView.sources, cliView.sources);
  assert.equal(serverView.values["agent.maxStepsPerTurn"], 50);
  assert.equal(serverView.values["security.networkDefault"], "loopback");
  assert.equal(serverView.values["agent.contextBudget"], 150000, "env 数字字符串要转成数字");
});

test("feature flag：默认关，显式开才算开，env 可即时开/关", () => {
  const off = resolveFlags({});
  assert.deepEqual(off.flags, {}, "默认一个都不开");

  const fileOn = resolveFlags({ workspace: { features: { "plugin.capability.bridge": true } } });
  assert.equal(fileOn.flags["plugin.capability.bridge"], true);
  assert.equal(fileOn.sources["plugin.capability.bridge"], "workspace");

  const envOverrides = resolveFlags({
    workspace: { features: { "plugin.capability.bridge": true } },
    envRaw: "plugin.capability.bridge=false,new.flag",
  });
  assert.equal(envOverrides.flags["plugin.capability.bridge"], false, "env 可即时回滚");
  assert.equal(envOverrides.flags["new.flag"], true);
  assert.equal(envOverrides.sources["plugin.capability.bridge"], "env");

  assert.deepEqual(parseFlags("a,b -c"), { a: true, b: true, c: false });
});

test("接线：宿主工厂用配置层覆盖默认档位；配置接口给出 values+sources", () => {
  const host = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/agent-host.ts", import.meta.url), "utf8");
  assert.match(host, /configFromConfigLayer/);
  assert.match(host, /\.\.\.DEFAULT_CHAT_AGENT_CONFIG, \.\.\.configFromConfigLayer\(\)/);
  assert.match(host, /resolveConfig\(\{ env: envLayer/);

  const route = readFileSync(new URL("../app/api/v2/config/route.ts", import.meta.url), "utf8");
  assert.match(route, /resolveRuntimeConfig/);
  assert.match(route, /sources: view\.sources/);
  assert.match(route, /saveWorkspaceConfig/, "PUT 只应写 workspace 层");

  const loader = readFileSync(new URL("../app/lib/agent-config.ts", import.meta.url), "utf8");
  assert.match(loader, /\.xiaoluo", "config\.json"/, "用户层路径要显式");
  assert.match(loader, /agent-config\.json/);
  assert.match(loader, /agent\.config\.json/);
});

test("配置面板已接到设置页：读 GET / 存 PUT，环境变量覆盖的项不可改", () => {
  const panel = readFileSync(new URL("../app/components/agent-config-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /fetch\("\/api\/v2\/config"\)/);
  assert.match(panel, /method: "PUT"/);
  assert.match(panel, /JSON\.stringify\(\{ values \}\)/, "只提交改动过的 values");
  assert.match(panel, /sources\[row\.key\]/, "每项必须显示来源层");
  assert.match(panel, /fromEnv/, "env 覆盖的项要禁用输入");
  assert.match(panel, /flagSources/, "开关也要标来源");

  const center = readFileSync(new URL("../app/components/settings-center.tsx", import.meta.url), "utf8");
  assert.match(center, /import \{ AgentConfigPanel/);
  assert.match(center, /\{tab === "agent" && <AgentConfigPanel \/>\}/);
  assert.match(center, /selectTab\("agent"\)/);
});

test("validateValue 单值口径：数字/枚举/超长字符串", () => {
  assert.deepEqual(validateValue("agent.maxStepsPerTurn", "12").ok, true);
  assert.equal(validateValue("agent.maxStepsPerTurn", "abc").value, 40);
  assert.equal(validateValue("security.approvalMode", "granular").value, "granular");
  assert.equal(validateValue("security.winMic", "auto").value, "auto");
  assert.equal(validateValue("workspace.root", "x".repeat(600)).ok, false);
});
