// P1-4 验收：能力授权矩阵 + 执行桥围栏 + iframe 回执接线
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPABILITIES,
  CAPABILITY_SCOPE,
  SERVER_EXECUTABLE,
  authorizeCapability,
  normalizeGrants,
} from "../shared/plugin-capabilities.mjs";

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-plugin-"));
process.env.XIAOLUO_WORKSPACE_ROOT = TMP;

test.afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test("能力目录：五类对外能力 + 服务端只执行其中三类", () => {
  assert.deepEqual(CAPABILITIES, [
    "fs.read",
    "fs.write",
    "net.fetch",
    "clipboard.read",
    "ui.notify",
    "shell.exec",
  ]);
  assert.deepEqual(SERVER_EXECUTABLE, ["fs.read", "fs.write", "net.fetch"]);
  for (const id of CAPABILITIES) assert.ok(CAPABILITY_SCOPE[id], id + " 缺 scope 说明");
});

test("默认全关：未授权一律拒绝，并给出「去哪开」的指引", () => {
  for (const id of CAPABILITIES) {
    const verdict = authorizeCapability([], id);
    assert.equal(verdict.allowed, false, id + " 未授权却放行了");
    assert.match(verdict.hint, /勾选|宿主|不开放/, id + " 拒绝时没给指引");
  }
});

test("授权后：三类服务端能力放行，客户端能力仍拒并说明由谁做", () => {
  const grants = ["fs.read", "fs.write", "net.fetch", "clipboard.read", "ui.notify", "shell.exec"];
  for (const id of SERVER_EXECUTABLE) {
    const verdict = authorizeCapability(grants, id);
    assert.equal(verdict.allowed, true, id + " 已授权却仍被拒");
    assert.ok(verdict.hint.length > 0, id + " 放行时也要说清边界");
  }
  for (const id of ["clipboard.read", "ui.notify", "shell.exec"]) {
    const verdict = authorizeCapability(grants, id);
    assert.equal(verdict.allowed, false, id + " 服务端不该代做");
    assert.match(verdict.reason, /宿主|不开放/);
  }
});

test("未知能力/脏授权：不因拼写错误放行", () => {
  assert.equal(authorizeCapability(["fs.*"], "fs.read").allowed, false, "通配符不能当授权");
  assert.equal(authorizeCapability(["fs.read"], "fs.readAll").allowed, false);
  assert.deepEqual(normalizeGrants(["fs.read", "fs.read", "乱写", 42, null]), ["fs.read"]);
});

test("执行桥：fs 越界被拒（工作区围栏），不是「文件不存在」", async () => {
  const sandbox = await import("../app/lib/brain-sandbox.ts");
  await assert.rejects(
    sandbox.readSandboxFile("plugin-user", "../../../../etc/passwd", undefined, "default"),
    /围栏|越界|工作区|路径/,
  );
});

test("接线事实：iframe 真调能力桥、插件台能开关授权、拒绝时带 hint", async () => {
  const frame = readFileSync(new URL("../app/components/plugin-runtime-frame.tsx", import.meta.url), "utf8");
  assert.match(frame, /fetch\("\/api\/v2\/plugins\/capability"/);
  assert.doesNotMatch(frame, /ok: false,\s*error: "该插件能力尚未获得宿主授权。"/, "还在写死拒绝");
  assert.match(frame, /capability-response/);
  assert.match(frame, /hint: payload\.hint/);

  const hub = readFileSync(new URL("../app/components/plugins-hub-panel.tsx", import.meta.url), "utf8");
  assert.match(hub, /PluginCapabilitiesPanel/);

  const route = readFileSync(
    new URL("../app/api/v2/plugins/capability/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /authorizeCapability/);
  assert.match(route, /isAllowlistedHost/);
  assert.match(route, /readSandboxNetworkConfig/);
  assert.match(route, /readSandboxFile/);
  assert.match(route, /writeSandboxFile/);
  // 未授权必须 403，不能 200 里塞 ok:false 让插件误判
  assert.match(route, /status: 403/);
});
