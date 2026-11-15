import type { PoolConnection, RowDataPacket } from "mysql2/promise";

interface AdminCountRow extends RowDataPacket {
  total: number;
}

interface PersonalWorkspaceRow extends RowDataPacket {
  id: string;
}

// 企业成员共享企业管理员的空间，不存在自己的个人空间。
// 成员被移出/退出企业（转为普通用户）时，清除其在企业期间产生的全部内容，
// 并移除其名下可能残留的个人工作区；随后由调用方为其重建一个全新的空个人空间，
// 因此转为普通用户后不再保留原企业工作时的任何素材资产。
export async function purgeEnterpriseMemberContent(
  connection: PoolConnection,
  organizationId: string,
  enterpriseWorkspaceId: string | null,
  userId: string,
) {
  // 安全兜底：仍在任的企业管理员绝不允许被清理
  const [admins] = await connection.execute<AdminCountRow[]>(
    `SELECT COUNT(*) AS total
       FROM xiaoluo_v2_organization_members
       WHERE organization_id = ?
         AND user_id = ?
         AND role = 'admin'
         AND status = 'active'`,
    [organizationId, userId],
  );
  if (Number(admins[0]?.total ?? 0) > 0) return;

  if (enterpriseWorkspaceId) {
    // 该成员在企业工作区内创建的画布（节点、连线、评论、快照、分享记录、
    // 企业分享、对话器等均随画布级联删除）
    await connection.execute(
      `DELETE FROM xiaoluo_v2_canvases
       WHERE created_by = ?
         AND project_id IN (
           SELECT id FROM xiaoluo_v2_projects WHERE workspace_id = ?
         )`,
      [userId, enterpriseWorkspaceId],
    );
    // 该成员在企业工作区内创建的项目（画布随项目级联删除）
    await connection.execute(
      `DELETE FROM xiaoluo_v2_projects
       WHERE workspace_id = ? AND created_by = ?`,
      [enterpriseWorkspaceId, userId],
    );
    // 该成员发起的对话器（消息与计划随对话器级联删除）
    await connection.execute(
      `DELETE FROM xiaoluo_v2_intent_conversations
       WHERE workspace_id = ? AND created_by = ?`,
      [enterpriseWorkspaceId, userId],
    );
    // 该成员发起的生成任务
    await connection.execute(
      `DELETE FROM xiaoluo_v2_generation_jobs
       WHERE workspace_id = ? AND requested_by = ?`,
      [enterpriseWorkspaceId, userId],
    );
    // 该成员留在企业工作区其余画布上的评论、协作事件与在线痕迹
    await connection.execute(
      `DELETE FROM xiaoluo_v2_canvas_comments
       WHERE workspace_id = ? AND author_user_id = ?`,
      [enterpriseWorkspaceId, userId],
    );
    await connection.execute(
      `DELETE FROM xiaoluo_v2_canvas_collaboration_events
       WHERE workspace_id = ? AND actor_user_id = ?`,
      [enterpriseWorkspaceId, userId],
    );
    await connection.execute(
      `DELETE FROM xiaoluo_v2_canvas_presence
       WHERE workspace_id = ? AND user_id = ?`,
      [enterpriseWorkspaceId, userId],
    );
  }

  // 成员名下的个人工作区整体移除（企业工作区因归属组织而被排除）
  await removePersonalWorkspaces(connection, userId);
}

// 删除用户名下的全部个人工作区；工作区内的项目、画布、素材资产与版本、
// 生成任务、对话器等均随工作区级联删除。
export async function removePersonalWorkspaces(
  connection: PoolConnection,
  userId: string,
) {
  const [workspaces] = await connection.execute<PersonalWorkspaceRow[]>(
    `SELECT w.id
       FROM xiaoluo_v2_workspaces w
       WHERE w.owner_id = ?
         AND w.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM xiaoluo_v2_organizations o
           WHERE o.workspace_id = w.id
         )
       FOR UPDATE`,
    [userId],
  );
  if (!workspaces.length) return;
  const ids = workspaces.map((workspace) => workspace.id);
  const placeholders = ids.map(() => "?").join(", ");
  await connection.execute(
    `DELETE FROM xiaoluo_v2_resource_permissions WHERE user_id = ?`,
    [userId],
  );
  await connection.execute(
    `DELETE FROM xiaoluo_v2_workspace_members WHERE workspace_id IN (${placeholders})`,
    ids,
  );
  await connection.execute(
    `DELETE FROM xiaoluo_v2_workspaces WHERE id IN (${placeholders})`,
    ids,
  );
}
