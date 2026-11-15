import { requireUser } from "./auth";
import { ensureUserHome } from "./workspace-store";

export async function requireWorkspaceContext(request: Request) {
  const user = await requireUser(request);
  const home = await ensureUserHome(user.id, user.displayName);
  return { user, home };
}
