import { createHmac, timingSafeEqual } from "node:crypto";

export interface PluginRuntimeGrant {
  v: 1;
  workspaceId: string;
  packageKey: string;
  version: string;
  archiveSha: string;
  root: string;
  exp: number;
}

const PLUGIN_RUNTIME_GRANT_TTL_SECONDS = 5 * 60;

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
