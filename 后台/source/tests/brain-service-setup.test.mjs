/**
 * setup_service（static）端到端：老板要的是"写完文件起个本地服务，浏览器页签里预览"。
 *
 * 这一条从前是断的：服务端搭静态服务时把 payload.path 丢掉了，永远挂工作区根，
 * 于是 write_file 写进 uploads/ 的文件在预览地址上是 404；更糟的是探活把 404 也算健康，
 * 卡片写着 health=ok，小逻就抱着一个挂错目录的服务反复重试，一整轮预算烧在这上面。
 * 桌面宿主一直交的是带围栏的 resolveSubDir，所以只有服务端这一侧漏 —— 换个宿主就该换个门深吗？不该。
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  brainWorkspaceRoot,
  listBrainServiceSetups,
  setupBrainService,
  stopBrainService,
  writeSandboxFile,
} from "../app/lib/brain-sandbox.ts";
import { httpProbe } from "../shared/service-provision.mjs";

const USER = "test-static-preview";
const TODO_HTML = "<!doctype html><title>todo</title><h1>待办清单</h1>";

/**
 * Windows 上子进程退出与会话解锁是异步的：stopBrainService 返回后目录句柄可能还没释放，
 * 立刻 rmdir 会 EBUSY（以前偶发把整条用例带红）。清理必须带退避重试，且最后一个错误要抛出，
 * 不能把真实失败吞掉。
 */
async function rmWithRetry(target, attempts = 12, delayMs = 150) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

test.afterEach(async () => {
  await rmWithRetry(brainWorkspaceRoot(USER));
});

/** 真起一个静态服务跑完一段：拿到 URL 后必停，否则端口攥到 TTL 结束 */
async function withStaticPreview(payload, run) {
  await writeSandboxFile(USER, "uploads/todo.html", TODO_HTML, undefined, "default");
  const setup = await setupBrainService(USER, payload);
  assert.ok(!setup.error, "静态服务搭建失败：" + String(setup.error));
  try {
    return await run(setup);
  } finally {
    if (setup.serviceId) await stopBrainService(USER, setup.serviceId).catch(() => undefined);
  }
}

test("写完 uploads/todo.html 再起静态服务：预览地址打开就是那个文件", async () => {
  await withStaticPreview({ kind: "static", name: "todo-preview", path: "uploads" }, async (setup) => {
    assert.equal(
      setup.root,
      path.join(brainWorkspaceRoot(USER), "uploads"),
      "挂载根必须是 write_file 落盘的那个目录，不是工作区根",
    );
    assert.equal(setup.health, "ok", "静态服务没在 6 秒内答出 2xx/3xx");

    const file = await fetch(setup.url + "todo.html");
    assert.equal(file.status, 200, "预览 /todo.html 拿到 " + file.status);
    assert.match(await file.text(), /待办清单/);

    // 目录里没有 index.html 时给清单，而不是裸 404：老板打开根就能看到有哪些文件可点
    const root = await fetch(setup.url);
    assert.equal(root.status, 200, "打开挂载根拿到 " + root.status);
    assert.match(await root.text(), /todo\.html/, "挂载根清单里没有那个文件");
  });
});

test("health 只能说真话：404 不算就绪", async () => {
  await withStaticPreview({ kind: "static", name: "honest-preview", path: "uploads" }, async (setup) => {
    assert.equal(await httpProbe(setup.url + "todo.html"), true);
    assert.equal(
      await httpProbe(setup.url + "does-not-exist.html"),
      false,
      "404 被当成健康，卡片就会写 health=ok 骗着小逻",
    );
  });
});

test("搭建记录落在 .services 下：service_status 的 setups 面读得到", async () => {
  await withStaticPreview({ kind: "static", name: "listed-preview", path: "uploads" }, async (setup) => {
    const setups = await listBrainServiceSetups(USER);
    const hit = setups.find((s) => s.name === "listed-preview");
    assert.ok(hit, "搭建记录没落在 readServiceInfos 扫的那个目录里：" + JSON.stringify(setups.map((s) => s.name)));
    assert.equal(hit.root, setup.root);
    assert.equal(hit.serviceId, setup.serviceId);
  });
});

test("path 越出工作区：搭建通道当场拒，不退回挂工作区根", async () => {
  const escaped = await setupBrainService(USER, { kind: "static", name: "escape", path: "../outside" });
  assert.ok(escaped.error, "越界的挂载目录被放过了：" + JSON.stringify(escaped));
  assert.match(String(escaped.error), /路径越界/);
});
