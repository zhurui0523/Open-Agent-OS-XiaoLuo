/**
 * 第 7.7 项：文件索引 / 变更监听（对齐 Codex fuzzy_file_search + file-watcher）
 * 覆盖：打分分档、遍历跳过规则、索引缓存与刷新、watch 标脏、双端算法一致、工具注册与接线。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const appPath = (p) => fileURLToPath(new URL("app/" + p, ROOT));
const app = (p) => pathToFileURL(appPath(p)).href;
const read = (p) => readFile(appPath(p), "utf8");
const { scoreFilePath, walkWorkspace, createWorkspaceFileIndex, searchSnapshot } = await import(
  app("lib/file-index.ts")
);
const { buildChatToolSchemas } = await import(app("xiaoluo-brain/lib/brain/chat-tools.ts"));
const CLIENT = await import("../../../客户端/source/desktop/local-runtime.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "xiaoluo-fi-"));

async function write(rel, content = "x") {
  const full = join(tmpRoot, rel);
  await fs.mkdir(join(full, ".."), { recursive: true }).catch(() => {});
  await fs.mkdir(join(tmpRoot, rel, ".."), { recursive: true }).catch(() => {});
  await fs.writeFile(full, content, "utf8");
}

async function seedWorkspace() {
  await fs.mkdir(join(tmpRoot, "src"), { recursive: true });
  await fs.mkdir(join(tmpRoot, "docs"), { recursive: true });
  await fs.mkdir(join(tmpRoot, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(join(tmpRoot, ".git"), { recursive: true });
  await fs.writeFile(join(tmpRoot, "src", "app.ts"), "export const a = 1;\n");
  await fs.writeFile(join(tmpRoot, "docs", "app-guide.md"), "# guide\n");
  await fs.writeFile(join(tmpRoot, "docs", "weekly-report.md"), "# weekly\n");
  await fs.writeFile(join(tmpRoot, "node_modules", "pkg", "index.js"), "module.exports=1;\n");
  await fs.writeFile(join(tmpRoot, ".git", "config"), "[core]\n");
  await fs.writeFile(join(tmpRoot, ".env.example"), "KEY=\n");
}

test("打分分档：全等 > 前缀 > 子串 > 路径子串 > 子序列，空串为 0", () => {
  assert.equal(scoreFilePath("app.ts", "src/app.ts"), 100);
  const prefix = scoreFilePath("app", "src/app.ts");
  assert.ok(prefix > 90 && prefix < 100, "前缀应落在 90–100 之间，实际 " + prefix);
  assert.equal(scoreFilePath("app.ts", "src/my-app.ts.bak"), 80); // basename 子串
  assert.equal(scoreFilePath("zzz", "src/my-app.ts.bak"), 0);
  assert.equal(scoreFilePath("guide", "docs/app-guide.md"), 80);
  assert.equal(scoreFilePath("docs", "docs/app-guide.md"), 70); // 只命中路径
  assert.equal(scoreFilePath("sd", "src/app.ts"), 0); // 太短不做子序列
  assert.equal(scoreFilePath("spx", "src/app.ts"), 0); // 子序列不成立（x 不存在）
  assert.equal(scoreFilePath("sats", "src/app.ts"), 40); // 子序列：s-a-t-s 依次出现
  assert.equal(scoreFilePath("", "src/app.ts"), 0);
  assert.equal(scoreFilePath("wy", "docs/weekly-report.md"), 0); // 两个字母太短
});

test("遍历：跳过产物目录与点目录，保留 .env.example，超上限截断", async () => {
  await seedWorkspace();
  const snap = await walkWorkspace(tmpRoot, 100);
  const paths = snap.paths.sort();
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(paths.includes("docs/weekly-report.md"));
  assert.ok(paths.includes(".env.example"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules 必须跳过");
  assert.ok(!paths.some((p) => p.startsWith(".git/")), ".git 必须跳过");
  assert.equal(snap.truncated, false);
  assert.ok(snap.scanned >= paths.length);

  const capped = await walkWorkspace(tmpRoot, 1);
  assert.equal(capped.paths.length, 1);
  assert.equal(capped.truncated, true);
});

test("索引检索：排序 + 子目录过滤 + 缓存命中", async () => {
  await seedWorkspace();
  const idx = await createWorkspaceFileIndex(tmpRoot, { ttlMs: 5000 });
  const first = await idx.search("app");
  const names = first.hits.map((h) => h.path);
  assert.ok(names.includes("src/app.ts"));
  assert.ok(names.indexOf("src/app.ts") <= names.indexOf("docs/app-guide.md") + 1);
  assert.equal(first.fromCache, false);
  const second = await idx.search("app");
  assert.equal(second.fromCache, true);
  const scoped = await idx.search("app", { path: "docs" });
  assert.deepEqual(scoped.hits.map((h) => h.path), ["docs/app-guide.md"]);
  const limited = await idx.search("md", { limit: 1 });
  assert.equal(limited.hits.length, 1);
  await idx.close();
});

test("刷新与 watch：新增文件能被检索到；watch 能标脏（不支持递归 watch 时退回刷新）", async () => {
  const root = mkdtempSync(join(tmpdir(), "xiaoluo-fi-w-"));
  await fs.writeFile(join(root, "alpha.ts"), "a");
  const idx = await createWorkspaceFileIndex(root, { ttlMs: 60_000 });
  assert.equal((await idx.search("beta")).hits.length, 0);

  const watched = idx.watch();
  // watch 先挂上再写文件，才有事件可收
  await fs.writeFile(join(root, "beta-tool.ts"), "b");
  await new Promise((r) => setTimeout(r, 800));
  if (watched) {
    const hits = (await idx.search("beta")).hits.map((h) => h.path);
    assert.ok(hits.includes("beta-tool.ts"), "watch 后应自动重建并看到新文件");
  } else {
    await idx.refresh();
    assert.ok((await idx.search("beta")).hits.some((h) => h.path === "beta-tool.ts"));
  }
  await idx.close();
});

test("两端算法一致：桌面版打分与后台版对同一批路径给同样结果", () => {
  const samples = [
    "src/app.ts",
    "docs/app-guide.md",
    "deep/tree/WeeklyReportGenerator.tsx",
    "a/b/c/xiaoluo-brain-panel.tsx",
    "README.md",
    ".env.example",
  ];
  for (const q of ["app", "guide", "weeklyreport", "brain", "README", "b.c.p"]) {
    for (const rel of samples) {
      assert.equal(CLIENT.scoreFuzzyPath(q, rel), scoreFilePath(q, rel), `${q} × ${rel}`);
    }
  }
});

test("工具注册与接线：有索引才注册 fuzzy_find_files；四处接线齐全", async () => {
  const withFuzzy = buildChatToolSchemas({ fsEnabled: true, fuzzyFindEnabled: true }).map((s) => s.function.name);
  assert.ok(withFuzzy.includes("fuzzy_find_files"));
  const withoutFuzzy = buildChatToolSchemas({ fsEnabled: true }).map((s) => s.function.name);
  assert.ok(!withoutFuzzy.includes("fuzzy_find_files"));

  const route = await read("api/v2/brain/fs/route.ts");
  assert.match(route, /action === "fuzzy"/);
  assert.match(route, /fuzzyFindSandboxFiles/);
  const sandbox = await read("lib/brain-sandbox.ts");
  assert.match(sandbox, /export async function fuzzyFindSandboxFiles/);
  const panel = await read("components/xiaoluo-brain-panel.tsx");
  assert.match(panel, /fuzzyFind: async/);
  assert.match(panel, /brainFs\("fuzzy"/);
  const agent = await read("xiaoluo-brain/lib/brain/chat-agent.ts");
  assert.match(agent, /execFuzzyFindFiles/);
  assert.match(agent, /case "fuzzy_find_files"/);
  const runtime = await fs.readFile(fileURLToPath(new URL("../../../客户端/source/desktop/local-runtime.mjs", import.meta.url)), "utf8");
  assert.match(runtime, /action === "fuzzy"/);
  assert.match(runtime, /function fsFuzzy/);
});

test.after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});
