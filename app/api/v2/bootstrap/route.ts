import { jsonError, requireUser } from "../../../lib/auth";
import { requireCanvasAccess } from "../../../lib/authorization";
import {
  ensureUserHome,
  listCanvases,
  listProjects,
  listUserWorkspaces,
  readCanvasGraph,
} from "../../../lib/workspace-store";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const preferredWorkspaceId =
      new URL(request.url).searchParams.get("workspaceId") ?? "";
    const home = await ensureUserHome(
      user.id,
      user.displayName,
      preferredWorkspaceId,
    );
    await requireCanvasAccess(user.id, home.canvasId, "view");
    const [canvases, graph, workspaces, projects] = await Promise.all([
      listCanvases(home.projectId),
      readCanvasGraph(home.canvasId),
      listUserWorkspaces(user.id),
      listProjects(home.workspaceId),
    ]);
    return Response.json({
      user,
      workspace: { id: home.workspaceId, name: home.workspaceName },
      workspaces,
      project: { id: home.projectId, name: home.projectName },
      projects,
      canvases,
      activeCanvas: graph,
    });
  } catch (error) {
    return jsonError(error, "加载工作空间失败");
  }
}
