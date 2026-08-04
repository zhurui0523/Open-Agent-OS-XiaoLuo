import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  modelConnections,
  organizationMembers,
  organizations,
  packageCapabilities,
  packages,
  workflowListings,
  workflowVersions,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireProjectAccess } from "../../../../lib/authorization";
import { mysqlNow, mysqlTransaction } from "../../../../lib/mysql";
import { roleForNode } from "../../../../lib/node-role";
import {
  workflowIntegrity,
  workflowTokenHash,
  type WorkflowGraphSnapshot,
  type WorkflowRequirements,
} from "../../../../lib/workflow-marketplace";
import { compileWorkflow } from "../../../../lib/workflow-kernel";
import type { CanvasNode, ModelProtocol } from "../../../../types";

function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function modelSupports(
  row: typeof modelConnections.$inferSelect,
  node: CanvasNode,
  requirements: Record<string, unknown>,
) {
  const modalities = parseJson<string[]>(row.modalitiesJson, []);
  if (!modalities.includes(node.kind)) return false;
  const protocols = Array.isArray(requirements.protocols)
    ? requirements.protocols.filter(
        (item): item is ModelProtocol => typeof item === "string",
      )
    : [];
  if (protocols.length && !protocols.includes(row.protocol as ModelProtocol)) {
    return false;
  }
  const tags = Array.isArray(requirements.capabilityTags)
    ? requirements.capabilityTags.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const modelTags = parseJson<string[]>(row.capabilityTagsJson, []);
  return tags.every((tag) => modelTags.includes(tag));
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      listingId?: string;
      projectId?: string;
      version?: number;
      token?: string;
    };
    const listingId = payload.listingId?.trim();
    const projectId = payload.projectId?.trim();
    if (!listingId || !projectId) {
      return Response.json(
        { error: "listingId 与 projectId 必填" },
        { status: 400 },
      );
    }
    const access = await requireProjectAccess(user.id, projectId, "edit");
    const db = await getDb();
    const organizationScopes = await db
      .select({ workspaceId: organizations.workspaceId })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMembers.organizationId),
      )
      .where(
        and(
          eq(organizationMembers.userId, user.id),
          eq(organizationMembers.status, "active"),
          eq(organizations.status, "active"),
        ),
      );
    const organizationWorkspaceIds = new Set(
      organizationScopes
        .map((scope) => scope.workspaceId)
        .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
    );
    const [listing] = await db
      .select()
      .from(workflowListings)
      .where(eq(workflowListings.id, listingId))
      .limit(1);
    if (!listing || listing.status !== "published") {
      return Response.json({ error: "Workflow 不存在或未发布" }, { status: 404 });
    }
    const suppliedTokenHash = payload.token
      ? await workflowTokenHash(payload.token)
      : "";
    const accessible =
      listing.visibility === "public" ||
      listing.ownerWorkspaceId === access.workspaceId ||
      organizationWorkspaceIds.has(listing.ownerWorkspaceId) ||
      (listing.visibility === "link" &&
        Boolean(suppliedTokenHash) &&
        suppliedTokenHash === listing.shareTokenHash);
    if (!accessible) {
      return Response.json(
        { error: "没有安装该 Workflow 的权限" },
        { status: 403 },
      );
    }
    const requestedVersion =
      Number.isSafeInteger(payload.version) && Number(payload.version) > 0
        ? Number(payload.version)
        : listing.latestVersion;
    const [version] = await db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.listingId, listingId),
          eq(workflowVersions.version, requestedVersion),
        ),
      )
      .limit(1);
    if (!version) {
      return Response.json({ error: "Workflow 版本不存在" }, { status: 404 });
    }
    const graph = parseJson<WorkflowGraphSnapshot | null>(
      version.graphJson,
      null,
    );
    const requirements = parseJson<WorkflowRequirements>(
      version.requirementsJson,
      { skills: [], plugins: [], models: [] },
    );
    const manifest = parseJson<Record<string, unknown>>(
      version.manifestJson,
      {},
    );
    if (!graph) {
      return Response.json({ error: "Workflow 图数据损坏" }, { status: 500 });
    }
    const integrity = await workflowIntegrity({
      graph,
      requirements,
      manifest,
    });
    if (integrity !== version.integritySha256) {
      return Response.json(
        { error: "Workflow 完整性校验失败，已停止安装" },
        { status: 409 },
      );
    }
    compileWorkflow(graph.nodes, graph.edges);

    const [installedPackages, installedCapabilities, models] =
      await Promise.all([
        db
          .select()
          .from(packages)
          .where(
            and(
              eq(packages.workspaceId, access.workspaceId),
              ne(packages.lifecycleState, "uninstalled"),
              eq(packages.enabled, true),
            ),
          ),
        db
          .select({
            capability: packageCapabilities,
            pkg: packages,
          })
          .from(packageCapabilities)
          .innerJoin(packages, eq(packages.id, packageCapabilities.packageId))
          .where(
            and(
              eq(packages.workspaceId, access.workspaceId),
              eq(packages.enabled, true),
              eq(packageCapabilities.enabled, true),
            ),
          ),
        db
          .select()
          .from(modelConnections)
          .where(
            and(
              eq(modelConnections.workspaceId, access.workspaceId),
              eq(modelConnections.enabled, true),
            ),
          ),
      ]);
    const packageByKey = new Map(
      installedPackages
        .filter((item) => item.packageType === "plugin")
        .map((item) => [item.packageKey, item]),
    );
    const capabilityByKey = new Map(
      installedCapabilities
        .filter(
          (item) =>
            item.pkg.packageType === "skill" &&
            item.capability.contributionType === "skill",
        )
        .map((item) => [
          item.capability.capabilityKey,
          item,
        ]),
    );
    const idMap = new Map(
      graph.nodes.map((node) => [node.id, `node_${crypto.randomUUID()}`]),
    );
    const missingSkills = new Set<string>();
    const missingPlugins = new Set<string>();
    const missingModels = new Set<string>();
    const nodes = graph.nodes.map((source, index): CanvasNode => {
      const role = roleForNode(source);
      const parameters = structuredClone(source.parameters ?? {});
      const snapshot =
        parameters.capabilitySnapshot &&
        typeof parameters.capabilitySnapshot === "object" &&
        !Array.isArray(parameters.capabilitySnapshot)
          ? (parameters.capabilitySnapshot as Record<string, unknown>)
          : null;
      let capabilityId = source.capabilityId;
      let modelId = source.modelId;

      if (role === "execution") {
        const capabilityKey = String(
          snapshot?.capabilityKey ?? source.capabilityId ?? "",
        );
        const installed = capabilityByKey.get(capabilityKey);
        if (installed) {
          capabilityId = installed.capability.id;
          const modelRequirements = parseJson<Record<string, unknown>>(
            installed.capability.modelRequirementsJson,
            {},
          );
          if (snapshot) {
            snapshot.id = installed.capability.id;
            snapshot.packageId = installed.pkg.id;
            snapshot.packageKey = installed.pkg.packageKey;
            snapshot.packageVersion = installed.pkg.version;
          }
          if (installed.capability.executionMode === "remote") {
            modelId = "skill-runtime";
          } else {
            const selected = models.find((model) =>
              modelSupports(model, source, modelRequirements),
            );
            modelId = selected?.id ?? "unconfigured";
            if (!selected) missingModels.add(source.kind);
          }
        } else {
          capabilityId = `missing:${capabilityKey || "skill"}`;
          modelId = "unconfigured";
          missingSkills.add(capabilityKey || source.title);
        }
      } else if (role === "plugin") {
        const packageKey = String(
          parameters.packageKey ?? snapshot?.packageKey ?? "",
        );
        const installed = packageByKey.get(packageKey);
        if (installed) {
          parameters.packageId = installed.id;
          parameters.packageKey = installed.packageKey;
          parameters.packageVersion = installed.version;
          parameters.runtimeType = installed.runtimeType;
          const installedManifest = parseJson<{
            runtime?: { language?: string };
          }>(installed.manifestJson, {});
          parameters.runtimeLanguage =
            installedManifest.runtime?.language ?? parameters.runtimeLanguage;
          capabilityId = "core.plugin.runner";
          modelId = "plugin-runtime";
          if (snapshot) {
            snapshot.packageId = installed.id;
            snapshot.packageKey = installed.packageKey;
            snapshot.packageVersion = installed.version;
          }
        } else {
          parameters.packageId = "";
          parameters.missingPackageKey = packageKey;
          missingPlugins.add(packageKey || source.title);
        }
      } else {
        capabilityId =
          role === "material"
            ? "core.material.source"
            : "core.result.placeholder";
        modelId = "none";
      }
      if (typeof parameters.resultOf === "string") {
        parameters.resultOf =
          idMap.get(parameters.resultOf) ?? parameters.resultOf;
      }
      return {
        ...source,
        id: idMap.get(source.id) as string,
        role,
        status: role === "result" ? "waiting" : "draft",
        capabilityId,
        modelId,
        createdAt: Date.now() + index,
        progress: undefined,
        result: undefined,
        parameters: { ...parameters, nodeRole: role },
      };
    });
    const edges = graph.edges.map((edge) => ({
      ...edge,
      id: `edge_${crypto.randomUUID()}`,
      source: idMap.get(edge.source) as string,
      target: idMap.get(edge.target) as string,
    }));
    compileWorkflow(nodes, edges);

    const canvasId = crypto.randomUUID();
    const installationId = `workflow_install_${crypto.randomUUID()}`;
    const now = mysqlNow();
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvases
          (id, project_id, title, arrange_mode, viewport_json, groups_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          canvasId,
          projectId,
          `${listing.title} · v${version.version}`,
          graph.arrangeMode ?? "free",
          JSON.stringify(graph.viewport ?? { x: 0, y: 0, zoom: 100 }),
          JSON.stringify(graph.groups ?? []),
          user.id,
        ],
      );
      for (const node of nodes) {
        await connection.execute(
          `INSERT INTO xiaoluo_v2_canvas_nodes (
             id, canvas_id, kind, node_role, title, prompt, status,
             capability_id, model_id, x, y, progress, result,
             parameters_json, client_created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            node.id,
            canvasId,
            node.kind,
            node.role ?? "execution",
            node.title,
            node.prompt,
            node.status,
            node.capabilityId,
            node.modelId,
            node.x,
            node.y,
            null,
            null,
            JSON.stringify(node.parameters ?? {}),
            node.createdAt ?? null,
          ],
        );
      }
      for (const edge of edges) {
        await connection.execute(
          `INSERT INTO xiaoluo_v2_canvas_edges (
             id, canvas_id, source_node_id, target_node_id,
             source_port_id, target_port_id, data_type
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            edge.id,
            canvasId,
            edge.source,
            edge.target,
            edge.sourcePort,
            edge.targetPort,
            edge.dataType,
          ],
        );
      }
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workflow_installations
          (id, listing_id, version_id, workspace_id, project_id, canvas_id, installed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          installationId,
          listing.id,
          version.id,
          access.workspaceId,
          projectId,
          canvasId,
          user.id,
        ],
      );
      await connection.execute(
        `UPDATE xiaoluo_v2_workflow_listings
         SET install_count = install_count + 1
         WHERE id = ?`,
        [listing.id],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_registry_events
          (id, workspace_id, actor_user_id, event_type, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `registry_${crypto.randomUUID()}`,
          access.workspaceId,
          user.id,
          "workflow.installed",
          listing.id,
          JSON.stringify({
            installationId,
            version: version.version,
            canvasId,
            missing: {
              skills: [...missingSkills],
              plugins: [...missingPlugins],
              models: [...missingModels],
            },
          }),
        ],
      );
    });
    return Response.json(
      {
        canvas: {
          id: canvasId,
          title: `${listing.title} · v${version.version}`,
          nodes: nodes.length,
          updatedAt: now,
        },
        installation: {
          id: installationId,
          listingId,
          version: version.version,
        },
        missing: {
          skills: [...missingSkills],
          plugins: [...missingPlugins],
          models: [...missingModels],
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "安装 Workflow 失败");
  }
}
