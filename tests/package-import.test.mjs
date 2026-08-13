import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  inspectPackageArchive,
  inspectSourceArchive,
  PackageArchiveError,
} from "../app/lib/package-archive.ts";
import {
  needsDefaultSandboxPanel,
  needsHostedSandboxRuntime,
  withDefaultSandboxPanel,
  withHostedSandboxRuntime,
} from "../app/lib/package-manifest-adapter.ts";
import { parsePackagePayload } from "../app/lib/package-contract.ts";
import {
  canRefreshGeneratedGithubManifest,
  canRefreshGeneratedSourceManifest,
  packageInstallSourceFromDetailJson,
} from "../app/lib/package-version-policy.ts";
import { resolveAdvertisedGithubCommit } from "../app/lib/github-smart-http.ts";
import {
  normalizeInternalPluginRuntimeUrl,
  scorePluginRuntimeCandidate,
} from "../app/lib/plugin-runtime-launch.ts";
import {
  isRetryablePluginLaunchStatus,
  launchPluginRuntime,
} from "../app/lib/plugin-runtime-client.ts";

const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function storedZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const [path, value] of entries) {
    const name = encoder.encode(path);
    const data = typeof value === "string" ? encoder.encode(value) : value;
    const crc = crc32(data);

    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localChunks.push(local, name, data);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    centralChunks.push(central, name);

    localOffset += local.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = concat(centralChunks);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, localOffset, true);

  return concat([...localChunks, centralDirectory, end]);
}

const manifest = JSON.stringify({
  schemaVersion: "2.0",
  id: "com.example.demo",
  name: "Demo plugin",
  version: "1.0.0",
  type: "plugin",
  runtime: { mode: "declarative" },
  permissions: [],
  contributes: {},
});

test("accepts a safe plugin ZIP and reads files below its repository root", async () => {
  const archive = storedZip([
    ["demo-main/xiaoluo.plugin.json", manifest],
    ["demo-main/README.md", "# Demo"],
  ]);
  const inspection = await inspectPackageArchive(archive);

  assert.equal(inspection.rootPrefix, "demo-main/");
  assert.equal(inspection.manifestPath, "demo-main/xiaoluo.plugin.json");
  assert.equal(
    new TextDecoder().decode(
      await inspection.readFile("demo-main/README.md"),
    ),
    "# Demo",
  );
  assert.match(inspection.archiveSha256, /^[a-f0-9]{64}$/);
});

test("rejects ZIP path traversal before extraction", async () => {
  const archive = storedZip([
    ["xiaoluo.plugin.json", manifest],
    ["../outside.txt", "unsafe"],
  ]);
  await assert.rejects(
    () => inspectPackageArchive(archive),
    (error) =>
      error instanceof PackageArchiveError && error.code === "UNSAFE_PATH",
  );
});

test("rejects secrets embedded in an imported package", async () => {
  const archive = storedZip([
    ["xiaoluo.plugin.json", manifest],
    [".env", "API_KEY=secret"],
  ]);
  await assert.rejects(
    () => inspectPackageArchive(archive),
    (error) =>
      error instanceof PackageArchiveError &&
      error.code === "SENSITIVE_FILE",
  );
});

test("GitHub import supports arbitrary repositories and generates an adapter", async () => {
  const source = await readFile(
    new URL("../app/lib/package-import.ts", import.meta.url),
    "utf8",
  );
  const route = await readFile(
    new URL(
      "../app/api/v2/packages/import/github/route.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /generateGithubPackageManifest/);
  assert.match(source, /executionReady/);
  assert.match(route, /inspectSourceArchive/);
  assert.match(route, /generatedManifest/);
  assert.doesNotMatch(route, /必须.*XiaoLuo.*结构/);
  assert.match(source, /downloadGithubPackageViaGit/);
  assert.match(source, /application\/x-git-upload-pack-advertisement/);
});

test("manifest-less ZIP Skill remains safely inspectable for automatic adaptation", async () => {
  const archive = storedZip([
    [
      "community-tool/SKILL.md",
      "---\nname: Community Tool\ndescription: A reusable community skill\n---\n# Community Tool\n\nFollow the user request and return a concise result.",
    ],
    ["community-tool/README.md", "# Community Tool"],
  ]);
  const inspection = await inspectSourceArchive(archive);
  const source = await readFile(
    new URL("../app/lib/package-import.ts", import.meta.url),
    "utf8",
  );

  assert.equal(inspection.files.some((file) => /SKILL\.md$/i.test(file.relativePath)), true);
  assert.match(source, /projectType === "skill"/);
  assert.match(source, /skillManifestFromMarkdown/);
  assert.match(source, /executionReady: true/);
});

test("manifest-less frontend ZIP is preserved for static sandbox adaptation", async () => {
  const archive = storedZip([
    [
      "community-ui/package.json",
      JSON.stringify({
        name: "community-ui",
        scripts: { build: "vite build" },
        dependencies: { react: "latest", vite: "latest" },
      }),
    ],
    ["community-ui/index.html", '<div id="root"></div><script type="module" src="/src/main.tsx"></script>'],
    ["community-ui/src/main.tsx", "export default null"],
  ]);
  const inspection = await inspectSourceArchive(archive);
  const source = await readFile(
    new URL("../app/lib/package-import.ts", import.meta.url),
    "utf8",
  );

  assert.equal(inspection.files.some((file) => file.relativePath === "package.json"), true);
  assert.match(source, /"static-sandbox"/);
  assert.match(source, /generateSourcePackageManifest/);
});

test("archive import falls back to source inspection when Manifest is absent", async () => {
  const route = await readFile(
    new URL(
      "../app/api/v2/packages/import/archive/route.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(route, /PACKAGE_MANIFEST_MISSING/);
  assert.match(route, /inspectSourceArchive/);
  assert.match(route, /generateSourcePackageManifest/);
  assert.match(route, /generatedManifest/);
});

test("GitHub import resolves immutable commits without the GitHub API", () => {
  const advertisement = [
    "001e# service=git-upload-pack\n0000",
    "0066aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa HEAD\0multi_ack\n",
    "003fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/heads/develop\n",
    "0044cccccccccccccccccccccccccccccccccccccccc refs/tags/v1.2.0^{}\n",
  ].join("");

  assert.equal(
    resolveAdvertisedGithubCommit(advertisement),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(
    resolveAdvertisedGithubCommit(advertisement, "develop"),
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(
    resolveAdvertisedGithubCommit(advertisement, "v1.2.0"),
    "cccccccccccccccccccccccccccccccccccccccc",
  );
});

test("GitHub import adds a default panel only for panel-less sandbox UIs", () => {
  const payload = {
    schemaVersion: "2.0",
    id: "com.example.frontend",
    name: "Frontend plugin",
    version: "1.0.0",
    type: "plugin",
    runtime: {
      type: "sandbox-ui",
      entry: "https://example.com/old/",
    },
    permissions: [],
    contributes: {
      nodes: [],
    },
  };

  assert.equal(needsDefaultSandboxPanel(payload), true);
  const adapted = withDefaultSandboxPanel({
    payload,
    runtimeEntry: "http://127.0.0.1:3001/runtime/",
  });
  const manifest = parsePackagePayload(adapted);
  assert.equal(manifest.runtime.type, "sandbox-ui");
  assert.equal(manifest.runtime.entry, "http://127.0.0.1:3001/runtime/");
  assert.deepEqual(manifest.contributes?.panels, [
    {
      id: "com.example.frontend.panel",
      title: "Frontend plugin",
    },
  ]);
});

test("GitHub import preserves plugin-provided panel configuration", () => {
  const payload = {
    schemaVersion: "2.0",
    id: "com.example.frontend",
    name: "Frontend plugin",
    version: "1.0.0",
    type: "plugin",
    runtime: {
      type: "sandbox-ui",
      entry: "https://example.com/app/",
    },
    contributes: {
      panels: [
        {
          id: "com.example.frontend.settings",
          title: "Custom panel",
          entry: "settings.html",
        },
      ],
    },
  };

  assert.equal(needsDefaultSandboxPanel(payload), false);
});

test("GitHub import self-hosts a sandbox UI whose runtime entry is missing", () => {
  const payload = {
    schemaVersion: "2.0",
    id: "com.example.hosted",
    name: "Hosted plugin",
    version: "1.0.0",
    type: "plugin",
    runtime: { type: "sandbox-ui" },
    contributes: {
      panels: [{ id: "com.example.hosted.panel", title: "Hosted" }],
    },
  };

  assert.equal(needsDefaultSandboxPanel(payload), false);
  assert.equal(needsHostedSandboxRuntime(payload), true);
  const adapted = withHostedSandboxRuntime({
    payload,
    runtimeEntry:
      "/api/v2/packages/runtime/static/workspace/com.example.hosted/1.0.0/abc/_root/",
  });
  const manifest = parsePackagePayload(adapted);
  assert.equal(
    manifest.runtime.entry,
    "/api/v2/packages/runtime/static/workspace/com.example.hosted/1.0.0/abc/_root/",
  );
  assert.deepEqual(manifest.contributes?.panels, payload.contributes.panels);
});

test("internal plugin runtime follows the current LAN or server origin", () => {
  const target = normalizeInternalPluginRuntimeUrl(
    "http://localhost:3001/api/v2/packages/runtime/static/workspace/demo/1.0.0/sha/_root/",
    "http://192.168.3.9:3001/api/v2/packages/runtime/launch",
  );
  assert.equal(
    target?.href,
    "http://192.168.3.9:3001/api/v2/packages/runtime/static/workspace/demo/1.0.0/sha/_root/",
  );
  const hostedTarget = normalizeInternalPluginRuntimeUrl(
    "http://127.0.0.1:3001/api/v2/packages/runtime/static/workspace/demo/1.0.0/sha/_root/?mode=preview",
    "https://xiaoluo.example.com/api/v2/packages/runtime/launch",
  );
  assert.equal(
    hostedTarget?.href,
    "https://xiaoluo.example.com/api/v2/packages/runtime/static/workspace/demo/1.0.0/sha/_root/?mode=preview",
  );
  assert.equal(
    normalizeInternalPluginRuntimeUrl(
      "https://example.com/plugin/",
      "http://192.168.3.9:3001/api/v2/packages/runtime/launch",
    ),
    null,
  );
});

test("stale canvas plugin resolves to the current installation by name", () => {
  const candidate = {
    id: "package-current",
    packageKey: "github.example-user.xiaoluo-panorama",
    name: "xiaoluo-vr-panorama",
    version: "0.0.0-git.current",
  };

  assert.equal(
    scorePluginRuntimeCandidate(candidate, {
      packageId: "package-removed",
      packageKey: "source.upload.xiaoluo-panorama-main",
      packageName: "xiaoluo-vr-panorama",
      savedPackageKey: "source.upload.xiaoluo-panorama-main",
      savedVersion: "0.0.0-src.old",
    }),
    250,
  );
  assert.equal(
    scorePluginRuntimeCandidate(candidate, {
      packageName: "unrelated-plugin",
      savedPackageKey: "source.upload.unrelated",
      savedVersion: candidate.version,
    }),
    0,
  );
});

test("plugin runtime launch retries a temporary not-ready response", async () => {
  let calls = 0;
  const runtimeUrl = "/api/v2/packages/runtime/session/token/static/plugin/index.html";

  const result = await launchPluginRuntime(
    {
      url: "/api/v2/packages/runtime/static/workspace/demo/1.0.0/sha/_root/",
      workspaceId: "workspace",
      packageId: "package-demo",
      packageName: "demo",
    },
    {
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            {
              error: "插件尚未就绪",
              code: "PLUGIN_RUNTIME_NOT_READY",
              retryable: true,
            },
            { status: 404 },
          );
        }
        return Response.json({ url: runtimeUrl });
      },
    },
  );

  assert.equal(result, runtimeUrl);
  assert.equal(calls, 2);
  assert.equal(isRetryablePluginLaunchStatus(404), true);
  assert.equal(isRetryablePluginLaunchStatus(403), false);
});

test("same immutable GitHub source may refresh an installer-generated manifest", () => {
  const existingSource = packageInstallSourceFromDetailJson(
    JSON.stringify({
      source: {
        kind: "github",
        repository: "https://github.com/example/demo.git",
        commit: "ABC123",
        archiveSha256: "DEF456",
      },
    }),
  );

  assert.equal(
    canRefreshGeneratedGithubManifest({
      existingSource,
      incomingSource: {
        kind: "github",
        repository: "https://github.com/example/demo/",
        commit: "abc123",
        archiveSha256: "def456",
        generatedManifest: true,
      },
    }),
    true,
  );
});

test("same immutable archive may refresh an installer-generated manifest", () => {
  assert.equal(
    canRefreshGeneratedSourceManifest({
      existingSource: {
        kind: "archive",
        archiveSha256: "ABC123",
      },
      incomingSource: {
        kind: "archive",
        archiveSha256: "abc123",
        generatedManifest: true,
      },
    }),
    true,
  );
  assert.equal(
    canRefreshGeneratedSourceManifest({
      existingSource: {
        kind: "archive",
        archiveSha256: "abc123",
      },
      incomingSource: {
        kind: "archive",
        archiveSha256: "different",
        generatedManifest: true,
      },
    }),
    false,
  );
});

test("version integrity protection remains active for different or manual sources", () => {
  const existingSource = {
    kind: "github",
    repository: "https://github.com/example/demo",
    commit: "abc123",
    archiveSha256: "def456",
  };

  assert.equal(
    canRefreshGeneratedGithubManifest({
      existingSource,
      incomingSource: {
        ...existingSource,
        commit: "another-commit",
        generatedManifest: true,
      },
    }),
    false,
  );
  assert.equal(
    canRefreshGeneratedGithubManifest({
      existingSource,
      incomingSource: {
        kind: "archive",
        generatedManifest: true,
      },
    }),
    false,
  );
  assert.equal(
    canRefreshGeneratedGithubManifest({
      existingSource,
      incomingSource: existingSource,
    }),
    false,
  );
});
