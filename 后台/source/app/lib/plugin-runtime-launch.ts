import { createHmac, timingSafeEqual } from "node:crypto";

export const PLUGIN_STATIC_RUNTIME_PREFIX =
  "/api/v2/packages/runtime/static/";

/**
 * Runtime entries are persisted with a path that belongs to XiaoLuo itself.
 * Older canvas nodes may still contain an absolute localhost URL, while the
 * same service is now opened through a LAN address. Normalize those entries
 * to the origin of the current request and authorize the workspace encoded in
 * the path instead of binding a package to the hostname used at install time.
 */
export function normalizeInternalPluginRuntimeUrl(
  runtimeUrl: string,
  requestUrl: string,
) {
  const requestOrigin = new URL(requestUrl).origin;
  const target = new URL(runtimeUrl, requestOrigin);
  if (!target.pathname.startsWith(PLUGIN_STATIC_RUNTIME_PREFIX)) return null;
  return new URL(`${target.pathname}${target.search}`, requestOrigin);
}

interface PluginRuntimeCandidateIdentity {
  id: string;
  packageKey: string;
  name: string;
  version: string;
}

interface RequestedPluginRuntimeIdentity {
  packageId?: string;
  packageKey?: string;
  packageName?: string;
  savedPackageKey: string;
  savedVersion: string;
}

/**
 * Rank an installed plugin against the identity saved in a canvas node.
 * Name matching is intentionally supported because older generic ZIP imports
 * used a source.upload.* package key while a later GitHub installation uses a
 * stable github.* key for the same plugin.
 */
export function scorePluginRuntimeCandidate(
  candidate: PluginRuntimeCandidateIdentity,
  requested: RequestedPluginRuntimeIdentity,
) {
  let score = 0;
  if (requested.packageId && candidate.id === requested.packageId) {
    score += 1_000;
  }
  if (
    candidate.packageKey === requested.savedPackageKey ||
    (requested.packageKey && candidate.packageKey === requested.packageKey)
  ) {
    score += 500;
  }
  if (
    requested.packageName &&
    candidate.name.trim().toLocaleLowerCase() ===
      requested.packageName.trim().toLocaleLowerCase()
  ) {
    score += 250;
  }
  if (score === 0) return 0;
  if (candidate.version === requested.savedVersion) score += 20;
  return score;
}

export interface PluginRuntimeGrant {
  v: 1;
  workspaceId: string;
  packageKey: string;
  version: string;
  archiveSha: string;
  root: string;
  exp: number;
}

// The token only grants read access to one immutable plugin artifact. Keep it
// valid for a normal editing session so lazy-loaded chunks do not fail midway;
// the host still renews it automatically when a session is restored later.
export const PLUGIN_RUNTIME_GRANT_TTL_SECONDS = 12 * 60 * 60;

function runtimeSecret() {
  const configured =
    process.env.PLUGIN_RUNTIME_TOKEN_SECRET?.trim() ||
    process.env.ACCESS_TOKEN_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error("Missing PLUGIN_RUNTIME_TOKEN_SECRET");
  }

  const developmentFallback = process.env.DB_PASSWORD?.trim();
  if (!developmentFallback) {
    throw new Error("Missing plugin runtime signing secret");
  }
  return `xiaoluo-plugin-runtime:${developmentFallback}`;
}

function sign(encodedPayload: string) {
  return createHmac("sha256", runtimeSecret())
    .update(encodedPayload)
    .digest("base64url");
}

export function createPluginRuntimeGrant(
  input: Omit<PluginRuntimeGrant, "v" | "exp">,
) {
  const payload: PluginRuntimeGrant = {
    v: 1,
    ...input,
    exp: Math.floor(Date.now() / 1000) + PLUGIN_RUNTIME_GRANT_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyPluginRuntimeGrant(
  token: string,
  expected: Omit<PluginRuntimeGrant, "v" | "exp">,
) {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) {
    throw new Error("Invalid plugin runtime grant");
  }

  const actual = Buffer.from(encodedSignature, "base64url");
  const wanted = Buffer.from(sign(encodedPayload), "base64url");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new Error("Invalid plugin runtime grant");
  }

  let payload: PluginRuntimeGrant;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as PluginRuntimeGrant;
  } catch {
    throw new Error("Invalid plugin runtime grant");
  }

  if (
    payload.v !== 1 ||
    !Number.isFinite(payload.exp) ||
    payload.exp < Math.floor(Date.now() / 1000) ||
    payload.workspaceId !== expected.workspaceId ||
    payload.packageKey !== expected.packageKey ||
    payload.version !== expected.version ||
    payload.archiveSha !== expected.archiveSha ||
    payload.root !== expected.root
  ) {
    throw new Error("Plugin runtime grant expired or does not match");
  }

  return payload;
}
