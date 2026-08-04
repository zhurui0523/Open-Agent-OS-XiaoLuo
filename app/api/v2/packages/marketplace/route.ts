import type { RowDataPacket } from "mysql2/promise";
import { requireUser } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import type { MarketplacePackage } from "../../../../types";
import { packageAccessScope } from "../../../../lib/registry-access";

interface PackageRow extends RowDataPacket {
  id: string;
  packageKey: string;
  name: string;
  version: string;
  description: string;
  packageType: "skill" | "plugin";
  runtimeType: MarketplacePackage["runtimeType"];
  permissionsJson: string;
  manifestJson: string;
  createdBy: string;
  username: string;
  displayName: string;
  platformRole: "system_admin" | "user";
  updatedAt: string;
}

interface InstalledRow extends RowDataPacket {
  packageKey: string;
}

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseManifest(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const [rows, installedRows] = await Promise.all([
      mysqlRows<PackageRow>(
        `SELECT
           p.id,
           p.package_key AS packageKey,
           p.name,
           p.version,
           p.description,
           p.package_type AS packageType,
           p.runtime_type AS runtimeType,
           p.permissions_json AS permissionsJson,
           p.manifest_json AS manifestJson,
           p.created_by AS createdBy,
           u.username,
           u.display_name AS displayName,
           u.platform_role AS platformRole,
           p.updated_at AS updatedAt
         FROM xiaoluo_v2_packages p
         INNER JOIN xiaoluo_v2_users u ON u.id = p.created_by
         WHERE u.status = 'active'
           AND p.package_type IN ('skill', 'plugin')
           AND p.enabled = 1
           AND p.lifecycle_state = 'active'
           AND p.trust_state IN ('trusted', 'reviewed')
           AND JSON_UNQUOTE(JSON_EXTRACT(p.manifest_json, '$.access.scope')) = 'marketplace'
         ORDER BY p.updated_at DESC
         LIMIT 300`,
      ),
      mysqlRows<InstalledRow>(
        `SELECT package_key AS packageKey
         FROM xiaoluo_v2_packages
         WHERE workspace_id = ?
           AND lifecycle_state <> 'uninstalled'`,
        [workspaceId],
      ),
    ]);
    const installed = new Set(installedRows.map((row) => row.packageKey));
    const seen = new Set<string>();
    const packages: MarketplacePackage[] = [];
    for (const row of rows) {
      if (seen.has(row.packageKey)) continue;
      seen.add(row.packageKey);
      const manifest = parseManifest(row.manifestJson);
      if (!manifest) continue;
      if (packageAccessScope(manifest) !== "marketplace") continue;
      packages.push({
        id: row.id,
        packageKey: row.packageKey,
        name: row.name,
        version: row.version,
        description: row.description,
        packageType: row.packageType,
        runtimeType: row.runtimeType,
        permissions: parseArray(row.permissionsJson),
        manifest,
        installed: installed.has(row.packageKey),
        publisher: {
          id: row.createdBy,
          username: row.username,
          displayName: row.displayName,
          platformRole: row.platformRole,
        },
        updatedAt: row.updatedAt,
      });
    }
    return Response.json({ packages });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "读取能力商城失败",
      },
      { status: 500 },
    );
  }
}
