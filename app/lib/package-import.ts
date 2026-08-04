import { getFileBucket } from "./asset-kernel";
import type {
  PackageArchiveInspection,
  SourceArchiveInspection,
} from "./package-archive";
import type { XiaoLuoPackageManifest } from "./package-contract";
import { serverRuntimeConfig } from "./server-runtime-config";
import { resolveAdvertisedGithubCommit } from "./github-smart-http";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_DOWNLOAD_TIMEOUT_MS = 120_000;
const GITHUB_REQUEST_ATTEMPTS = 3;
const GITHUB_REFS_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_GITHUB_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export class GithubImportNetworkError extends Error {
  readonly code = "GITHUB_NETWORK_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GithubImportNetworkError";
  }
}

export interface GithubRepositoryReference {
  owner: string;
  repository: string;
  ref?: string;
  canonicalUrl: string;
}

export interface GithubDownload {
  bytes: Uint8Array;
  commit: string;
  repositoryUrl: string;
  sourceUrl: string;
  sourceKind: "release" | "repository";
  fileName: string;
}

export interface GithubCompatibilityReport {
  repository: string;
  commit: string;
  detectedStack: string[];
  packageName: string | null;
  scripts: string[];
  hasServer: boolean;
  hasBuildOutput: boolean;
  issues: string[];
  requiredFiles: string[];
}

export interface GeneratedGithubManifest {
  manifest: XiaoLuoPackageManifest;
  compatibility: GithubCompatibilityReport;
  executionReady: boolean;
  staticRoot: string | null;
}

function safeSegment(value: string, label: string) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    throw new Error(`${label} 格式无效`);
  }
  return value;
}

function githubHeaders(accept = "application/vnd.github+json") {
  const headers = new Headers({
    accept,
    "user-agent": "XiaoLuo-Intent-OS/2.0",
    "x-github-api-version": "2022-11-28",
  });
  const token = process.env.GITHUB_IMPORT_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const cause =
    "cause" in error && error.cause && typeof error.cause === "object"
      ? error.cause
      : error;
  return "code" in cause && typeof cause.code === "string" ? cause.code : "";
}

function githubNetworkReason(error: unknown) {
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return "当前服务进程被系统、防火墙或运行权限禁止访问外网";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "GitHub 域名解析失败，请检查 DNS";
  }
  if (code === "ECONNREFUSED") {
    return "连接被拒绝，请检查本机代理或防火墙";
  }
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return "连接超时，请检查网络或代理";
  }
  if (
    code.startsWith("CERT_") ||
    code.includes("CERTIFICATE") ||
    code === "SELF_SIGNED_CERT_IN_CHAIN"
  ) {
    return "TLS 证书校验失败，请检查系统证书或 HTTPS 代理";
  }
  return code ? `网络请求失败（${code}）` : "网络请求失败";
}

function isRetryableGithubError(error: unknown) {
  const code = errorCode(error);
  return (
    new Set([
      "EAI_AGAIN",
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ]).has(code) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

async function withGithubRetries<T>(
  input: string | URL,
  phase: string,
  operation: (url: URL) => Promise<T>,
): Promise<T> {
  const url = new URL(input);
  let lastError: unknown;
  for (let attempt = 0; attempt < GITHUB_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await operation(url);
    } catch (error) {
      lastError = error;
      const looksLikeNetworkFailure =
        isRetryableGithubError(error) || error instanceof TypeError;
      if (!looksLikeNetworkFailure) throw error;
      if (attempt >= GITHUB_REQUEST_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw new GithubImportNetworkError(
    `${phase}失败：无法连接 ${url.hostname}，${githubNetworkReason(lastError)}。请确认本地服务拥有外网权限后重试。`,
    lastError instanceof Error ? { cause: lastError } : undefined,
  );
}

async function githubFetch(
  input: string | URL,
  init: Omit<RequestInit, "signal">,
  phase: string,
  timeoutMs: number,
) {
  return withGithubRetries(input, phase, (url) =>
    fetch(url, {
      ...init,
      // Every retry needs a fresh signal. Reusing an already-aborted signal
      // makes all following attempts fail immediately.
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

async function responseBytes(
  response: Response,
  limit = MAX_DOWNLOAD_BYTES,
  tooLargeMessage = "GitHub 插件包不能超过 50 MB",
) {
  if (!response.ok) {
    throw new Error(`下载失败（${response.status}）`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    throw new Error(tooLargeMessage);
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(tooLargeMessage);
    }
    chunks.push(part.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function githubJson<T>(path: string, optional = false): Promise<T | null> {
  const response = await githubFetch(`${GITHUB_API_ORIGIN}${path}`, {
    headers: githubHeaders(),
    cache: "no-store",
    redirect: "error",
  }, "读取 GitHub 仓库信息", GITHUB_API_TIMEOUT_MS);
  if (optional && response.status === 404) return null;
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error(
      "GitHub API 访问频率已用完；可在服务端配置 GITHUB_IMPORT_TOKEN 后重试",
    );
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(
      payload.message
        ? `GitHub：${payload.message}`
        : `GitHub 请求失败（${response.status}）`,
    );
  }
  return (await response.json()) as T;
}

async function safeGithubDownload(
  input: string,
  headers = githubHeaders("application/octet-stream"),
) {
  let url = new URL(input);
  for (let redirect = 0; redirect < 6; redirect += 1) {
    if (
      url.protocol !== "https:" ||
      !SAFE_GITHUB_DOWNLOAD_HOSTS.has(url.hostname)
    ) {
      throw new Error("GitHub 下载地址跳转到了不受信任的主机");
    }
    const result = await withGithubRetries(url, "下载 GitHub 仓库", async (requestUrl) => {
      const response = await fetch(requestUrl, {
        headers,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_DOWNLOAD_TIMEOUT_MS),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        return {
          kind: "redirect" as const,
          location: response.headers.get("location"),
        };
      }
      // Consume the response inside the retry boundary. Download timeouts can
      // happen after the headers have arrived while the body is still streaming.
      return {
        kind: "complete" as const,
        bytes: await responseBytes(response),
      };
    });
    if (result.kind === "redirect") {
      const location = result.location;
      if (!location) throw new Error("GitHub 下载跳转缺少 Location");
      url = new URL(location, url);
      continue;
    }
    return result.bytes;
  }
  throw new Error("GitHub 下载重定向次数过多");
}

export function parseGithubRepositoryUrl(
  value: string,
  requestedRef?: string,
): GithubRepositoryReference {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 GitHub 仓库地址");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("当前仅允许 https://github.com/owner/repository 仓库地址");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub 地址缺少仓库名称");
  }
  const owner = safeSegment(parts[0], "GitHub 所有者");
  const repository = safeSegment(
    parts[1].replace(/\.git$/i, ""),
    "GitHub 仓库名",
  );
  let ref = requestedRef?.trim() || "";
  if (!ref && parts[2] === "tree" && parts.length > 3) {
    ref = decodeURIComponent(parts.slice(3).join("/"));
  }
  if (ref && (!/^[A-Za-z0-9._/-]{1,240}$/.test(ref) || ref.includes(".."))) {
    throw new Error("GitHub 分支、标签或 Commit 格式无效");
  }
  return {
    owner,
    repository,
    ...(ref ? { ref } : {}),
    canonicalUrl: `https://github.com/${owner}/${repository}`,
  };
}

async function downloadGithubPackageViaApi(
  reference: GithubRepositoryReference,
): Promise<GithubDownload> {
  const repositoryPath = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
  const repository = await githubJson<{
    default_branch?: string;
    private?: boolean;
  }>(repositoryPath);
  if (!repository) throw new Error("GitHub 仓库不存在");
  const requestedRef = reference.ref || repository.default_branch || "HEAD";

  const release = reference.ref
    ? await githubJson<{
        tag_name: string;
        assets?: Array<{
          id: number;
          name: string;
          size: number;
          url: string;
        }>;
      }>(
        `${repositoryPath}/releases/tags/${encodeURIComponent(reference.ref)}`,
        true,
      )
    : await githubJson<{
        tag_name: string;
        assets?: Array<{
          id: number;
          name: string;
          size: number;
          url: string;
        }>;
      }>(`${repositoryPath}/releases/latest`, true);
  const releaseAsset = release?.assets?.find((asset) =>
    /\.xlpkg$/i.test(asset.name),
  );
  const commitRef = releaseAsset ? release!.tag_name : requestedRef;
  const commit = await githubJson<{ sha?: string }>(
    `${repositoryPath}/commits/${encodeURIComponent(commitRef)}`,
  );
  const commitSha = commit?.sha?.trim();
  if (!commitSha || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new Error("GitHub 没有返回有效的 Commit SHA");
  }

  if (releaseAsset) {
    if (releaseAsset.size > MAX_DOWNLOAD_BYTES) {
      throw new Error("GitHub Release 中的 .xlpkg 不能超过 50 MB");
    }
    return {
      bytes: await safeGithubDownload(releaseAsset.url),
      commit: commitSha.toLowerCase(),
      repositoryUrl: reference.canonicalUrl,
      sourceUrl: `${reference.canonicalUrl}/releases/tag/${encodeURIComponent(release!.tag_name)}`,
      sourceKind: "release",
      fileName: releaseAsset.name,
    };
  }

  const sourceUrl = `https://codeload.github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/zip/${commitSha}`;
  return {
    bytes: await safeGithubDownload(sourceUrl, githubHeaders("application/zip")),
    commit: commitSha.toLowerCase(),
    repositoryUrl: reference.canonicalUrl,
    sourceUrl,
    sourceKind: "repository",
    fileName: `${reference.repository}-${commitSha.slice(0, 12)}.zip`,
  };
}

async function downloadGithubPackageViaGit(
  reference: GithubRepositoryReference,
): Promise<GithubDownload> {
  const refsUrl = `https://github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}.git/info/refs?service=git-upload-pack`;
  const response = await githubFetch(
    refsUrl,
    {
      headers: githubHeaders("application/x-git-upload-pack-advertisement"),
      cache: "no-store",
      redirect: "error",
    },
    "读取 GitHub 仓库引用",
    GITHUB_API_TIMEOUT_MS,
  );
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("GitHub 仓库不存在，或者当前凭据没有访问权限");
    }
    throw new Error(`GitHub 仓库引用请求失败（${response.status}）`);
  }
  const advertisement = new TextDecoder("utf-8", { fatal: true }).decode(
    await responseBytes(
      response,
      GITHUB_REFS_MAX_BYTES,
      "GitHub 仓库引用信息过大，无法安全导入",
    ),
  );
  const commitSha = resolveAdvertisedGithubCommit(
    advertisement,
    reference.ref,
  );
  const sourceUrl = `https://codeload.github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}/zip/${commitSha}`;
  return {
    bytes: await safeGithubDownload(
      sourceUrl,
      githubHeaders("application/zip"),
    ),
    commit: commitSha,
    repositoryUrl: reference.canonicalUrl,
    sourceUrl,
    sourceKind: "repository",
    fileName: `${reference.repository}-${commitSha.slice(0, 12)}.zip`,
  };
}

export async function downloadGithubPackage(
  reference: GithubRepositoryReference,
): Promise<GithubDownload> {
  try {
    return await downloadGithubPackageViaApi(reference);
  } catch (error) {
    // api.github.com is convenient for Release discovery, but it must not be
    // a single point of failure for public repositories. Git smart HTTP gives
    // us an immutable commit without the API, after which codeload serves ZIP.
    if (!(error instanceof GithubImportNetworkError)) throw error;
    try {
      return await downloadGithubPackageViaGit(reference);
    } catch (fallbackError) {
      if (fallbackError instanceof GithubImportNetworkError) {
        throw new GithubImportNetworkError(
          `${error.message}；GitHub 备用下载通道也不可用。`,
          { cause: fallbackError },
        );
      }
      throw fallbackError;
    }
  }
}

function jsonFilePath(
  inspection: SourceArchiveInspection,
  relativePath: string,
) {
  return inspection.files.find(
    (file) => file.relativePath.toLowerCase() === relativePath.toLowerCase(),
  )?.path;
}

export async function analyzeGithubCompatibility(
  inspection: SourceArchiveInspection,
  input: {
    repository: string;
    commit: string;
  },
): Promise<GithubCompatibilityReport> {
  const packageJsonPath = jsonFilePath(inspection, "package.json");
  let packageJson: Record<string, unknown> = {};
  if (packageJsonPath) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await inspection.readFile(packageJsonPath),
      );
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        packageJson = parsed as Record<string, unknown>;
      }
    } catch {
      packageJson = {};
    }
  }
  const dependencies = {
    ...(typeof packageJson.dependencies === "object" &&
    packageJson.dependencies !== null
      ? packageJson.dependencies
      : {}),
    ...(typeof packageJson.devDependencies === "object" &&
    packageJson.devDependencies !== null
      ? packageJson.devDependencies
      : {}),
  } as Record<string, unknown>;
  const scripts =
    typeof packageJson.scripts === "object" && packageJson.scripts !== null
      ? Object.keys(packageJson.scripts as Record<string, unknown>)
      : [];
  const stack = [
    "react",
    "vite",
    "next",
    "express",
    "three",
    "vue",
    "svelte",
  ].filter((name) => name in dependencies);
  const fileNames = new Set(
    inspection.files.map((file) => file.relativePath.toLowerCase()),
  );
  const hasServer =
    "express" in dependencies ||
    [...fileNames].some((name) =>
      /(^|\/)(server|api)\.(js|mjs|cjs|ts)$/.test(name),
    );
  const hasBuildOutput = [...fileNames].some((name) =>
    /^(dist|build|out)\//.test(name),
  );
  return {
    repository: input.repository,
    commit: input.commit,
    detectedStack: stack,
    packageName:
      typeof packageJson.name === "string" ? packageJson.name : null,
    scripts,
    hasServer,
    hasBuildOutput,
    issues: [
      "仓库中没有 xiaoluo.plugin.json，当前不能确定运行时、权限和节点 Schema",
      ...(hasServer
        ? ["检测到服务端代码；XiaoLuo 不会在主服务进程中直接执行第三方服务器"]
        : []),
      ...(!hasBuildOutput && scripts.includes("build")
        ? ["仓库需要构建，但安全策略禁止在安装请求中直接运行第三方构建脚本"]
        : []),
    ],
    requiredFiles: [
      "xiaoluo.plugin.json",
      "checksums.json（推荐）",
      "xiaoluo.signature.json（公开发布或隔离 Worker 必需）",
    ],
  };
}

function packageNamespacePart(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return (normalized || "repository").slice(0, 60);
}

async function staticRootOf(inspection: SourceArchiveInspection) {
  const files = new Set(
    inspection.files.map((file) => file.relativePath.toLowerCase()),
  );
  for (const root of ["dist", "build", "out", "public"]) {
    if (files.has(`${root}/index.html`)) return root;
  }
  if (!files.has("index.html")) return null;
  const indexPath = jsonFilePath(inspection, "index.html");
  if (!indexPath) return null;
  const html = new TextDecoder("utf-8", { fatal: true }).decode(
    await inspection.readFile(indexPath),
  );
  // A Vite/React source entry is not browser-ready. Treating it as a static
  // package produces a successfully loaded but completely blank iframe.
  if (
    /(?:src|href)\s*=\s*["'][^"']*(?:\/?src\/|\.(?:tsx?|jsx?)(?:[?#]|["']))/i.test(
      html,
    )
  ) {
    return null;
  }
  return "";
}

export async function generateGithubPackageManifest(input: {
  inspection: SourceArchiveInspection;
  owner: string;
  repository: string;
  repositoryUrl: string;
  commit: string;
  runtimeOrigin: string;
  workspaceId: string;
}): Promise<GeneratedGithubManifest> {
  const compatibility = await analyzeGithubCompatibility(input.inspection, {
    repository: input.repositoryUrl,
    commit: input.commit,
  });
  const packageId = `github.${packageNamespacePart(input.owner)}.${packageNamespacePart(input.repository)}`;
  const staticRoot = await staticRootOf(input.inspection);
  const version = `0.0.0-git.${input.commit.slice(0, 12).toLowerCase()}`;
  const staticRuntimeUrl =
    staticRoot !== null
      ? `${input.runtimeOrigin}/api/v2/packages/runtime/static/${encodeURIComponent(input.workspaceId)}/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/${input.inspection.archiveSha256}/${staticRoot || "_root"}/`
      : null;
  const name = compatibility.packageName || input.repository;
  return {
    compatibility,
    executionReady: Boolean(staticRuntimeUrl),
    staticRoot,
    manifest: {
      schemaVersion: "2.0",
      id: packageId,
      name,
      version,
      description: staticRuntimeUrl
        ? `从 ${input.repositoryUrl} 自动适配的静态沙盒插件，固定 Commit ${input.commit.slice(0, 12)}。`
        : `从 ${input.repositoryUrl} 导入的源码插件，固定 Commit ${input.commit.slice(0, 12)}；等待隔离构建后启用。`,
      type: "plugin",
      access: { scope: "personal" },
      runtime: staticRuntimeUrl
        ? { type: "sandbox-ui", entry: staticRuntimeUrl }
        : { type: "declarative" },
      permissions: staticRuntimeUrl ? ["assets:read"] : [],
      contributes: staticRuntimeUrl
        ? {
            panels: [
              {
                id: `${packageId}.panel`,
                title: name,
              },
            ],
          }
        : {},
    },
  };
}

export function packageArtifactKey(input: {
  workspaceId: string;
  packageKey: string;
  version: string;
  archiveSha256: string;
}) {
  return [
    "package-artifacts",
    safeSegment(input.workspaceId, "workspaceId"),
    safeSegment(input.packageKey, "Package ID"),
    safeSegment(input.version, "Package 版本"),
    `${safeSegment(input.archiveSha256, "Package 摘要")}.xlpkg`,
  ].join("/");
}

export async function storePackageArtifact(input: {
  key: string;
  bytes: Uint8Array;
  sourceKind: "archive" | "github";
  repository?: string;
  commit?: string;
}) {
  const bucket = await getFileBucket();
  await bucket.put(input.key, input.bytes, {
    httpMetadata: { contentType: "application/vnd.xiaoluo.package+zip" },
    customMetadata: {
      source: input.sourceKind,
      ...(input.repository
        ? { repository: input.repository.slice(0, 240) }
        : {}),
      ...(input.commit ? { commit: input.commit.slice(0, 64) } : {}),
    },
  });
}

export async function deletePackageArtifact(key: string) {
  const bucket = await getFileBucket();
  await bucket.delete(key);
}

export async function buildGithubStaticPackage(input: {
  inspection: SourceArchiveInspection;
  archiveSha256: string;
}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const cacheRoot = path.resolve(
    process.cwd(),
    ".local-data",
    "prepared-static-packages",
    input.archiveSha256.toLowerCase(),
  );
  const readyMarker = path.join(cacheRoot, ".build-ready");
  try {
    await fs.access(path.join(cacheRoot, "index.html"));
    await fs.access(readyMarker);
    return { prepared: true, reason: "already-built" };
  } catch {
    // Continue with a fresh isolated build.
  }

  const packageJsonFile = input.inspection.files.find(
    (file) => file.relativePath.toLowerCase() === "package.json",
  );
  if (!packageJsonFile) {
    return { prepared: false, reason: "package.json-not-found" };
  }
  const packageJson = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await input.inspection.readFile(packageJsonFile.path),
    ),
  ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  if (!packageJson.scripts?.build) {
    return { prepared: false, reason: "build-script-not-found" };
  }
  if (!(packageJson.devDependencies?.vite || packageJson.dependencies?.vite)) {
    return { prepared: false, reason: "only-vite-static-builds-are-supported" };
  }

  const buildRoot = path.resolve(process.cwd(), ".local-data", "package-builds");
  await fs.mkdir(buildRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(buildRoot, ".github-build-"));
  const run = async (args: string[], timeoutMs: number) => {
    const packageManager = process.env.npm_execpath?.trim();
    const packageManagerIsScript = Boolean(
      packageManager && /\.(?:c?js|mjs)$/i.test(packageManager),
    );
    const command = packageManagerIsScript
      ? process.execPath
      : process.platform === "win32"
        ? process.env.ComSpec?.trim() || "cmd.exe"
        : "pnpm";
    const commandArgs = packageManagerIsScript
      ? [packageManager!, ...args]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm", ...args]
        : args;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        command,
        commandArgs,
        {
        cwd: stage,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          // The desktop server can be launched with a bundled Node runtime
          // that is not registered in the machine-wide PATH. pnpm and Vite
          // spawn `node` by name, so always expose the current executable's
          // directory to child processes.
          PATH: [path.dirname(process.execPath), process.env.PATH ?? ""]
            .filter(Boolean)
            .join(path.delimiter),
          SystemRoot: process.env.SystemRoot ?? "",
          ComSpec: process.env.ComSpec ?? "",
          USERPROFILE: process.env.USERPROFILE ?? "",
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
          APPDATA: process.env.APPDATA ?? "",
          PNPM_HOME: process.env.PNPM_HOME ?? "",
          TEMP: process.env.TEMP ?? stage,
          TMP: process.env.TMP ?? stage,
          CI: "1",
          NODE_ENV: "development",
          NPM_CONFIG_IGNORE_SCRIPTS: "true",
        },
        },
      );
      let output = "";
      const collect = (chunk: Buffer) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`插件构建超时\n${output}`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`插件构建命令失败（${code ?? "unknown"}）\n${output}`));
      });
    });
  };

  try {
    for (const file of input.inspection.files) {
      if (!file.relativePath || file.relativePath.startsWith("node_modules/")) continue;
      const target = path.resolve(stage, ...file.relativePath.split("/"));
      if (!target.startsWith(`${stage}${path.sep}`)) throw new Error("插件源码路径越界");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await input.inspection.readFile(file.path));
    }
    await run(["install", "--frozen-lockfile=false", "--ignore-scripts"], 180_000);

    // Some public Vite repositories import build plugins from vite.config.*
    // without declaring them in package.json (a common example is
    // `@tailwindcss/vite`). The application may still work in the author's
    // hoisted monorepo, but a clean isolated install cannot resolve them.
    // Install only the statically imported bare packages, with lifecycle
    // scripts disabled, so GitHub installs remain isolated and reproducible.
    const declaredBuildDependencies = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);
    const inferredBuildDependencies = new Set<string>();
    for (const configName of [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs",
      "vite.config.cts",
      "vite.config.cjs",
    ]) {
      try {
        const configSource = await fs.readFile(path.join(stage, configName), "utf8");
        for (const match of configSource.matchAll(
          /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g,
        )) {
          const specifier = match[1];
          if (
            !specifier ||
            specifier.startsWith(".") ||
            specifier.startsWith("/") ||
            specifier.startsWith("node:")
          ) continue;
          const packageName = specifier.startsWith("@")
            ? specifier.split("/").slice(0, 2).join("/")
            : specifier.split("/")[0];
          if (
            /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i.test(packageName) &&
            !declaredBuildDependencies.has(packageName)
          ) inferredBuildDependencies.add(packageName);
        }
      } catch {
        // This config variant does not exist.
      }
    }
    if (inferredBuildDependencies.size > 0) {
      await run(
        ["add", "--save-dev", "--ignore-scripts", ...inferredBuildDependencies],
        180_000,
      );
    }
    await run(["exec", "vite", "build", "--outDir", "dist"], 120_000);
    const outputRoot = path.join(stage, "dist");
    await fs.access(path.join(outputRoot, "index.html"));
    const cacheStage = `${cacheRoot}.stage-${crypto.randomUUID()}`;
    await fs.mkdir(path.dirname(cacheRoot), { recursive: true });
    await fs.cp(outputRoot, cacheStage, { recursive: true });
    await fs.writeFile(path.join(cacheStage, ".build-ready"), input.archiveSha256, "utf8");
    await fs.rm(cacheRoot, { recursive: true, force: true });
    await fs.rename(cacheStage, cacheRoot);
    return { prepared: true, reason: "vite-build-complete" };
  } catch (error) {
    return {
      prepared: false,
      reason: error instanceof Error ? error.message.slice(0, 12_000) : "插件自动构建失败",
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function prepareLocalIsolatedPackage(input: {
  inspection: PackageArchiveInspection;
  manifest: XiaoLuoPackageManifest;
  integritySha256: string;
}) {
  if (
    input.manifest.runtime.type !== "isolated-worker" ||
    serverRuntimeConfig().storage.driver !== "local"
  ) {
    return { prepared: false, reason: "not-local-isolated-runtime" };
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(
    process.cwd(),
    process.env.PACKAGE_ROOT?.trim() || ".local-data/isolated-packages",
  );
  const packageRoot = path.resolve(
    root,
    safeSegment(input.manifest.id, "Package ID"),
    safeSegment(input.manifest.version, "Package 版本"),
  );
  if (!packageRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("隔离 Package 目标目录无效");
  }
  const markerPath = path.join(packageRoot, ".integrity-sha256");
  try {
    const current = (await fs.readFile(markerPath, "utf8")).trim();
    if (current === input.integritySha256) {
      return { prepared: true, reason: "already-prepared" };
    }
    throw new Error("相同 Package 版本已存在不同内容，请提升版本号");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await fs.mkdir(root, { recursive: true });
  const stage = await fs.mkdtemp(path.join(root, ".xiaoluo-stage-"));
  try {
    for (const file of input.inspection.files) {
      const relative = file.relativePath;
      if (!relative) continue;
      const target = path.resolve(stage, ...relative.split("/"));
      if (!target.startsWith(`${stage}${path.sep}`)) {
        throw new Error("插件文件越过隔离 Package 目录");
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        await input.inspection.readFile(file.path),
      );
    }
    await fs.writeFile(
      path.join(stage, ".integrity-sha256"),
      input.integritySha256,
      "utf8",
    );
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.rename(stage, packageRoot);
    return { prepared: true, reason: "prepared" };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}
