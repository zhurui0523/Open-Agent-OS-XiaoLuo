// P1-4 剩余项验收：插件 iframe 故障隔离（看门狗 / 崩溃上报 / 有限自动重启）+ flag 止损开关
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FRAME_LOAD_TIMEOUT_MS,
  MAX_AUTO_RESTARTS,
  describeFrameProblem,
  shouldAutoRestart,
} from "../app/lib/plugin-runtime-guard.ts";
import { DEFAULT_ON_FLAGS, flagEnabled, resolveFlags } from "../shared/agent-config.mjs";

test("看门狗口径：20s 判超时，最多自动重启一次", () => {
  assert.equal(FRAME_LOAD_TIMEOUT_MS, 20_000);
  assert.equal(MAX_AUTO_RESTARTS, 1);
  assert.equal(shouldAutoRestart(0), true, "第一次失败应自动重试");
  assert.equal(shouldAutoRestart(1), false, "重试一次还不行就交回用户，不能无限重启");
});

test("故障文案分清三类：超时 / 崩溃 / 普通加载失败，都带用户能动的下一步", () => {
  assert.match(describeFrameProblem("timeout"), /加载超时/);
  assert.match(describeFrameProblem("crash", "TypeError: x is undefined"), /崩溃或报错（TypeError/);
  assert.match(describeFrameProblem("error"), /加载失败/);
});

test("iframe 接线：onLoad 清看门狗、onError 报错、插件可自报 runtime-error 并重启", () => {
  const frame = readFileSync(new URL("../app/components/plugin-runtime-frame.tsx", import.meta.url), "utf8");
  assert.match(frame, /FRAME_LOAD_TIMEOUT_MS/);
  assert.match(frame, /setFrameLoaded\(true\)/, "onLoad 必须清掉看门狗状态");
  assert.match(frame, /xiaoluo:runtime-error/);
  assert.match(frame, /shouldAutoRestart/);
  assert.match(frame, /describeFrameProblem\("timeout"\)/);
  assert.match(frame, /describeFrameProblem\("error"\)/);
});

test("flag 止损：能力桥默认开，但 env 能立刻关掉；未上线的新功能仍默认关", () => {
  assert.ok(DEFAULT_ON_FLAGS.includes("plugin.capability.bridge"));
  assert.equal(flagEnabled({ flags: {} }, "plugin.capability.bridge", DEFAULT_ON_FLAGS), true, "已上线功能默认开");
  const disabled = resolveFlags({ envRaw: "-plugin.capability.bridge" });
  assert.equal(flagEnabled(disabled, "plugin.capability.bridge", DEFAULT_ON_FLAGS), false, "env 一键关");
  const reEnabled = resolveFlags({ envRaw: "plugin.capability.bridge=true" });
  assert.equal(flagEnabled(reEnabled, "plugin.capability.bridge", DEFAULT_ON_FLAGS), true);
  assert.equal(flagEnabled({ flags: {} }, "tool.search.dynamic", DEFAULT_ON_FLAGS), false, "新功能默认关");
});

test("flag 接线：能力桥 POST 被关时返回 403 并给出怎么开回来", () => {
  const route = readFileSync(new URL("../app/api/v2/plugins/capability/route.ts", import.meta.url), "utf8");
  assert.match(route, /isFeatureOn\("plugin\.capability\.bridge"/);
  assert.match(route, /插件能力桥已被 feature flag 关闭/);
  assert.match(route, /status: 403/);
});
