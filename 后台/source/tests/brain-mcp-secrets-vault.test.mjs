/**
 * 第 7.11 收尾：MCP secrets 迁钥匙串 + 面板凭据读写
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = await import("../../../客户端/source/desktop/secret-vault.mjs");
const RT = await import("../../../客户端/source/desktop/mcp-runtime.mjs");

function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "xiaoluo-mcp-vault-"));
  process.env.XIAOLUO_DATA_DIR = dir;
  VAULT.resetVaultCacheForTests();
  return dir;
}

test("钥匙串：存取删 + 列表不回明文 + 换名贴密文解不开", async () => {
  freshDataDir();
  await VAULT.setSecret("github.TOKEN", "ghp_plain_secret_value", "github token");
  assert.equal(await VAULT.getSecret("github.TOKEN"), "ghp_plain_secret_value");
  const list = await VAULT.listSecrets();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "github.TOKEN");
  assert.ok(!JSON.stringify(list).includes("ghp_plain_secret_value"), "列表不能带明文");

  const dir = process.env.XIAOLUO_DATA_DIR;
  const raw = await fs.readFile(join(dir, "mcp-secrets.json"), "utf8");
  assert.ok(!raw.includes("ghp_plain_secret_value"), "落盘文件不能有明文");

  await VAULT.deleteSecret("github.TOKEN");
  assert.equal(await VAULT.getSecret("github.TOKEN"), undefined);
});

test("迁移：mcp.json 里像凭据的明文挪进钥匙串并换成 vault://，非密钥字段不动", async () => {
  const dir = freshDataDir();
  const configPath = join(dir, "mcp.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          github: {
            command: "node",
            args: ["server.js"],
            env: { GITHUB_TOKEN: "ghp_plain_123", LOG_LEVEL: "info" },
            oauth: { clientId: "cid", clientSecret: "shh-client-secret" },
          },
        },
      },
      null,
      2,
    ),
  );

  const out = await VAULT.migrateMcpConfig(configPath);
  assert.equal(out.ok, true);
  assert.deepEqual(out.moved.sort(), ["github.GITHUB_TOKEN", "github.oauth.clientSecret"].sort());
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.mcpServers.github.env.GITHUB_TOKEN, "vault://github.GITHUB_TOKEN");
  assert.equal(saved.mcpServers.github.env.LOG_LEVEL, "info", "非凭据字段保持原样");
  assert.equal(saved.mcpServers.github.oauth.clientSecret, "vault://github.oauth.clientSecret");
  assert.equal(saved.mcpServers.github.oauth.clientId, "cid");
  const raw = await fs.readFile(configPath, "utf8");
  assert.ok(!raw.includes("ghp_plain_123"));
  assert.ok(!raw.includes("shh-client-secret"));

  assert.equal(await VAULT.getSecret("github.GITHUB_TOKEN"), "ghp_plain_123");
  assert.equal(await VAULT.getSecret("github.oauth.clientSecret"), "shh-client-secret");

  // 迁移可重复执行：已是 vault:// 不再搬
  const again = await VAULT.migrateMcpConfig(configPath);
  assert.equal(again.moved.length, 0);
});

test("引用缺失：servers 同步直接报「缺少凭据」，不拿空值去连", async () => {
  const dir = freshDataDir();
  const workspace = mkdtempSync(join(tmpdir(), "xiaoluo-mcp-ws-"));
  await fs.writeFile(
    join(workspace, "mcp.json"),
    JSON.stringify({ mcpServers: { demo: { command: "definitely-not-a-real-command", env: { API_KEY: "vault://demo.API_KEY" } } } }),
  );
  RT.initMcpRuntime(workspace);
  const out = await RT.handleMcpPayload({ action: "servers" });
  assert.equal(out.servers.length, 1);
  assert.equal(out.servers[0].ok, false);
  assert.match(out.servers[0].error, /缺少凭据：env\.API_KEY/);
  assert.equal(out.servers[0].tools.length, 0);
});

test("面板接线：设置面板有「MCP 凭据」读写/迁移入口", async () => {
  const panel = await fs.readFile(new URL("../app/components/agent-config-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /MCP 凭据/);
  assert.match(panel, /secrets\/list/);
  assert.match(panel, /secrets\/set/);
  assert.match(panel, /secrets\/migrate/);
  const settings = await fs.readFile(new URL("../app/components/settings-center.tsx", import.meta.url), "utf8");
  assert.match(settings, /tab === "secrets" && <McpSecretsPanel/);
  assert.match(settings, /<span>凭据<\/span>/);
  const runtime = await fs.readFile(new URL("../../../客户端/source/desktop/mcp-runtime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /secrets\/list/);
  assert.match(runtime, /secrets\/set/);
});
