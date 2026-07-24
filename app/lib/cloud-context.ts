import { requireUser } from "./auth";
import { ensureUserHome } from "./workspace-store";
import { workspaceIdFromRequest } from "./workspace-context";

export async function requireWorkspaceContext(request: Request) {
  const user = await requireUser(request);
  const home = await ensureUserHome(
    user.id,
    user.displayName,
    workspaceIdFromRequest(request),
  );
  return { user, home };
}
