// P2-7 验收：原子写盘 / 只读 carve-out / 一条调用完成 move 与 delete / 主循环软收尾
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-edit-"));
process.env.XIAOLUO_WORKSPACE_ROOT = TMP;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function sandbox() {
  return await import("../app/lib/brain-sandbox.ts");
}

test("写盘是原子的：成功后不留 .tmp 残片，内容完整", async () => {
  const box = await sandbox();
  const user = "atomic-user";
  await box.writeSandboxFile(user, "a.txt", "第一版内容", undefined, "default");
  const root = box.brainWorkspaceRoot(user);
  const leftovers = readdirSync(root).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "工作区里不该留临时文件");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "第一版内容");

  await box.writeSandboxFile(user, "a.txt", "第二版内容", undefined, "default");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "第二版内容");
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  // 子目录写盘同样不该留残片
  await box.writeSandboxFile(user, "sub/b.txt", "嵌套", undefined, "default");
  assert.deepEqual(readdirSync(join(root, "sub")).filter((name) => name.endsWith(".tmp")), []);
});

test("只读 carve-out：.git 目录不能被写、删、移动，但能读", async () => {
  const box = await sandbox();
  const user = "carve-user";
  const root = box.brainWorkspaceRoot(user);
  await box.writeSandboxFile(user, ".git/config", "should not happen", undefined, "default").then(
    () => assert.fail("写 .git 应该被拒"),
    (error) => assert.match(error.message, /只读目录/),
  );

  // 手工造一个 .git 里的文件（模拟既有仓库），再验证删除/移动被拒
  mkdirSync(join(box.brainWorkspaceRoot(user), ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await assert.rejects(box.deleteSandboxPath(user, ".git"), /只读目录/);
  writeFileSync(join(root, "normal.txt"), "x");
  await assert.rejects(box.moveSandboxPath(user, "normal.txt", ".git/normal.txt", "default"), /只读目录/);
  // 读不受影响
  const read = await box.readSandboxFile(user, ".git/HEAD", undefined, "default");
  assert.match(read.content, /refs\/heads/);
});

test("move 一条调用完成移动，内容跟着走，源路径消失", async () => {
  const box = await sandbox();
  const user = "move-user";
  await box.writeSandboxFile(user, "old/name.txt", "payload", undefined, "default");
  await box.moveSandboxPath(user, "old/name.txt", "new/name.txt", "default");
  const root = box.brainWorkspaceRoot(user);
  assert.equal(readFileSync(join(root, "new", "name.txt"), "utf8"), "payload");
  assert.deepEqual(readdirSync(join(root, "old")), [], "源目录应已空");
  await assert.rejects(box.readSandboxFile(user, "old/name.txt", undefined, "default"));
});

test("delete 递归删除，且拒绝删工作区根与越界路径", async () => {
  const box = await sandbox();
  const user = "del-user";
  await box.writeSandboxFile(user, "tmpdir/a.txt", "a", undefined, "default");
  await box.writeSandboxFile(user, "tmpdir/nested/b.txt", "b", undefined, "default");
  await box.deleteSandboxPath(user, "tmpdir");
  await assert.rejects(box.readSandboxFile(user, "tmpdir/a.txt", undefined, "default"));
  await assert.rejects(box.deleteSandboxPath(user, ""), /非法/);
  await assert.rejects(box.deleteSandboxPath(user, "../outside"), /非法/);
});

test("接线：move_file / delete_file 注册受宿主能力管，删除有双重锁", async () => {
  const tools = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-tools.ts", import.meta.url), "utf8");
  assert.match(tools, /name: "move_file"/);
  assert.match(tools, /name: "delete_file"/);
  assert.match(tools, /caps\.fsOpsEnabled/);

  const ports = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/agent-ports.ts", import.meta.url), "utf8");
  assert.match(ports, /fsOpsEnabled: Boolean\(ports\.fs\?\.movePath && ports\.fs\?\.deletePath\)/);

  const server = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8");
  assert.match(server, /movePath\(from, to\)/);
  assert.match(server, /deletePath\(path\)/);

  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /case "move_file":/);
  assert.match(agent, /case "delete_file":/);
  assert.match(agent, /confirm/, "删除必须有 confirm 参数");
  assert.match(agent, /this\.readPaths\.has\(target\)/, "删除前必须看过");
});

test("主循环软收尾：最后一步有提醒，步数到顶补一次只写总结的回合", async () => {
  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /lastStepNoticeSent/, "缺最后一步提醒标记");
  assert.match(agent, /这是本轮最后一步/);
  assert.match(agent, /private async softClose/);
  assert.match(agent, /closedBy: closing \? "soft" : undefined/);
  assert.match(agent, /turnTokens >= config\.tokenBudgetHard/, "软收尾也要受硬顶约束");

  const ports = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/agent-ports.ts", import.meta.url), "utf8");
  assert.match(ports, /closedBy\?: "soft"/);
});
