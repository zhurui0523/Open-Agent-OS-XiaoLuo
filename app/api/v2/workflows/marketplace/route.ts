import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  canvasEnterpriseShares,
  canvases,
  organizationMembers,
  organizations,
  projects,
  registryEvents,
  users,
  workflowInstallations,
  workflowListings,
  workflowVersions,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { mysqlNow } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import {
  applyWorkflowAssetBundles,
  collectWorkflowAssetBundles,
  sanitizeWorkflowGraph,
  workflowIntegrity,
  workflowTokenHash,
  type WorkflowGraphSnapshot,
  type WorkflowRequirements,
} from "../../../../lib/workflow-marketplace";
import {
  readCanvasGraph,
  replaceCanvasGraph,
} from "../../../../lib/workspace-store";
import type {
  WorkflowMarketplaceItem,
  WorkflowVisibility,
} from "../../../../types";

function parseJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function cleanVisibility(value: unknown): WorkflowVisibility {
  return value === "private" ||
    value === "workspace" ||
    value === "link" ||
    value === "public"
    ? value
    : "workspace";
}

function cleanTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 32))
        .filter(Boolean),
    ),
  ).slice(0, 12);
}

async function organizationScopes(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
) {
  const rows = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      workspaceId: organizations.workspaceId,
    })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMembers.organizationId),
    )
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "active"),
        eq(organizations.status, "active"),
      ),
    );
  return rows.filter(
    (
      row,
    ): row is typeof row & {
      workspaceId: string;
    } => Boolean(row.workspaceId),
  );
}

type ListingRow = {
  listing: typeof workflowListings.$inferSelect;
  version: typeof workflowVersions.$inferSelect;
  author: {
    id: string;
    username: string;
    displayName: string;
  };
};

function serializeListing(row: ListingRow): WorkflowMarketplaceItem {
  const manifest = parseJson<{
    counts?: {
      nodeCount?: number;
      materialCount?: number;
      pluginCount?: number;
      executionCount?: number;
      resultCount?: number;
    };
  }>(row.version.manifestJson, {});
  const counts = manifest.counts ?? {};
  return {
    id: row.listing.id,
    workflowKey: row.listing.workflowKey,
    title: row.listing.title,
    description: row.listing.description,
    category: row.listing.category,
    tags: parseJson<string[]>(row.listing.tagsJson, []),
    visibility: row.listing.visibility,
    status: row.listing.status,
    version: row.version.version,
    author: row.author,
    workspaceId: row.listing.ownerWorkspaceId,
    sourceCanvasId: row.listing.sourceCanvasId,
    nodeCount: Number(counts.nodeCount ?? 0),
    materialCount: Number(counts.materialCount ?? 0),
    pluginCount: Number(counts.pluginCount ?? 0),
    executionCount: Number(counts.executionCount ?? 0),
    resultCount: Number(counts.resultCount ?? 0),
    installCount: row.listing.installCount,
    requirements: parseJson<WorkflowRequirements>(
      row.version.requirementsJson,
      { skills: [], plugins: [], models: [] },
    ),
    createdAt: row.listing.createdAt,
    updatedAt: row.listing.updatedAt,
  };
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const listingId = url.searchParams.get("id")?.trim();
    const shareToken = url.searchParams.get("token")?.trim();
    const tokenHash = shareToken
      ? await workflowTokenHash(shareToken)
      : "";
    const db = await getDb();
    const organizationScopeRows = await organizationScopes(db, user.id);
    const organizationWorkspaceIds = organizationScopeRows.map(
      (scope) => scope.workspaceId,
    );
    const visibility = or(
      eq(workflowListings.visibility, "public"),
      eq(workflowListings.ownerWorkspaceId, workspaceId),
      ...(organizationWorkspaceIds.length
        ? [
            inArray(
              workflowListings.ownerWorkspaceId,
              organizationWorkspaceIds,
            ),
          ]
        : []),
      ...(tokenHash
        ? [eq(workflowListings.shareTokenHash, tokenHash)]
        : []),
    );
    const rows = await db
      .select({
        listing: workflowListings,
        version: workflowVersions,
        author: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      })
      .from(workflowListings)
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.listingId, workflowListings.id),
          eq(workflowVersions.version, workflowListings.latestVersion),
        ),
      )
      .innerJoin(users, eq(users.id, workflowListings.authorUserId))
      .where(
        and(
          listingId ? eq(workflowListings.id, listingId) : undefined,
          or(
            eq(workflowListings.status, "published"),
            eq(workflowListings.ownerWorkspaceId, workspaceId),
          ),
          visibility,
        ),
      )
      .orderBy(desc(workflowListings.updatedAt))
      .limit(listingId ? 1 : 100);
    return Response.json({
      workflows: rows.map((row) =>
        serializeListing(row as ListingRow),
      ),
    });
  } catch (error) {
    return jsonError(error, "读取 Workflow 能力商城失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      listingId?: string;
      title?: string;
      description?: string;
      category?: string;
      tags?: unknown;
      visibility?: WorkflowVisibility;
      changelog?: string;
      canvasShare?: boolean;
      audience?: "public" | "organization" | "organization_live";
    };
    const canvasId = payload.canvasId?.trim();
    if (!canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    const access = await requireCanvasAccess(user.id, canvasId, "manage");
    const source = await readCanvasGraph(canvasId);
    if (!source) {
      return Response.json({ error: "画布不存在" }, { status: 404 });
    }
    const prepared = sanitizeWorkflowGraph(
      source as WorkflowGraphSnapshot,
    );
    if (!payload.canvasShare && !prepared.counts.executionCount) {
      return Response.json(
        { error: "Workflow 至少需要一个 Skill 执行节点" },
        { status: 422 },
      );
    }
    if (!payload.canvasShare && !prepared.counts.resultCount) {
      return Response.json(
        { error: "Workflow 至少需要一个结果占位卡片" },
        { status: 422 },
      );
    }
    const db = await getDb();
    const organizationScope =
      payload.canvasShare &&
      (payload.audience === "organization" ||
        payload.audience === "organization_live")
        ? (await organizationScopes(db, user.id))[0]
        : null;
    if (
      payload.canvasShare &&
      (payload.audience === "organization" ||
        payload.audience === "organization_live") &&
      !organizationScope
    ) {
      return Response.json(
        { error: "当前账号尚未加入可用企业，无法共享给企业用户" },
        { status: 422 },
      );
    }
    const distributionWorkspaceId =
      organizationScope?.workspaceId ?? access.workspaceId;
    const assetBundles = payload.canvasShare
      ? await collectWorkflowAssetBundles(db, access.workspaceId, source.nodes)
      : [];
    if (
      payload.canvasShare &&
      payload.audience === "organization_live" &&
      organizationScope
    ) {
      const now = mysqlNow();
      const [existingCollaboration] = await db
        .select()
        .from(canvasEnterpriseShares)
        .where(
          and(
            eq(canvasEnterpriseShares.sourceCanvasId, canvasId),
            eq(
              canvasEnterpriseShares.organizationId,
              organizationScope.organizationId,
            ),
          ),
        )
        .limit(1);
      let collaborationCanvasId = existingCollaboration?.canvasId ?? "";
      if (!collaborationCanvasId) {
        if (access.workspaceId === organizationScope.workspaceId) {
          collaborationCanvasId = canvasId;
        } else {
          let [enterpriseProject] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.workspaceId, organizationScope.workspaceId),
                eq(projects.status, "active"),
              ),
            )
            .limit(1);
          if (!enterpriseProject) {
            const enterpriseProjectId = crypto.randomUUID();
            await db.insert(projects).values({
              id: enterpriseProjectId,
              workspaceId: organizationScope.workspaceId,
              name: "企业协作画布",
              description: "企业成员实时共同编辑的画布。",
              status: "active",
              createdBy: user.id,
              createdAt: now,
              updatedAt: now,
            });
            enterpriseProject = { id: enterpriseProjectId };
          }
          collaborationCanvasId = crypto.randomUUID();
          if (assetBundles.length) {
            await applyWorkflowAssetBundles({
              db,
              workspaceId: organizationScope.workspaceId,
              nodes: prepared.graph.nodes,
              bundles: assetBundles,
              sourceRef: canvasId,
            });
          }
          await db.insert(canvases).values({
            id: collaborationCanvasId,
            projectId: enterpriseProject.id,
            title: `${source.title || payload.title || "共享画布"} · 企业协作`.slice(
              0,
              180,
            ),
            revision: 1,
            arrangeMode: prepared.graph.arrangeMode ?? "free",
            viewportJson: prepared.graph.viewport ?? { x: 0, y: 0, zoom: 100 },
            groupsJson: prepared.graph.groups ?? [],
            createdBy: user.id,
            createdAt: now,
            updatedAt: now,
          });
          await replaceCanvasGraph({
            canvasId: collaborationCanvasId,
            revision: 1,
            arrangeMode: prepared.graph.arrangeMode ?? "free",
            viewport: prepared.graph.viewport ?? { x: 0, y: 0, zoom: 100 },
            groups: prepared.graph.groups ?? [],
            nodes: prepared.graph.nodes,
            edges: prepared.graph.edges,
          });
        }
        await db.insert(canvasEnterpriseShares).values({
          canvasId: collaborationCanvasId,
          sourceCanvasId: canvasId,
          organizationId: organizationScope.organizationId,
          createdBy: user.id,
          createdAt: now,
          updatedAt: now,
        });
      }
      await db.insert(registryEvents).values({
        id: `registry_${crypto.randomUUID()}`,
        workspaceId: access.workspaceId,
        actorUserId: user.id,
        eventType: "canvas.enterprise_collaboration.enabled",
        entityId: canvasId,
        detailJson: JSON.stringify({
          organizationId: organizationScope.organizationId,
          organizationName: organizationScope.organizationName,
          permission: "edit",
          sourceCanvasId: canvasId,
          collaborationCanvasId,
        }),
        createdAt: now,
      });
      return Response.json(
        {
          collaboration: {
            canvasId: collaborationCanvasId,
            sourceCanvasId: canvasId,
            audience: "organization_live",
            organizationId: organizationScope.organizationId,
            organizationName: organizationScope.organizationName,
            permission: "edit",
            independentCopy: false,
          },
        },
        { status: 201 },
      );
    }
    const [existingById] = payload.listingId
      ? await db
          .select()
          .from(workflowListings)
          .where(
            and(
              eq(workflowListings.id, payload.listingId),
              eq(workflowListings.authorUserId, user.id),
            ),
          )
          .limit(1)
      : [];
    const [existingSharedCanvas] =
      !payload.listingId && payload.canvasShare
        ? await db
            .select()
            .from(workflowListings)
            .where(
              and(
                eq(workflowListings.sourceCanvasId, canvasId),
                eq(workflowListings.authorUserId, user.id),
                eq(workflowListings.category, "共享画布"),
              ),
            )
            .limit(1)
        : [];
    const existing = existingById ?? existingSharedCanvas;
    if (payload.listingId && !existing) {
      return Response.json(
        { error: "Workflow 不存在或无权更新" },
        { status: 404 },
      );
    }
    const listingId = existing?.id ?? `workflow_${crypto.randomUUID()}`;
    const version = existing ? existing.latestVersion + 1 : 1;
    const visibility = payload.canvasShare
      ? payload.audience === "organization"
        ? "workspace"
        : "public"
      : cleanVisibility(payload.visibility);
    const title =
      payload.title?.trim().slice(0, 180) ||
      source.title?.trim().slice(0, 180) ||
      "未命名 Workflow";
    const description =
      payload.description?.trim().slice(0, 2_000) ||
      "可安装、可派生的 XiaoLuo Workflow。";
    const category =
      payload.category?.trim().slice(0, 80) || "通用";
    const tags = cleanTags(payload.tags);
    const token =
      visibility === "link"
        ? `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`
        : null;
    const graphJson = JSON.stringify(prepared.graph);
    const manifest = {
      schemaVersion: "1.0",
      workflowKey:
        existing?.workflowKey ??
        `workflow.${distributionWorkspaceId}.${crypto.randomUUID()}`,
      version,
      title,
      sourceType: payload.canvasShare ? "shared_canvas" : "workflow",
      audience: payload.canvasShare
        ? payload.audience === "organization"
          ? "organization"
          : "public"
        : visibility,
      organizationId: organizationScope?.organizationId ?? null,
      counts: prepared.counts,
      assets: assetBundles,
      privacy: {
        assets: assetBundles.length ? "bundled" : "placeholders-only",
        secrets: "stripped",
        modelConnections: "requirements-only",
      },
    };
    const integritySha256 = await workflowIntegrity({
      graph: prepared.graph,
      requirements: prepared.requirements,
      manifest,
    });
    const now = mysqlNow();
    const versionId = `workflow_version_${crypto.randomUUID()}`;
    await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(workflowListings)
          .set({
            sourceCanvasId: canvasId,
            title,
            description,
            category,
            tagsJson: JSON.stringify(tags),
            ownerWorkspaceId: distributionWorkspaceId,
            visibility,
            status: "published",
            latestVersion: version,
            ...(token
              ? { shareTokenHash: await workflowTokenHash(token) }
              : visibility !== "link"
                ? { shareTokenHash: null }
                : {}),
            updatedAt: now,
          })
          .where(eq(workflowListings.id, listingId));
      } else {
        await tx.insert(workflowListings).values({
          id: listingId,
          workflowKey: manifest.workflowKey,
          ownerWorkspaceId: distributionWorkspaceId,
          authorUserId: user.id,
          sourceCanvasId: canvasId,
          title,
          description,
          category,
          tagsJson: JSON.stringify(tags),
          visibility,
          status: "published",
          latestVersion: version,
          installCount: 0,
          shareTokenHash: token
            ? await workflowTokenHash(token)
            : null,
          createdAt: now,
          updatedAt: now,
        });
      }
      await tx.insert(workflowVersions).values({
        id: versionId,
        listingId,
        version,
        graphJson,
        requirementsJson: JSON.stringify(prepared.requirements),
        manifestJson: JSON.stringify(manifest),
        changelog:
          payload.changelog?.trim().slice(0, 2_000) ||
          (version === 1 ? "首次发布" : `发布版本 ${version}`),
        integritySha256,
        createdBy: user.id,
        createdAt: now,
      });
      await tx.insert(registryEvents).values({
        id: `registry_${crypto.randomUUID()}`,
        workspaceId: distributionWorkspaceId,
        actorUserId: user.id,
        eventType:
          version === 1 ? "workflow.published" : "workflow.version.published",
        entityId: listingId,
        detailJson: JSON.stringify({
          version,
          visibility,
          sourceType: payload.canvasShare ? "shared_canvas" : "workflow",
          audience: payload.canvasShare
            ? payload.audience === "organization"
              ? "organization"
              : "public"
            : visibility,
          organizationId: organizationScope?.organizationId ?? null,
          counts: prepared.counts,
          integritySha256,
        }),
        createdAt: now,
      });
    });
    const origin = new URL(request.url).origin;
    const query = new URLSearchParams({
      view: "capabilities",
      workflow: listingId,
      ...(token ? { token } : {}),
    });
    return Response.json(
      {
        workflow: {
          id: listingId,
          version,
          title,
          visibility,
          audience: payload.canvasShare
            ? payload.audience === "organization"
              ? "organization"
              : "public"
            : visibility,
          organizationName: organizationScope?.organizationName ?? null,
          integritySha256,
          counts: prepared.counts,
          requirements: prepared.requirements,
          shareUrl: `${origin}/?${query.toString()}`,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "发布 Workflow 失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      action?: "unlist" | "publish" | "archive";
      workspaceId?: string;
    };
    if (
      !payload.id ||
      !["unlist", "publish", "archive"].includes(payload.action ?? "")
    ) {
      return Response.json({ error: "Workflow 操作无效" }, { status: 400 });
    }
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const status =
      payload.action === "publish"
        ? "published"
        : payload.action === "archive"
          ? "archived"
          : "unlisted";
    const db = await getDb();
    await db
      .update(workflowListings)
      .set({ status, updatedAt: mysqlNow() })
      .where(
        and(
          eq(workflowListings.id, payload.id),
          eq(workflowListings.ownerWorkspaceId, workspaceId),
        ),
      );
    return Response.json({ ok: true, status });
  } catch (error) {
    return jsonError(error, "更新 Workflow 状态失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    if (user.platformRole !== "system_admin") {
      return Response.json(
        { error: "仅系统管理员可以删除共享画布" },
        { status: 403 },
      );
    }

    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return Response.json({ error: "Workflow id 必填" }, { status: 400 });
    }

    const db = await getDb();
    const [existing] = await db
      .select()
      .from(workflowListings)
      .where(eq(workflowListings.id, id))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "共享画布不存在" }, { status: 404 });
    }

    const now = mysqlNow();
    await db.transaction(async (tx) => {
      await tx
        .delete(workflowInstallations)
        .where(eq(workflowInstallations.listingId, existing.id));
      await tx
        .delete(workflowVersions)
        .where(eq(workflowVersions.listingId, existing.id));
      await tx
        .delete(workflowListings)
        .where(eq(workflowListings.id, existing.id));
      await tx.insert(registryEvents).values({
        id: `registry_${crypto.randomUUID()}`,
        workspaceId: existing.ownerWorkspaceId,
        actorUserId: user.id,
        eventType: "workflow.deleted",
        entityId: existing.id,
        detailJson: JSON.stringify({
          title: existing.title,
          workflowKey: existing.workflowKey,
          latestVersion: existing.latestVersion,
          installCount: existing.installCount,
          retainedInstalledCanvases: true,
        }),
        createdAt: now,
      });
    });

    return Response.json({
      ok: true,
      id: existing.id,
      retainedInstalledCanvases: true,
    });
  } catch (error) {
    return jsonError(error, "删除共享画布失败");
  }
}
