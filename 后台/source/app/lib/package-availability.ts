import { sql } from "drizzle-orm";
import { packages } from "../../db/schema";

/**
 * Personal extensions belong to the account that installed them, not to the
 * incidental personal workspace that happened to be active at install time.
 * This also keeps older installs visible after historical duplicate personal
 * workspaces are repaired. Marketplace extensions still require an explicit
 * availability row for the current user/workspace.
 */
export function packageAvailableToUser(
  workspaceId: string,
  userId: string,
) {
  return sql<boolean>`(
    ${packages.workspaceId} = ${workspaceId}
    OR ${packages.createdBy} = ${userId}
    OR EXISTS (
      SELECT 1
      FROM xiaoluo_v2_package_availabilities available_package
      WHERE available_package.package_id = ${packages.id}
        AND available_package.workspace_id = ${workspaceId}
        AND available_package.user_id = ${userId}
    )
  )`;
}
