import type { RowDataPacket } from "mysql2/promise";
import { mysqlRows } from "./mysql";

interface WorkspaceIdRow extends RowDataPacket {
  workspaceId: string;
}

// 用户可使用“企业共享”模型连接的工作区集合：
// 当前工作区 + 所属企业的企业工作区 + 企业同事名义的工作区
// （企业共享模型保存在创建者的工作区中，仅 workspace 作用域会对同企业成员可见）。
export async function sharedModelWorkspaceIds(
  primaryWorkspaceId: string,
  userId: string,
): Promise<string[]> {
  const ids = new Set<string>(
    primaryWorkspaceId ? [primaryWorkspaceId] : [],
  );
  if (!userId) return [...ids];
  const rows = await mysqlRows<WorkspaceIdRow>(
    `SELECT DISTINCT w.id AS workspaceId
     FROM xiaoluo_v2_organization_members me
     INNER JOIN xiaoluo_v2_organizations org
       ON org.id = me.organization_id
      AND org.status = 'active'
     INNER JOIN xiaoluo_v2_organization_members peer
       ON peer.organization_id = org.id
      AND peer.status = 'active'
     INNER JOIN xiaoluo_v2_workspaces w
       ON w.status = 'active'
      AND (w.id = org.workspace_id OR w.owner_id = peer.user_id)
     WHERE me.user_id = ?
       AND me.status = 'active'`,
    [userId],
  );
  for (const row of rows) ids.add(row.workspaceId);
  return [...ids];
}
