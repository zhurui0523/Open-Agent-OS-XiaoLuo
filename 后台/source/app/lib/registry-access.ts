export type RegistryAccessScope = "personal" | "workspace" | "marketplace";

export const MODEL_ACCESS_SCOPE_KEY = "x-xiaoluo-access-scope";

export function normalizeRegistryAccessScope(
  value: unknown,
  fallback: RegistryAccessScope = "personal",
): RegistryAccessScope {
  return value === "workspace" || value === "marketplace" || value === "personal"
    ? value
    : fallback;
}

export function modelAccessScope(uiSchema: unknown): RegistryAccessScope {
  if (!uiSchema || typeof uiSchema !== "object" || Array.isArray(uiSchema)) {
    return "workspace";
  }
  return normalizeRegistryAccessScope(
    (uiSchema as Record<string, unknown>)[MODEL_ACCESS_SCOPE_KEY],
    "workspace",
  );
}

export function packageAccessScope(manifest: unknown): RegistryAccessScope {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return "workspace";
  }
  const access = (manifest as Record<string, unknown>).access;
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    return "workspace";
  }
  return normalizeRegistryAccessScope(
    (access as Record<string, unknown>).scope,
    "workspace",
  );
}

export function canAccessRegistryResource(input: {
  scope: RegistryAccessScope;
  createdBy: string;
  userId: string;
  platformRole?: "system_admin" | "user";
}) {
  return (
    input.platformRole === "system_admin" ||
    input.scope !== "personal" ||
    input.createdBy === input.userId
  );
}

export function canManageRegistryResource(input: {
  scope: RegistryAccessScope;
  createdBy: string;
  userId?: string;
  platformRole?: "system_admin" | "user";
  canManageWorkspace?: boolean;
}) {
  return (
    input.platformRole === "system_admin" ||
    input.createdBy === input.userId ||
    (input.scope !== "personal" && Boolean(input.canManageWorkspace))
  );
}
