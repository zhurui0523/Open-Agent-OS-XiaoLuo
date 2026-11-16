/**
 * 第 3 项：真 PTY（Codex 的 utils/pty 那一层）
 *
 * 小逻原来只有管道会话（isatty=false），REPL / ssh / npm 这类看 isatty 的程序行为不对。
 * 这里加了 `pty-adapter`：惰性加载 node-pty，装了就用 ConPTY/openpty，没装就如实降级
 * 并把原因回流，绝不假装有终端。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { probePty, openPty, resetPtyCacheForTests } from "../app/lib/pty-adapter.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("探测：没装 node-pty 时如实报不可用（不假装有终端）", async () => {
  resetPtyCacheForTests();
  const probe = await probePty();
  // CI 与开发机都没装 node-pty（原生模块不进依赖），这里必须走降级分支
  assert.equal(probe.available, false);
  assert.equal(probe.backend, "none");
  assert.match(String(probe.reason), /node-pty/);
  assert.match(String(probe.reason), /isatty/);
});

test("openPty：模块缺失返回 null，调用方按降级处理", async () => {
  const handle = await openPty("/bin/sh", ["-c", "echo hi"], { cwd: "/tmp", env: {} }, async () => null);
  assert.equal(handle, null);
});

test("openPty：真模块在时把 spawn 参数与读写/退出/关闭全部接对", async () => {
  const calls = { spawn: [], writes: [], kills: 0, exitHandlers: [], dataHandlers: [] };
  const fakeModule = {
    spawn: (file, args, opts) => {
      calls.spawn.push({ file, args, opts });
      return {
        pid: 4242,
        write: (data) => calls.writes.push(data),
        onData: (cb) => calls.dataHandlers.push(cb),
        onExit: (cb) => calls.exitHandlers.push(cb),
        kill: () => { calls.kills += 1; },
      };
    },
  };
  const handle = await openPty(
    "/bin/sh",
    ["-c", "node"],
    { cwd: "/tmp/work", env: { PATH: "/usr/bin" }, cols: 100, rows: 24 },
    async () => fakeModule,
  );
  assert.ok(handle);
  assert.equal(handle.pid, 4242);
  const sp = calls.spawn[0];
  assert.equal(sp.file, "/bin/sh");
  assert.deepEqual(sp.args, ["-c", "node"]);
  assert.equal(sp.opts.cwd, "/tmp/work");
  assert.equal(sp.opts.cols, 100);
  assert.equal(sp.opts.rows, 24);
  assert.equal(sp.opts.name, "xterm-256color");

  handle.write("ls\n");
  assert.deepEqual(calls.writes, ["ls\n"]);
  // 收尾发 EOF 字节，再 kill
  handle.end();
  assert.equal(calls.writes.at(-1), "\u0004");
  handle.kill();
  assert.equal(calls.kills, 1);

  // 回调是真的接到模块上：模块吐数据/退出，外面能收到
  let seen = "";
  handle.onData((chunk) => { seen += chunk; });
  calls.dataHandlers[0]("hello");
  assert.equal(seen, "hello");
  let exited = null;
  handle.onExit((code) => { exited = code; });
  calls.exitHandlers[0]({ exitCode: 0 });
  assert.equal(exited, 0);
});

test("接线：run_command(interactive=true, pty=true) 一路传到宿主，降级原因回到模型", async () => {
  const types = await source("app/xiaoluo-brain/lib/brain/types.ts");
  assert.match(types, /startSession\?\(command: string, opts\?: \{ cwd\?: string; ttlMs\?: number; pty\?: boolean \}\)/);
  assert.match(types, /pty\?: boolean;[\s\S]{0,120}ptyNotice\?: string/);

  const tools = await source("app/xiaoluo-brain/lib/brain/chat-tools.ts");
  assert.match(tools, /pty\?: boolean;/);
  assert.match(tools, /pty: \{ type: "boolean", description: "真终端/);

  const agent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  assert.match(agent, /startSession\(args\.command, \{ cwd: args\.cwd, pty: args\.pty \}\)/);
  assert.match(agent, /【真终端不可用，已降级】/);

  const sandbox = await source("app/lib/brain-sandbox.ts");
  assert.match(sandbox, /if \(opts\?\.pty\)[\s\S]{0,400}openPty\(/);
  assert.match(sandbox, /ptyNotice = \(await probePty\(\)\)\.reason/);
  assert.match(sandbox, /ptyMode: true/);

  const gate = await source("app/lib/brain-command-gate.ts");
  assert.match(gate, /pty\?: boolean/);
  assert.match(gate, /pty: req\.pty/);
});
