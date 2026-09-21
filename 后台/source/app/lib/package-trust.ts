import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import type { XiaoLuoPackageManifest } from "./package-contract";

export interface PackageScanIssue {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface PackageScanResult {
  score: number;
  risk: "low" | "medium" | "high";
  issues: PackageScanIssue[];
  runtimeOrigin: string | null;
  scannedAt: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function canonicalPackageManifest(manifest: XiaoLuoPackageManifest) {
  return JSON.stringify(stableValue(manifest));
}

export function packageManifestSha256(manifestJson: string) {
  return createHash("sha256").update(manifestJson, "utf8").digest("hex");
}

export function publisherKeyFingerprint(publicKeyPem: string) {
  const key = createPublicKey(publicKeyPem);
  if (
    key.asymmetricKeyType !== "ec" ||
    (key.asymmetricKeyDetails?.namedCurve &&
      key.asymmetricKeyDetails.namedCurve !== "prime256v1")
  ) {
    throw new Error("Publisher key must use ECDSA P-256");
  }
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function verifyPackageSignature(input: {
  manifestJson: string;
  signature: string;
  publicKeyPem: string;
}) {
  try {
    const key = createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== "ec") return false;
    const details = key.asymmetricKeyDetails;
    if (details?.namedCurve && details.namedCurve !== "prime256v1") {
      return false;
    }
    const signature = Buffer.from(input.signature, "base64");
    if (!signature.length || signature.length > 256) return false;
    return verifySignature(
      "sha256",
      Buffer.from(input.manifestJson, "utf8"),
      key,
      signature,
    );
  } catch {
    return false;
  }
}

function originOf(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function normalizeRuntimeEntryForTrustScan(
  runtimeEntry: string | undefined,
  requestUrl: string,
) {
  if (!runtimeEntry) return runtimeEntry;
  try {
    const request = new URL(requestUrl);
    const runtime = new URL(runtimeEntry, request.origin);
    const sameService =
      runtime.origin === request.origin ||
      (isLoopbackHostname(runtime.hostname) &&
        isLoopbackHostname(request.hostname) &&
        runtime.port === request.port);
    if (
      sameService &&
      runtime.pathname.startsWith("/api/v2/packages/runtime/static/")
    ) {
      return runtime.pathname;
    }
  } catch {
    if (runtimeEntry.startsWith("/api/v2/packages/runtime/static/")) {
      return runtimeEntry;
    }
  }
  return runtimeEntry;
}

export function scanPackageManifest(
  manifest: XiaoLuoPackageManifest,
): PackageScanResult {
  const issues: PackageScanIssue[] = [];
  let score = 0;
  const runtimeOrigin = originOf(manifest.runtime.entry);
  const permissions = manifest.permissions ?? [];

  if (manifest.runtime.type === "sandbox-ui") {
    score += 3;
    issues.push({
      code: "sandbox-ui",
      severity: "warning",
      message: "Package 包含沙盒 UI，需要受限 iframe 与消息协议。",
    });
  }
  if (manifest.runtime.type === "remote-api") {
    score += 3;
    issues.push({
      code: "remote-runtime",
      severity: "warning",
      message: "Package 会调用远程运行时，必须限制到声明的 HTTPS Origin。",
    });
  }
  if (manifest.runtime.type === "isolated-worker") {
    score += 5;
    issues.push({
      code: "isolated-executable-runtime",
      severity: "warning",
      message: "Package 包含可执行运行时，只允许可信签名并进入隔离 Worker。",
    });
  }
  const writePermissions = permissions.filter((permission) =>
    permission.endsWith(":write"),
  );
  if (writePermissions.length) {
    score += Math.min(3, writePermissions.length);
    issues.push({
      code: "write-permissions",
      severity: "warning",
      message: `Package 请求写权限：${writePermissions.join("、")}`,
    });
  }
  const networkPermissions = permissions.filter((permission) =>
    permission.startsWith("network:"),
  );
  if (networkPermissions.length > 1) {
    score += 2;
    issues.push({
      code: "multiple-network-origins",
      severity: "warning",
      message: "Package 请求多个网络 Origin。",
    });
  }
  if (
    runtimeOrigin &&
    !permissions.includes(`network:${runtimeOrigin}`) &&
    manifest.runtime.type !== "declarative"
  ) {
    score += 8;
    issues.push({
      code: "undeclared-runtime-origin",
      severity: "critical",
      message: "运行时 Origin 未包含在精确网络权限中。",
    });
  }
  const contributionCount =
    (manifest.contributes?.skills?.length ?? 0) +
    (manifest.contributes?.agents?.length ?? 0) +
    (manifest.contributes?.workflows?.length ?? 0) +
    (manifest.contributes?.nodes?.length ?? 0) +
    (manifest.contributes?.panels?.length ?? 0) +
    (manifest.contributes?.modelProviders?.length ?? 0);
  if (contributionCount > 100) {
    score += 5;
    issues.push({
      code: "oversized-contribution-surface",
      severity: "critical",
      message: "单个 Package 贡献项超过 100 个，需要人工复核。",
    });
  }
  if (!issues.length) {
    issues.push({
      code: "declarative-low-risk",
      severity: "info",
      message: "仅包含声明式能力，未发现可执行代码或扩展网络权限。",
    });
  }

  return {
    score,
    risk: score >= 7 ? "high" : score >= 3 ? "medium" : "low",
    issues,
    runtimeOrigin,
    scannedAt: new Date().toISOString(),
  };
}
