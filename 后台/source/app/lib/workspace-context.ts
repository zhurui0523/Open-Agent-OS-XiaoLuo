import { requireWorkspaceAccess, type AccessLevel } from "./authorization";

function cleanWorkspaceId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 36) : "";
}

export function workspaceIdFromRequest(
  request: Request,
  body?: { workspaceId?: unknown },
) {
  const url = new URL(request.url);
  return (
    cleanWorkspaceId(body?.workspaceId) ||
    cleanWorkspaceId(request.headers.get("x-workspace-id")) ||
    cleanWorkspaceId(url.searchParams.get("workspaceId"))
  );
}

export async function requireRequestedWorkspace(
  request: Request,
  userId: string,
  required: AccessLevel,
  body?: { workspaceId?: unknown },
) {
  const workspaceId = workspaceIdFromRequest(request, body);
  if (!workspaceId) {
    throw new Response(JSON.stringify({ error: "缺少 workspaceId" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  await requireWorkspaceAccess(userId, workspaceId, required);
  return workspaceId;
}
