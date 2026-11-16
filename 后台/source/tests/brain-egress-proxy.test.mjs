/**
 * 第 7.3 项：出站代理最小版（域名白名单 + 凭据注入 + 审计）
 *
 * 原来 loopback 档只是把 HTTP(S)_PROXY 指向黑洞，白名单里的域名也连不上；
 * 现在可选 `[sandbox] egress = "proxy"`，走本机代理：白名单放行、黑名单优先、凭据按目标注入。
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import net from "node:net";
import test from "node:test";

import {
  parseEgressConfig,
  hostMatches,
  hostAllowed,
  startEgressProxy,
  ensureEgressEnv,
  resetEgressProxiesForTests,
  peekEgressProxy,
} from "../app/lib/egress-proxy.ts";

const TOML = `
[sandbox]
network = "loopback"
network_allow = ["api.github.com", "*.corp.com"]
egress = "proxy"

[[egress]]
host = "api.github.com"
header = "Authorization"
env = "GITHUB_TOKEN"
prefix = "Bearer"
`;

test("配置解析：egress 开关、凭据块、缺字段丢弃、写错退回关闭", () => {
  const parsed = parseEgressConfig(TOML);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.credentials, [
    { host: "api.github.com", header: "Authorization", env: "GITHUB_TOKEN", prefix: "Bearer" },
  ]);

  const off = parseEgressConfig('[sandbox]\nnetwork = "open"\n');
  assert.equal(off.enabled, false, "没写 egress 就保持关闭，不能默认改行为");

  const typo = parseEgressConfig('[sandbox]\negress = "proxxy"\n');
  assert.equal(typo.enabled, false, "写错取值退回关闭");

  const incomplete = parseEgressConfig('[[egress]]\nhost = "x.com"\n');
  assert.equal(incomplete.credentials.length, 0, "缺 env 的凭据块直接丢");
});

test("域名裁决：通配、后缀、黑名单优先、空白名单等于全拒", () => {
  assert.equal(hostMatches("api.github.com", "api.github.com"), true);
  assert.equal(hostMatches("API.GitHub.com", "api.github.com"), true, "大小写归一");
  assert.equal(hostMatches("a.corp.com", "*.corp.com"), true);
  assert.equal(hostMatches("corp.com", "*.corp.com"), true, "后缀通配也含自身");
  assert.equal(hostMatches("evilcorp.com", "*.corp.com"), false, "不能后缀拼接误放行");
  assert.equal(hostMatches("anything", "*"), true);

  assert.equal(hostAllowed("api.github.com", { allow: ["api.github.com"], deny: [] }).ok, true);
  assert.equal(hostAllowed("api.github.com", { allow: ["*"], deny: ["api.github.com"] }).ok, false, "黑名单优先");
  assert.equal(hostAllowed("random.example", { allow: [], deny: [] }).ok, false, "没白名单就不放行");
});

test("CONNECT 隧道：白名单内放行且数据能通，名单外 403 并留审计", async () => {
  const echo = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write("echo:" + chunk.toString()));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = echo.address().port;

  const proxy = await startEgressProxy({ allow: ["127.0.0.1"] });
  try {
    // 放行：CONNECT 到回环上的 echo 服务
    const tunneled = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: `127.0.0.1:${echoPort}` });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error("CONNECT 被拒：" + res.statusCode));
        socket.write("ping");
        socket.once("data", (buf) => {
          socket.destroy();
          resolve(buf.toString());
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(tunneled, "echo:ping");

    // 拒绝：CONNECT 到不在白名单的主机
    const denied = await new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: "example.com:443" });
      req.on("connect", (res) => resolve(res.statusCode));
      req.on("error", () => resolve(403));
      req.end();
    });
    assert.equal(denied, 403);

    const denyEntry = proxy.audit.find((a) => a.host === "example.com" && a.decision === "deny");
    assert.ok(denyEntry, JSON.stringify(proxy.audit));
    assert.match(denyEntry.reason, /不在白名单/);
  } finally {
    await proxy.close();
    await new Promise((resolve) => echo.close(resolve));
  }
});

test("明文 HTTP 转发：按目标注入凭据头，token 不进审计，未配凭据不注入", async () => {
  const seen = [];
  const target = createHttpServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  process.env.XIAOLUO_TEST_EGRESS_TOKEN = "super-secret-token";

  const proxy = await startEgressProxy({
    allow: ["127.0.0.1"],
    credentials: [{ host: "127.0.0.1", header: "Authorization", env: "XIAOLUO_TEST_EGRESS_TOKEN", prefix: "Bearer" }],
  });
  try {
    const body = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "POST",
          path: `http://127.0.0.1:${targetPort}/upload`,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end('{"a":1}');
    });
    assert.equal(body, "ok");
    assert.equal(seen[0].url, "/upload");
    assert.equal(seen[0].auth, "Bearer super-secret-token");

    const auditText = JSON.stringify(proxy.audit);
    assert.ok(!auditText.includes("super-secret-token"), "审计里绝不能出现 token");
    assert.equal(proxy.audit.filter((a) => a.decision === "allow").length, 1);
  } finally {
    delete process.env.XIAOLUO_TEST_EGRESS_TOKEN;
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test("ensureEgressEnv：未启用返回空、启用后复用同一代理", async () => {
  await resetEgressProxiesForTests();
  const off = await ensureEgressEnv("ws-off", { enabled: false, allow: ["x.com"], deny: [], credentials: [] });
  assert.deepEqual(off, {});

  const first = await ensureEgressEnv("ws-on", { enabled: true, allow: ["127.0.0.1"], deny: [], credentials: [] });
  const second = await ensureEgressEnv("ws-on", { enabled: true, allow: ["127.0.0.1"], deny: [], credentials: [] });
  assert.equal(first.HTTP_PROXY, second.HTTP_PROXY, "同一工作区应复用代理，不能每次起一个新的");
  assert.ok(first.HTTP_PROXY.startsWith("http://127.0.0.1:"));
  assert.ok(peekEgressProxy("ws-on"), "注册表里应有缓存");
  await resetEgressProxiesForTests();
});

test("接线：命令/服务/git/会话四条路径都走 networkEnvForUser，白名单与 egress 共用一份配置", async () => {
  const { readFile } = await import("node:fs/promises");
  const root = new URL("../", import.meta.url);
  const src = await readFile(new URL("app/lib/brain-sandbox.ts", root), "utf8");
  assert.match(src, /import \{ ensureEgressEnv, parseEgressConfig/);
  assert.match(src, /async function networkEnvForUser\(userId: string, mode: NetworkMode\)/);
  assert.match(src, /mode !== "loopback"/, "open/block 保持原策略，不能默认接管");
  const calls = src.match(/networkEnvForUser\(/g) ?? [];
  assert.ok(calls.length >= 4, "命令 / 服务 / git / 交互会话都要接上，实际：" + calls.length);
  // 白名单只有一份来源：egress.allow 由 network_allow 覆盖，避免两处配置打架
  assert.match(src, /egress\.allow = allowHosts/);
  // 播种模板里要能看见 egress 的用法，否则用户永远不知道有这个开关
  assert.match(src, /egress = "proxy"/);
});
