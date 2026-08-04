import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  inspectPackageArchive,
  PackageArchiveError,
} from "../app/lib/package-archive.ts";
import {
  needsDefaultSandboxPanel,
  withDefaultSandboxPanel,
} from "../app/lib/package-manifest-adapter.ts";
import { parsePackagePayload } from "../app/lib/package-contract.ts";
import {
  canRefreshGeneratedGithubManifest,
  packageInstallSourceFromDetailJson,
} from "../app/lib/package-version-policy.ts";
import { resolveAdvertisedGithubCommit } from "../app/lib/github-smart-http.ts";

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
