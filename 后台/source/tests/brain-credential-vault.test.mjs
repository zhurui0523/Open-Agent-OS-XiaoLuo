/**
 * 第 7.11 项：凭据钥匙串（AES-256-GCM 本地加密库 + 出站代理优先取库）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const appPath = (p) => fileURLToPath(new URL("app/" + p, ROOT));
const app = (p) => pathToFileURL(appPath(p)).href;
const read = async (p) => (await import("node:fs/promises")).readFile(appPath(p), "utf8");

const V = await import(app("lib/credential-vault.ts"));
const E = await import(app("lib/egress-proxy.ts"));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "xiaoluo-vault-"));
}

test("存取删：值不落明文、列表只回名字、删后取不到", async () => {
  const dir = freshDir();
  const meta = await V.setSecret(dir, "GITHUB_TOKEN", "ghp_secret_value_1234", "推送用");
  assert.equal(meta.name, "GITHUB_TOKEN");
  assert.equal(meta.preview, "••••1234");
  assert.equal(await V.getSecret(dir, "GITHUB_TOKEN"), "ghp_secret_value_1234");

  const raw = await fs.readFile(V.vaultFilePath(dir), "utf8");
  assert.ok(!raw.includes("ghp_secret_value_1234"), "密文文件里不能出现明文");
  const parsed = JSON.parse(raw);
  assert.ok(parsed.entries.GITHUB_TOKEN.iv && parsed.entries.GITHUB_TOKEN.tag && parsed.entries.GITHUB_TOKEN.data);

  const list = await V.listSecrets(dir);
  assert.deepEqual(list.map((s) => s.name), ["GITHUB_TOKEN"]);
  assert.equal(list[0].note, "推送用");
  assert.ok(!JSON.stringify(list).includes("ghp_secret"), "列表不能泄露值");

  assert.equal(await V.deleteSecret(dir, "GITHUB_TOKEN"), true);
  assert.equal(await V.getSecret(dir, "GITHUB_TOKEN"), null);
  assert.equal(await V.deleteSecret(dir, "GITHUB_TOKEN"), false);
  assert.deepEqual(await V.listSecrets(dir), []);
});

test("参数校验：名字非法/空值/超长都拒绝；缺省取回 null", async () => {
  const dir = freshDir();
  await assert.rejects(() => V.setSecret(dir, "../evil", "x"), /凭据名不合法/);
  await assert.rejects(() => V.setSecret(dir, "", "x"), /凭据名不合法/);
  await assert.rejects(() => V.setSecret(dir, "OK_NAME", ""), /不能为空/);
  await assert.rejects(() => V.setSecret(dir, "BIG", "x".repeat(70 * 1024)), /64KB/);
  assert.equal(await V.getSecret(dir, "NOT_THERE"), null);
});

test("换名贴密文 / 篡改数据都会解密失败（AAD 绑定 + GCM 校验）", async () => {
  const dir = freshDir();
  await V.setSecret(dir, "A_TOKEN", "aaaa-secret");
  await V.setSecret(dir, "B_TOKEN", "bbbb-secret");
  const file = V.vaultFilePath(dir);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  raw.entries.B_TOKEN = raw.entries.A_TOKEN; // 把 A 的密文放到 B 名下
  await fs.writeFile(file, JSON.stringify(raw, null, 2), "utf8");
  await assert.rejects(() => V.getSecret(dir, "B_TOKEN"), /解密失败/);

  raw.entries.A_TOKEN.data = Buffer.from("tampered").toString("base64");
  await fs.writeFile(file, JSON.stringify(raw, null, 2), "utf8");
  await assert.rejects(() => V.getSecret(dir, "A_TOKEN"), /解密失败/);
});

test("环境主密钥：XIAOLUO_VAULT_KEY 优先，清缓存后仍能解；无 env 时 key 文件 0600（POSIX）", async () => {
  const dir = freshDir();
  process.env.XIAOLUO_VAULT_KEY = "test-master-key-please-rotate";
  V.resetVaultKeyCacheForTests();
  await V.setSecret(dir, "KEY1", "value-one");
  V.resetVaultKeyCacheForTests();
  assert.equal(await V.getSecret(dir, "KEY1"), "value-one");
  delete process.env.XIAOLUO_VAULT_KEY;
  V.resetVaultKeyCacheForTests();

  // 没有 env 时才生成 key 文件：验证权限收紧
  const dir2 = freshDir();
  await V.setSecret(dir2, "KEY2", "value-two");
  assert.equal(await V.getSecret(dir2, "KEY2"), "value-two");
  if (process.platform !== "win32") {
    const st = await fs.stat(join(dir2, "vault.key"));
    assert.equal(st.mode & 0o777, 0o600);
  }
  V.resetVaultKeyCacheForTests();
});

test("出站代理优先用钥匙串：无环境变量也能注入凭据头，审计不含 token", async () => {
  const dir = freshDir();
  await V.setSecret(dir, "VAULT_E2E_TOKEN", "vault-token-value-9999");

  const seen = [];
  const target = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "text/plain" }).end("pong");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = (target.address()).port;

  const audits = [];
  const proxy = await E.startEgressProxy({
    allow: ["127.0.0.1"],
    credentials: [{ host: "127.0.0.1", env: "VAULT_E2E_TOKEN", header: "Authorization", prefix: "Bearer" }],
    onAudit: (e) => audits.push(e),
    resolveSecret: async (name) => {
      try {
        return await V.getSecret(dir, name);
      } catch {
        return null;
      }
    },
  });

  delete process.env.VAULT_E2E_TOKEN;
  await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxy.port, method: "GET", path: `http://127.0.0.1:${port}/ping`, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          assert.equal(res.statusCode, 200);
          assert.equal(body, "pong");
          resolve();
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
  await proxy.close();
  await new Promise((r) => target.close(r));

  assert.ok(seen.length > 0);
  assert.equal(seen[0], "Bearer vault-token-value-9999", "token 应来自钥匙串而不是环境变量");
  assert.ok(!JSON.stringify(audits).includes("vault-token-value-9999"), "审计不能出现 token 明文");
});

test("接线：brain-sandbox 走 brainVaultDir 解析、vault 路由存在、代理签名支持异步解析", async () => {
  const sandbox = await read("lib/brain-sandbox.ts");
  assert.match(sandbox, /export function brainVaultDir/);
  assert.match(sandbox, /getSecret\(brainVaultDir\(userId\), name\)/);
  assert.match(sandbox, /ensureEgressEnv\("ws:" \+ sanitizeOwner\(userId\), config\.egress, undefined/);

  const route = await read("api/v2/brain/vault/route.ts");
  assert.match(route, /listSecrets\(brainVaultDir\(user\.id\)\)/);
  assert.match(route, /setSecret\(brainVaultDir\(user\.id\)/);
  assert.match(route, /deleteSecret\(brainVaultDir\(user\.id\)/);

  const egress = await read("lib/egress-proxy.ts");
  assert.match(egress, /preloadedSecrets/);
});
