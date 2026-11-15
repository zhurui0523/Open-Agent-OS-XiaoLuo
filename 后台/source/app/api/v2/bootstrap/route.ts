import { jsonError, requireUser } from "../../../lib/auth";
import { requireCanvasAccess } from "../../../lib/authorization";
import {
  ensureUserHome,
  listProjects,
  listUserCanvases,
  readCanvasGraph,
} from "../../../lib/workspace-store";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const home = await ensureUserHome(user.id, user.displayName);
    await requireCanvasAccess(user.id, home.canvasId, "view");
    const [canvases, graph, projects] = await Promise.all([
      listUserCanvases(user.id, "active"),
      readCanvasGraph(home.canvasId),
      listProjects(home.workspaceId),
    ]);
    return Response.json({
      user,
      dataScopeId: home.workspaceId,
      project: { id: home.projectId, name: home.projectName },
      projects,
      canvases,
      activeCanvas: graph,
    });
  } catch (error) {
    return jsonError(error, "加载画布失败");
  }
}
