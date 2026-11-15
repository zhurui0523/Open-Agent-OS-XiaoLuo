/**
 * 宿主代跑桥测试（P7-3：浏览器面板也改成协议宿主）
 *
 * 反向工具通道两头各有一份表：服务端 server-ports 决定「向宿主报哪个口、调哪个方法、带哪几个位置参数」，
 * 宿主 host-bridge 决定「收到 (port, call, args) 之后调本机哪个方法」。
 * 两份表隔着进程边界，谁都可能改完忘了另一头 —— 拼错一个方法名，线上表现是小逻干等 60 秒然后一句「跑不了」。
 *
 * 所以这里不写死调用名：直接拿服务端那份真端口面（createServerPorts），把 requestHostTool 接到宿主桥的
 * runHostTool 上，逐个方法打一遍。服务端多出一个宿主不认的 call，桥就会抛；参数位次错一位，回流的值就对不上。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createServerPorts } from "../app/xiaoluo-brain/lib/brain/server-ports.ts";
import { declaredHostTools, hostDecl, probeHostGate, runHostTool } from "../app/xiaoluo-brain/lib/brain/host-bridge.ts";
import { HOST_TOOL_PORTS } from "../app/xiaoluo-brain/lib/brain/agent-wire.ts";

const USER = "test-host-bridge";

/** 服务端端口面上的宿主代跑字段 → 线上报的口名（deployProgram 字段对应 deploy 口，其余同名） */
const HOST_FIELDS = {
  generateMedia: "generateMedia",
  vision: "vision",
  desktop: "desktop",
  webdriver: "webdriver",
  uia: "uia",
  ssh: "ssh",
  deployProgram: "deploy",
  mcp: "mcp",
};

/**
 * 宿主侧的假本机：按服务端端口面上真实存在的方法逐一镜像一份，每次调用记下 (方法, 实参) 并回一个可辨认的值。
 * 表是从服务端那侧「读」出来的，不是这里抄的——所以它验的是两端是否说同一种话。
 */
function mirrorHost(serverPorts, log) {
  const host = {};
  const spy = (label) => (...args) => {
    log.push({ label, args });
    return Promise.resolve("宿主回执：" + label);
  };
  for (const field of Object.keys(HOST_FIELDS)) {
    const source = serverPorts[field];
    if (typeof source === "function") {
      host[field] = spy(field);
      continue;
    }
    const methods = {};
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "function") methods[name] = spy(field + "." + name);
    }
    if (field === "vision") methods.modelVision = true;
    assert.ok(Object.keys(methods).length > 0, field + " 口上一个方法都没有，这份镜像测不到东西");
    host[field] = methods;
  }
  return host;
}

function bridgePorts(host, wire) {
  return createServerPorts({
    userId: USER,
    conversationId: "brain-bridge",
    canvasId: "c-bridge",
    modelId: "m1",
    hostTools: [...HOST_TOOL_PORTS],
    mcpTools: [{ name: "mcp__demo__echo", description: "回声" }],
    emitUi: () => {},
    requestApproval: async () => false,
    getHostModelVision: () => true,
    getTaskTitle: () => "接线",
    auditApproval: () => {},
    async requestHostTool(port, call, args) {
      wire.push({ port, call, args });
      return await runHostTool(host, { port, call, args });
    },
  });
}

test("反向通道全表打通：八个口逐个调，宿主回执原样回到内核手里", async () => {
  const log = [];
  const wire = [];
  // 第一遍只为拿到服务端端口面的方法清单（requestHostTool 直接抛，不参与断言）
  const probe = createServerPorts({
    userId: USER,
    conversationId: "brain-bridge-probe",
    canvasId: "c-probe",
    modelId: "m1",
    hostTools: [...HOST_TOOL_PORTS],
    mcpTools: [{ name: "mcp__demo__echo", description: "回声" }],
    emitUi: () => {},
    requestApproval: async () => false,
    getHostModelVision: () => true,
    getTaskTitle: () => "",
    auditApproval: () => {},
    requestHostTool: async () => "probe",
  });
  const host = mirrorHost(probe, log);
  const ports = bridgePorts(host, wire);

  const A = { 参数: "第一参" };
  const B = "第二参";
  let calls = 0;
  for (const field of Object.keys(HOST_FIELDS)) {
    const source = ports[field];
    const names = typeof source === "function" ? [null] : Object.keys(host[field]).filter((name) => typeof host[field][name] === "function");
    for (const name of names) {
      const fn = name ? source[name] : source;
      const result = await fn(A, B);
      calls += 1;
      const label = name ? field + "." + name : field;
      assert.equal(result, "宿主回执：" + label, label + " 的宿主回执没原样回到内核手里");
    }
  }

  const expected = log.map((entry) => entry.label);
  assert.equal(log.length, calls, "有方法的这一跳没落到宿主手里");
  assert.ok(calls >= 15, "宿主代跑面不该只有这几跳：" + expected.join(","));

  // 线上报的口名必须是协议认可的那几个（宿主声明与内核注册共用这份名单）
  for (const event of wire) {
    assert.ok(HOST_TOOL_PORTS.includes(event.port), "内核向宿主报了个协议外的口：" + event.port);
  }
  const portsAsked = new Set(wire.map((event) => event.port));
  assert.deepEqual(
    [...portsAsked].sort(),
    Object.values(HOST_FIELDS).sort(),
    "有八个口声明了却没一跳搬到线上：能力面谈判与分发对不上",
  );

  // 参数位次：宿主桥按位置展开，错位的表现是模型看到一串对不上的东西
  const dom = wire.find((event) => event.port === "webdriver" && event.call === "dom");
  assert.deepEqual(dom.args, [A, B], "webdriver.dom(mode, max) 的两个参数要按位次搬过去");
  const evalCall = wire.find((event) => event.port === "webdriver" && event.call === "eval");
  assert.deepEqual(evalCall.args, [A, B], "webdriver.eval(js, awaitPromise) 同上");
  const shot = wire.find((event) => event.port === "desktop" && event.call === "capture");
  assert.deepEqual(shot.args, [], "desktop.capture 是无参的，别把探针参数塞过去");
  const deploy = wire.find((event) => event.port === "deploy");
  assert.deepEqual(deploy.args, [A, B], "deploy 把产物与名字分两参交下去");
});

test("宿主答不了的要当场抛出去：没接的口不猜、不兜圈", async () => {
  const bare = { capabilityCatalog: "", model: "m1", canvasId: "c1", callLLM: async () => "" };
  assert.deepEqual(declaredHostTools(bare), [], "纯浏览器标签页一个代跑口也不该声明");

  await assert.rejects(
    () => runHostTool(bare, { port: "ssh", call: "exec", args: [{ host: "h", command: "ls" }] }),
    /本宿主跑不了 ssh\.exec/,
    "跑不了要给模型一个能看懂的理由，而不是干等",
  );
  // 口在、方法名对不上（服务端改了名，宿主没跟上）也要当场拒
  await assert.rejects(
    () => runHostTool({ vision: { capture: async () => ({}) } }, { port: "vision", call: "screenshot", args: [] }),
    /本宿主跑不了 vision\.screenshot/,
  );
});

test("能力声明只看本机有没有那个口：MCP 空清单换不来一个 mcp 口", async () => {
  const desktop = {
    vision: { modelVision: true, capture: async () => ({}), operate: async () => "", dom: async () => "", navigate: async () => "" },
    mcp: { tools: [], callTool: async () => "" },
  };
  assert.deepEqual(declaredHostTools(desktop), ["vision"], "MCP 一个工具都没报上来，就别让内核注册一个空口");
  assert.deepEqual(hostDecl(desktop), { hostTools: ["vision"], hostModelVision: true, mcpTools: [] });

  const withTools = { ...desktop, mcp: { tools: [{ name: "mcp__demo__echo", description: "回声" }], callTool: async () => "" } };
  assert.deepEqual(declaredHostTools(withTools), ["vision", "mcp"]);

  // 视觉开关只认宿主自己报的那一份：模型不支持视觉时不能让 inspect_screen 走图像路径
  const noVisionModel = { ...desktop, vision: { ...desktop.vision, modelVision: false } };
  assert.equal(hostDecl(noVisionModel).hostModelVision, false);
  assert.equal(hostDecl({}).hostModelVision, false, "连视觉口都没有，modelVision 只能是 false");
});

/**
 * 老板那个「允许小逻控制本机」开关关着时，主进程对整桌截屏、外部浏览器、SSH 一律回绝。
 * 还把它们报上去，小逻就只能撞一次闸，再回头让老板满设置里找开关 —— 而他真正问的那句
 * 「桌面上开着什么窗口」，用 desktop_inspect 的只读枚举本来就不用开关也答得出。
 */
test("闸门关着就不报那三口：只读的控件枚举照报，问不到读数不收能力", async () => {
  const desktopish = {
    vision: { modelVision: true, capture: async () => ({}), operate: async () => "", dom: async () => "", navigate: async () => "" },
    desktop: { capture: async () => ({}), operate: async () => "" },
    webdriver: { navigate: async () => "", dom: async () => "", capture: async () => ({}), operate: async () => "", eval: async () => "" },
    uia: { inspect: async () => "" },
    ssh: { exec: async () => "" },
  };
  assert.deepEqual(declaredHostTools(desktopish), ["vision", "desktop", "webdriver", "uia", "ssh"]);
  assert.deepEqual(
    declaredHostTools(desktopish, false),
    ["vision", "uia"],
    "开关关着还报 desktop/webdriver/ssh，就是承诺一个宿主必定回绝的能力",
  );

  // 读数只认明确的 false：宿主没实现这一问、或答不上来，一律按开着处理
  assert.equal(await probeHostGate(desktopish), true, "没有 hostGate 的宿主不能白丢三口");
  assert.equal(await probeHostGate({ ...desktopish, hostGate: async () => false }), false);
  assert.equal(await probeHostGate({ ...desktopish, hostGate: async () => true }), true);
  assert.equal(await probeHostGate({ ...desktopish, hostGate: async () => null }), true, "主进程答不上这一问（老宿主）时按开着处理");
  assert.equal(
    await probeHostGate({ ...desktopish, hostGate: async () => { throw new Error("ipc 断了"); } }),
    true,
    "探测本身失败也不能顺手把能力收掉",
  );
});

test("接线事实：审批记忆与风险摘要只有一份，面板和宿主桥共用", async () => {
  const [panelSource, hookSource, grantsSource] = await Promise.all([
    readFile(new URL("../app/components/xiaoluo-brain-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/hooks/use-chat-agent.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/approval-grants.ts", import.meta.url), "utf8"),
  ]);
  // 抄第二份批准账 = 同类操作问两遍，或者更糟：某一侧的批准把另一侧的门也放开了
  for (const [where, source] of [["面板", panelSource], ["宿主桥", hookSource]]) {
    assert.doesNotMatch(source, /const approvalGrants|function wasApproved|function markApproved/, where + "自带了一份批准账");
    assert.match(source, /from "[^"]*lib\/brain\/approval-grants"/, where + "没接上共用那份批准账");
  }
  assert.match(grantsSource, /export function confirmApproval/);
  assert.match(grantsSource, /export function wasApproved/);
  // 宿主桥不在 React 里：面板之外的宿主也能用同一份分发
  assert.doesNotMatch(
    await readFile(new URL("../app/xiaoluo-brain/lib/brain/host-bridge.ts", import.meta.url), "utf8"),
    /from "react"/,
  );
});

/**
 * 控制台那个权限钮是老板唯一改文件档位的地方。P7-3 之前它只跟着面板自己的 /api/v2/brain/fs
 * 请求走；内核进服务进程后，读文件的是服务端的口，档位必须一路交到 thread/*，
 * 否则他切到「全部访问」也只是把界面改了个颜色。
 */
test("接线事实：面板的权限档位一路交到内核的 thread 参数里", async () => {
  const [panelSource, hookSource] = await Promise.all([
    readFile(new URL("../app/components/xiaoluo-brain-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/hooks/use-chat-agent.ts", import.meta.url), "utf8"),
  ]);
  assert.match(panelSource, /permissionMode,\n\s*model: effectiveModel/, "面板没把档位交给 adapters");
  assert.match(hookSource, /permissionMode: a\.permissionMode \?\? "default"/, "thread/start|resume 没带上档位");
  assert.match(hookSource, /threadFork\(\{[\s\S]{0,240}permissionMode/, "分叉出去的分支丢了档位");
  // 面孔变了要重谈、只换模型走轻路径：两条都在，缺一条就是要么不生效要么白重建
  assert.match(hookSource, /function hostFace/);
  assert.match(hookSource, /threadModelUpdate/);
});

/** 闸门读数也是面孔的一笔：面板问主进程 → hook 起线程前现问 → 声明里那三口跟着读数收放 */
test("接线事实：闸门读数一路走到 thread 声明里，能力面才敢说真话", async () => {
  const [panelSource, hookSource] = await Promise.all([
    readFile(new URL("../app/components/xiaoluo-brain-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/hooks/use-chat-agent.ts", import.meta.url), "utf8"),
  ]);
  assert.match(panelSource, /hostGate: desktop\?\.desktopAction/, "面板没把闸门读数接进 adapters");
  assert.match(hookSource, /const gate = await probeHostGate\(a\);/, "起线程前没现问一次闸门");
  assert.match(hookSource, /hostFace\(a, gate\)/, "面孔没把闸门读数算进去：老板开了开关，三口回不来");
  assert.match(hookSource, /threadFork\(\{[\s\S]{0,360}hostDecl\(a, await probeHostGate\(a\)\)/, "分叉出去的分支按旧读数声明");
});
