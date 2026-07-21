import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the XiaoLuo AI workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>XiaoLuo AI Intent OS V2<\/title>/i);
  assert.match(html, /XiaoLuo AI/);
  assert.match(html, /Intent Console/);
  assert.match(html, /夏日品牌短片/);
  assert.match(html, /AI 会先生成可检查计划/);
  assert.doesNotMatch(html, /Your site is taking shape|react-loading-skeleton/);
});

test("keeps SKILL packages empty for later user integration", async () => {
  const [data, capabilityView, packageJson] = await Promise.all([
    readFile(new URL("../app/data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/capabilities-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(data, /core\.capability\.text/);
  assert.match(data, /core\.capability\.image/);
  assert.match(data, /core\.capability\.video/);
  assert.doesNotMatch(data, /core\.skill\.|analyze-script|create-script|video-dissect/);
  assert.match(capabilityView, /SKILL 接入区域已留空/);
  assert.match(capabilityView, /程序没有创建开发文档中的 14 个 SKILL/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("public/_sites-preview", root)));
});

