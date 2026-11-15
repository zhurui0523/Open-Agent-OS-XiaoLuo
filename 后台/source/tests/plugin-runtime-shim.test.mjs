import assert from "node:assert/strict";
import test from "node:test";

import {
  pluginRuntimeShimScript,
  rewriteRuntimeStaticText,
  rewriteRuntimeUrl,
  runtimeRootFromRequest,
} from "../app/lib/plugin-runtime-shim.ts";

const SHA = "f2f9666186bfa826aaad86eefb3bb62be13e086aeb791893cecd68e72a0a7a08";
const SESSION_ROOT =
  "http://127.0.0.1:3000/api/v2/packages/runtime/session/eyJ2IjoxfQ.abc123" +
  `/static/ws-1/github.react-example/0.1.0/${SHA}/_root/`;
const DIRECT_ROOT =
  "http://127.0.0.1:3000/api/v2/packages/runtime/static" +
  `/ws-1/github.react-example/0.1.0/${SHA}/_root/`;

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

test("runtime root keeps the signed session prefix for both route shapes", () => {
  assert.equal(
    runtimeRootFromRequest(new Request(SESSION_ROOT.replace(/\/$/, "")), {}),
    SESSION_ROOT,
  );
  assert.equal(
    runtimeRootFromRequest(new Request(`${SESSION_ROOT}index.html`), {
      path: ["index.html"],
    }),
    SESSION_ROOT,
  );
  assert.equal(
    runtimeRootFromRequest(new Request(`${SESSION_ROOT}assets/index-CCvSNK3w.js`), {
      path: ["assets", "index-CCvSNK3w.js"],
    }),
    SESSION_ROOT,
  );
  assert.equal(
    runtimeRootFromRequest(new Request(`${DIRECT_ROOT}models/facecap.glb`), {
      path: ["models", "facecap.glb"],
    }),
    DIRECT_ROOT,
  );
});

test("root-absolute plugin URLs resolve under the runtime root", () => {
  assert.equal(
    rewriteRuntimeUrl("/models/facecap.glb", SESSION_ROOT),
    `${SESSION_ROOT}models/facecap.glb`,
  );
  assert.equal(
    rewriteRuntimeUrl("/assets/basis_transcoder.wasm?v=2#top", SESSION_ROOT),
    `${SESSION_ROOT}assets/basis_transcoder.wasm?v=2#top`,
  );
  assert.equal(
    rewriteRuntimeUrl("http://127.0.0.1:3000/models/facecap.glb", SESSION_ROOT),
    `${SESSION_ROOT}models/facecap.glb`,
  );
  assert.equal(
    rewriteRuntimeUrl(`${SESSION_ROOT}assets/a.css`, SESSION_ROOT),
    `${SESSION_ROOT}assets/a.css`,
  );
  assert.equal(
    rewriteRuntimeUrl("/api/v2/files/upload", SESSION_ROOT),
    "/api/v2/files/upload",
  );
  assert.equal(rewriteRuntimeUrl("/_next/image", SESSION_ROOT), "/_next/image");
  assert.equal(
    rewriteRuntimeUrl("//cdn.example.com/a.js", SESSION_ROOT),
    "//cdn.example.com/a.js",
  );
  assert.equal(
    rewriteRuntimeUrl("https://other.example.com/a.js", SESSION_ROOT),
    "https://other.example.com/a.js",
  );
  assert.equal(rewriteRuntimeUrl("./assets/a.js", SESSION_ROOT), "./assets/a.js");
  assert.equal(
    rewriteRuntimeUrl("data:image/png;base64,AA", SESSION_ROOT),
    "data:image/png;base64,AA",
  );
});

test("html and css text move onto the runtime root", () => {
  const html = decode(
    rewriteRuntimeStaticText(
      encode(
        '<!doctype html><html><head><base href="/"><link rel="stylesheet" href="/assets/index.css">' +
          '<script type="module" src="/assets/index-CCvSNK3w.js"></script></head><body></body></html>',
      ),
      "html",
      SESSION_ROOT,
    ),
  );

  assert.ok(!html.includes("<base href"));
  assert.equal(
    html.includes(`href="${SESSION_ROOT}assets/index.css"`),
    true,
  );
  assert.equal(html.includes(`src="${SESSION_ROOT}assets/index-CCvSNK3w.js"`), true);
  assert.ok(html.indexOf("data-xiaoluo-runtime-shim") < html.indexOf('type="module"'));

  const css = decode(
    rewriteRuntimeStaticText(
      encode(".a{background:url(/images/a.png)}.b{background:url('./b.png')}"),
      "css",
      SESSION_ROOT,
    ),
  );
  assert.equal(css, `.a{background:url(${SESSION_ROOT}images/a.png)}.b{background:url('./b.png')}`);

  const js = encode("fetch('/models/facecap.glb')");
  assert.equal(rewriteRuntimeStaticText(js, "js", SESSION_ROOT), js);
});

function installShimInFakeWindow() {
  const script = pluginRuntimeShimScript(SESSION_ROOT);
  assert.ok(!script.includes("</script"));

  const fetches = [];
  class FakeRequest {
    constructor(input) {
      this.url = typeof input === "string" ? input : String(input && input.url);
    }
  }
  class FakeXmlHttp {}
  FakeXmlHttp.prototype.open = function open(...args) {
    this.opened = args;
  };
  class FakeElement {}
  FakeElement.prototype.setAttribute = function setAttribute(name, value) {
    this.attrs = [name, value];
  };

  const win = {
    fetch(input) {
      fetches.push(typeof input === "string" ? input : input.url);
    },
    Request: FakeRequest,
    XMLHttpRequest: FakeXmlHttp,
    Element: FakeElement,
  };
  win.window = win;
  new Function("window", "console", script)(win, { info() {} });

  return { win, fetches, FakeRequest, FakeXmlHttp, FakeElement };
}

test("the injected shim reroutes the plugin network entry points", () => {
  const { win, fetches, FakeRequest, FakeXmlHttp, FakeElement } =
    installShimInFakeWindow();

  win.fetch("/models/facecap.glb");
  win.fetch("./assets/local.css");
  win.fetch("/api/v2/files/upload");
  win.fetch(new FakeRequest("/basis/basis_transcoder.js"));
  assert.deepEqual(fetches, [
    `${SESSION_ROOT}models/facecap.glb`,
    "./assets/local.css",
    "/api/v2/files/upload",
    `${SESSION_ROOT}basis/basis_transcoder.js`,
  ]);

  const xhr = new FakeXmlHttp();
  xhr.open("GET", "/models/facecap.glb");
  assert.deepEqual(xhr.opened, ["GET", `${SESSION_ROOT}models/facecap.glb`]);

  const element = new FakeElement();
  element.setAttribute("src", "/images/thumb.png");
  assert.deepEqual(element.attrs, ["src", `${SESSION_ROOT}images/thumb.png`]);

  assert.equal(win.__XIAOLUO_RUNTIME_BASE__, SESSION_ROOT);
});
