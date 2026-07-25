import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  datetime,
  double,
  foreignKey,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = (name: string, length = 160) => varchar(name, { length });
const timestamp = (name: string) =>
  datetime(name, { mode: "string", fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);

export const users = mysqlTable("xiaoluo_v2_users", {
  id: id("id", 36).primaryKey(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  username: varchar("username", { length: 32 }).notNull().unique(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  phoneHash: varchar("phone_hash", { length: 64 }).unique(),
  phoneLast4: varchar("phone_last4", { length: 4 }),
  phoneVerifiedAt: datetime("phone_verified_at", {
    mode: "string",
    fsp: 3,
  }),
  platformRole: mysqlEnum("platform_role", ["system_admin", "user"])
    .notNull()
    .default("user"),
  status: mysqlEnum("status", ["active", "disabled"])
    .notNull()
    .default("active"),
  passwordChangedAt: timestamp("password_changed_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const authChallenges = mysqlTable(
  "xiaoluo_v2_auth_challenges",
  {
    id: id("id", 36).primaryKey(),
    phoneHash: varchar("phone_hash", { length: 64 }).notNull(),
    purpose: mysqlEnum("purpose", [
      "register",
      "password_reset",
      "phone_change",
    ]).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    requestIpHash: varchar("request_ip_hash", { length: 64 }).notNull(),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(5),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    consumedAt: datetime("consumed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("auth_challenges_phone_idx").on(
      table.phoneHash,
      table.purpose,
      table.createdAt,
    ),
    index("auth_challenges_ip_idx").on(table.requestIpHash, table.createdAt),
    index("auth_challenges_expiry_idx").on(table.expiresAt),
  ],
);

export const passwordResetTokens = mysqlTable(
  "xiaoluo_v2_password_reset_tokens",
  {
    id: id("id", 36).primaryKey(),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    usedAt: datetime("used_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("password_reset_user_idx").on(table.userId),
    index("password_reset_expiry_idx").on(table.expiresAt),
  ],
);

export const authSessions = mysqlTable(
  "xiaoluo_v2_auth_sessions",
  {
    id: id("id", 36).primaryKey(),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    refreshTokenHash: varchar("refresh_token_hash", { length: 64 }).unique(),
    refreshExpiresAt: datetime("refresh_expires_at", {
      mode: "string",
      fsp: 3,
    }),
    refreshRotatedAt: datetime("refresh_rotated_at", {
      mode: "string",
      fsp: 3,
    }),
    deviceName: varchar("device_name", { length: 160 }),
    userAgent: varchar("user_agent", { length: 500 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: timestamp("created_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    index("auth_sessions_user_idx").on(table.userId),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
    index("auth_sessions_refresh_expiry_idx").on(table.refreshExpiresAt),
  ],
);

export const userPreferences = mysqlTable("xiaoluo_v2_user_preferences", {
  userId: id("user_id", 36)
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settingsJson: longtext("settings_json").notNull(),
  revision: bigint("revision", { mode: "number", unsigned: true })
    .notNull()
    .default(1),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const userSecuritySettings = mysqlTable(
  "xiaoluo_v2_user_security_settings",
  {
    userId: id("user_id", 36)
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    allowMultipleSessions: boolean("allow_multiple_sessions")
      .notNull()
      .default(true),
    sessionTtlDays: int("session_ttl_days", { unsigned: true })
      .notNull()
      .default(30),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
);

export const workspaces = mysqlTable(
  "xiaoluo_v2_workspaces",
  {
    id: id("id", 36).primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    ownerId: id("owner_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: mysqlEnum("status", ["active", "archived", "trashed"])
      .notNull()
      .default("active"),
    deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("workspaces_owner_idx").on(table.ownerId)],
);

export const workspaceMembers = mysqlTable(
  "xiaoluo_v2_workspace_members",
  {
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["owner", "admin", "editor", "viewer"])
      .notNull()
      .default("viewer"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const organizations = mysqlTable(
  "xiaoluo_v2_organizations",
  {
    id: id("id", 36).primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    registrationCode: varchar("registration_code", { length: 80 }),
    status: mysqlEnum("status", ["pending", "active", "rejected", "disabled"])
      .notNull()
      .default("pending"),
    workspaceId: id("workspace_id", 36).references(() => workspaces.id, {
      onDelete: "set null",
    }),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedBy: id("reviewed_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: datetime("reviewed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("organizations_status_idx").on(table.status),
    index("organizations_creator_idx").on(table.createdBy),
  ],
);

export const organizationMembers = mysqlTable(
  "xiaoluo_v2_organization_members",
  {
    organizationId: id("organization_id", 36)
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["admin", "member"]).notNull().default("member"),
    status: mysqlEnum("status", ["active", "disabled"])
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_idx").on(table.userId),
  ],
);

export const enterpriseApplications = mysqlTable(
  "xiaoluo_v2_enterprise_applications",
  {
    id: id("id", 36).primaryKey(),
    organizationId: id("organization_id", 36)
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicantId: id("applicant_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    contactName: varchar("contact_name", { length: 80 }).notNull(),
    note: text("note").notNull(),
    status: mysqlEnum("status", ["pending", "approved", "rejected"])
      .notNull()
      .default("pending"),
    reviewedBy: id("reviewed_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: datetime("reviewed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("enterprise_applications_status_idx").on(table.status),
    index("enterprise_applications_org_idx").on(table.organizationId),
  ],
);

export const organizationInvitations = mysqlTable(
  "xiaoluo_v2_organization_invitations",
  {
    id: id("id", 36).primaryKey(),
    organizationId: id("organization_id", 36)
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    phoneHash: varchar("phone_hash", { length: 64 }).notNull(),
    phoneLast4: varchar("phone_last4", { length: 4 }).notNull(),
    role: mysqlEnum("role", ["admin", "member"]).notNull().default("member"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    invitedBy: id("invited_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }).notNull(),
    acceptedBy: id("accepted_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: datetime("accepted_at", { mode: "string", fsp: 3 }),
    revokedAt: datetime("revoked_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("organization_invitations_org_idx").on(table.organizationId),
    index("organization_invitations_phone_idx").on(table.phoneHash),
    index("organization_invitations_expiry_idx").on(table.expiresAt),
  ],
);

export const projects = mysqlTable(
  "xiaoluo_v2_projects",
  {
    id: id("id", 36).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description").notNull(),
    status: mysqlEnum("status", ["active", "archived", "trashed"])
      .notNull()
      .default("active"),
    deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("projects_workspace_idx").on(table.workspaceId)],
);

export const canvases = mysqlTable(
  "xiaoluo_v2_canvases",
  {
    id: id("id", 36).primaryKey(),
    projectId: id("project_id", 36)
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 180 }).notNull(),
    revision: bigint("revision", { mode: "number", unsigned: true })
      .notNull()
      .default(1),
    arrangeMode: mysqlEnum("arrange_mode", ["free", "time", "type"])
      .notNull()
      .default("free"),
    viewportJson: json("viewport_json").notNull(),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    archivedAt: datetime("archived_at", { mode: "string", fsp: 3 }),
    starred: boolean("starred").notNull().default(false),
    deletedAt: datetime("deleted_at", { mode: "string", fsp: 3 }),
  },
  (table) => [
    index("canvases_project_idx").on(table.projectId),
    index("canvases_updated_idx").on(table.updatedAt),
  ],
);

export const canvasNodes = mysqlTable(
  "xiaoluo_v2_canvas_nodes",
  {
    id: id("id", 80).notNull(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    kind: mysqlEnum("kind", [
      "text",
      "image",
      "video",
      "audio",
      "document",
    ]).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    prompt: text("prompt").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    capabilityId: id("capability_id", 120).notNull(),
    modelId: id("model_id", 120).notNull(),
    x: double("x").notNull(),
    y: double("y").notNull(),
    progress: double("progress"),
    result: longtext("result"),
    parametersJson: json("parameters_json").notNull(),
    clientCreatedAt: bigint("client_created_at", {
      mode: "number",
      unsigned: true,
    }),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.id] }),
    index("canvas_nodes_canvas_idx").on(table.canvasId),
  ],
);

export const canvasEdges = mysqlTable(
  "xiaoluo_v2_canvas_edges",
  {
    id: id("id", 100).notNull(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    sourceNodeId: id("source_node_id", 80).notNull(),
    targetNodeId: id("target_node_id", 80).notNull(),
    sourcePortId: id("source_port_id", 80).notNull().default("output"),
    targetPortId: id("target_port_id", 80).notNull().default("input"),
    dataType: varchar("data_type", { length: 24 }).notNull().default("text"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.id] }),
    index("canvas_edges_canvas_idx").on(table.canvasId),
    index("canvas_edges_source_idx").on(table.canvasId, table.sourceNodeId),
    index("canvas_edges_target_idx").on(table.canvasId, table.targetNodeId),
  ],
);

export const canvasSnapshots = mysqlTable(
  "xiaoluo_v2_canvas_snapshots",
  {
    id: id("id", 120).primaryKey(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number", unsigned: true }).notNull(),
    label: varchar("label", { length: 180 }).notNull(),
    graphJson: longtext("graph_json").notNull(),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("canvas_snapshots_canvas_idx").on(table.canvasId, table.createdAt),
  ],
);

export const canvasShareLinks = mysqlTable(
  "xiaoluo_v2_canvas_share_links",
  {
    id: id("id", 120).primaryKey(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    mode: mysqlEnum("mode", ["read_only", "workflow"]).notNull(),
    graphJson: longtext("graph_json").notNull(),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }),
    revokedAt: datetime("revoked_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("canvas_share_canvas_idx").on(table.canvasId),
    index("canvas_share_expiry_idx").on(table.expiresAt),
  ],
);

export const resourcePermissions = mysqlTable(
  "xiaoluo_v2_resource_permissions",
  {
    id: id("id", 36).primaryKey(),
    resourceType: mysqlEnum("resource_type", [
      "project",
      "canvas",
      "asset",
    ]).notNull(),
    resourceId: id("resource_id", 36).notNull(),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: mysqlEnum("permission", ["view", "edit", "manage"]).notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("resource_permissions_unique").on(
      table.resourceType,
      table.resourceId,
      table.userId,
    ),
    index("resource_permissions_lookup_idx").on(
      table.resourceType,
      table.resourceId,
      table.userId,
    ),
  ],
);

export const canvasPresence = mysqlTable(
  "xiaoluo_v2_canvas_presence",
  {
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: id("user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: id("session_id", 80).notNull(),
    cursorX: double("cursor_x"),
    cursorY: double("cursor_y"),
    selectedNodeIdsJson: longtext("selected_node_ids_json").notNull(),
    clientRevision: bigint("client_revision", {
      mode: "number",
      unsigned: true,
    })
      .notNull()
      .default(0),
    state: varchar("state", { length: 24 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    primaryKey({
      name: "canvas_presence_pk",
      columns: [table.canvasId, table.userId, table.sessionId],
    }),
    index("canvas_presence_canvas_seen_idx").on(
      table.canvasId,
      table.lastSeenAt,
    ),
    index("canvas_presence_user_idx").on(table.userId),
  ],
);

export const canvasComments = mysqlTable(
  "xiaoluo_v2_canvas_comments",
  {
    id: id("id", 120).primaryKey(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    nodeId: id("node_id", 120),
    authorUserId: id("author_user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    content: text("content").notNull(),
    mentionsJson: longtext("mentions_json").notNull(),
    status: mysqlEnum("status", ["open", "resolved"])
      .notNull()
      .default("open"),
    resolvedBy: id("resolved_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: datetime("resolved_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("canvas_comments_canvas_status_idx").on(
      table.canvasId,
      table.status,
      table.createdAt,
    ),
    index("canvas_comments_author_idx").on(table.authorUserId),
  ],
);

export const canvasCollaborationEvents = mysqlTable(
  "xiaoluo_v2_canvas_collaboration_events",
  {
    sequence: bigint("sequence", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    id: id("id", 120).notNull().unique(),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: id("actor_user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sessionId: id("session_id", 80),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    payloadJson: longtext("payload_json").notNull(),
    canvasRevision: bigint("canvas_revision", {
      mode: "number",
      unsigned: true,
    }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("canvas_collab_canvas_sequence_idx").on(
      table.canvasId,
      table.sequence,
    ),
    index("canvas_collab_actor_idx").on(table.actorUserId, table.createdAt),
  ],
);

export const intentConversations = mysqlTable(
  "xiaoluo_v2_intent_conversations",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canvasId: id("canvas_id", 36)
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 180 }).notNull(),
    status: mysqlEnum("status", ["active", "archived"])
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("intent_conversations_workspace_idx").on(table.workspaceId),
    index("intent_conversations_canvas_idx").on(table.canvasId),
  ],
);

export const intentMessages = mysqlTable(
  "xiaoluo_v2_intent_messages",
  {
    id: id("id", 120).primaryKey(),
    conversationId: id("conversation_id", 120)
      .notNull()
      .references(() => intentConversations.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["user", "assistant", "system"]).notNull(),
    content: longtext("content").notNull(),
    metadataJson: longtext("metadata_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("intent_messages_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const intentPlans = mysqlTable(
  "xiaoluo_v2_intent_plans",
  {
    id: id("id", 120).primaryKey(),
    conversationId: id("conversation_id", 120)
      .notNull()
      .references(() => intentConversations.id, { onDelete: "cascade" }),
    version: int("version", { unsigned: true }).notNull(),
    status: mysqlEnum("status", [
      "draft",
      "awaiting_confirmation",
      "confirmed",
      "rejected",
    ])
      .notNull()
      .default("draft"),
    goal: text("goal").notNull(),
    planJson: longtext("plan_json").notNull(),
    planner: varchar("planner", { length: 180 }).notNull(),
    confirmedAt: datetime("confirmed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("intent_plans_conversation_version_unique").on(
      table.conversationId,
      table.version,
    ),
  ],
);

export const trustedPublishers = mysqlTable(
  "xiaoluo_v2_trusted_publishers",
  {
    id: id("id", 120).primaryKey(),
    slug: varchar("slug", { length: 160 }).notNull().unique(),
    displayName: varchar("display_name", { length: 180 }).notNull(),
    website: text("website"),
    contactEmail: varchar("contact_email", { length: 254 }),
    status: mysqlEnum("status", [
      "pending",
      "approved",
      "suspended",
      "revoked",
    ])
      .notNull()
      .default("pending"),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedBy: id("reviewed_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: datetime("reviewed_at", { mode: "string", fsp: 3 }),
    reason: text("reason"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("trusted_publishers_status_idx").on(table.status)],
);

export const publisherKeys = mysqlTable(
  "xiaoluo_v2_publisher_keys",
  {
    id: id("id", 120).primaryKey(),
    publisherId: id("publisher_id", 120)
      .notNull()
      .references(() => trustedPublishers.id, { onDelete: "cascade" }),
    algorithm: varchar("algorithm", { length: 40 })
      .notNull()
      .default("ECDSA_P256_SHA256"),
    publicKeyPem: longtext("public_key_pem").notNull(),
    fingerprintSha256: varchar("fingerprint_sha256", { length: 64 })
      .notNull()
      .unique(),
    status: mysqlEnum("status", ["active", "revoked", "expired"])
      .notNull()
      .default("active"),
    expiresAt: datetime("expires_at", { mode: "string", fsp: 3 }),
    revokedAt: datetime("revoked_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("publisher_keys_publisher_status_idx").on(
      table.publisherId,
      table.status,
    ),
  ],
);

export const packageReviews = mysqlTable(
  "xiaoluo_v2_package_reviews",
  {
    id: id("id", 120).primaryKey(),
    packageKey: id("package_key", 160).notNull(),
    version: varchar("version", { length: 80 }).notNull(),
    publisherId: id("publisher_id", 120).references(
      () => trustedPublishers.id,
      { onDelete: "set null" },
    ),
    publisherKeyId: id("publisher_key_id", 120).references(
      () => publisherKeys.id,
      { onDelete: "set null" },
    ),
    manifestSha256: varchar("manifest_sha256", { length: 64 }).notNull(),
    signature: text("signature"),
    signatureVerified: boolean("signature_verified")
      .notNull()
      .default(false),
    status: mysqlEnum("status", [
      "pending",
      "approved",
      "rejected",
      "quarantined",
      "revoked",
    ])
      .notNull()
      .default("pending"),
    scanJson: longtext("scan_json").notNull(),
    reason: text("reason"),
    submittedBy: id("submitted_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedBy: id("reviewed_by", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: datetime("reviewed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("package_reviews_package_version_unique").on(
      table.packageKey,
      table.version,
    ),
    index("package_reviews_status_idx").on(table.status, table.createdAt),
    index("package_reviews_publisher_idx").on(table.publisherId),
  ],
);

export const packages = mysqlTable("xiaoluo_v2_packages", {
  id: id("id", 120).primaryKey(),
  packageKey: id("package_key", 160).notNull(),
  workspaceId: id("workspace_id", 36)
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: id("created_by", 36)
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 180 }).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  description: text("description").notNull(),
  packageType: varchar("package_type", { length: 40 }).notNull(),
  runtimeType: varchar("runtime_type", { length: 40 }).notNull(),
  runtimeUrl: text("runtime_url"),
  manifestJson: longtext("manifest_json").notNull(),
  permissionsJson: longtext("permissions_json").notNull(),
  lifecycleState: varchar("lifecycle_state", { length: 32 })
    .notNull()
    .default("active"),
  healthStatus: varchar("health_status", { length: 32 })
    .notNull()
    .default("unchecked"),
  integritySha256: varchar("integrity_sha256", { length: 64 }).notNull(),
  signature: text("signature"),
  publisherId: id("publisher_id", 120).references(
    () => trustedPublishers.id,
    { onDelete: "set null" },
  ),
  reviewId: id("review_id", 120).references(() => packageReviews.id, {
    onDelete: "set null",
  }),
  trustState: varchar("trust_state", { length: 32 })
    .notNull()
    .default("unverified"),
  enabled: boolean("enabled").notNull().default(true),
  installedAt: timestamp("installed_at"),
  updatedAt: timestamp("updated_at"),
});

export const packageCapabilities = mysqlTable(
  "xiaoluo_v2_package_capabilities",
  {
    id: id("id").primaryKey(),
    capabilityKey: id("capability_key", 200).notNull(),
    packageId: id("package_id", 120)
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 180 }).notNull(),
    description: text("description").notNull(),
    modality: varchar("modality", { length: 24 }).notNull(),
    contributionType: varchar("contribution_type", { length: 32 }).notNull(),
    inputSchemaJson: longtext("input_schema_json").notNull(),
    outputSchemaJson: longtext("output_schema_json").notNull(),
    uiSchemaJson: longtext("ui_schema_json").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [index("package_capabilities_package_idx").on(table.packageId)],
);

export const packageVersions = mysqlTable(
  "xiaoluo_v2_package_versions",
  {
    id: id("id", 120).primaryKey(),
    packageId: id("package_id", 120)
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 80 }).notNull(),
    manifestJson: longtext("manifest_json").notNull(),
    permissionsJson: longtext("permissions_json").notNull(),
    integritySha256: varchar("integrity_sha256", { length: 64 }).notNull(),
    signature: text("signature"),
    installedBy: id("installed_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    installedAt: timestamp("installed_at"),
  },
  (table) => [
    uniqueIndex("package_versions_package_version_unique").on(
      table.packageId,
      table.version,
    ),
  ],
);

export const secretRefs = mysqlTable(
  "xiaoluo_v2_secret_refs",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    ciphertext: longtext("ciphertext").notNull(),
    iv: varchar("iv", { length: 64 }).notNull(),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastUsedAt: datetime("last_used_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("secret_refs_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
  ],
);

export const modelConnections = mysqlTable(
  "xiaoluo_v2_model_connections",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 180 }).notNull(),
    protocol: varchar("protocol", { length: 60 }).notNull(),
    baseUrl: text("base_url").notNull(),
    modelName: varchar("model_name", { length: 180 }).notNull(),
    modalitiesJson: text("modalities_json").notNull(),
    credentialRef: varchar("credential_ref", { length: 80 }),
    secretRefId: id("secret_ref_id", 120).references(() => secretRefs.id, {
      onDelete: "set null",
    }),
    priority: int("priority").notNull().default(100),
    fallbackModelId: id("fallback_model_id", 120),
    maxConcurrency: int("max_concurrency", { unsigned: true })
      .notNull()
      .default(2),
    retryLimit: int("retry_limit", { unsigned: true }).notNull().default(3),
    circuitFailureThreshold: int("circuit_failure_threshold", {
      unsigned: true,
    })
      .notNull()
      .default(5),
    circuitCooldownSeconds: int("circuit_cooldown_seconds", {
      unsigned: true,
    })
      .notNull()
      .default(60),
    circuitState: varchar("circuit_state", { length: 20 })
      .notNull()
      .default("closed"),
    circuitFailureCount: int("circuit_failure_count", { unsigned: true })
      .notNull()
      .default(0),
    circuitOpenedAt: datetime("circuit_opened_at", {
      mode: "string",
      fsp: 3,
    }),
    activeRequests: int("active_requests", { unsigned: true })
      .notNull()
      .default(0),
    lastSuccessAt: datetime("last_success_at", { mode: "string", fsp: 3 }),
    lastFailureAt: datetime("last_failure_at", { mode: "string", fsp: 3 }),
    catalogSyncedAt: datetime("catalog_synced_at", {
      mode: "string",
      fsp: 3,
    }),
    enabled: boolean("enabled").notNull().default(true),
    state: varchar("state", { length: 32 }).notNull().default("attention"),
    latencyMs: int("latency_ms"),
    lastCheckedAt: datetime("last_checked_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("model_connections_workspace_priority_idx").on(
      table.workspaceId,
      table.enabled,
      table.priority,
    ),
    index("model_connections_circuit_idx").on(
      table.workspaceId,
      table.circuitState,
    ),
  ],
);

export const modelCatalogEntries = mysqlTable(
  "xiaoluo_v2_model_catalog_entries",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36).notNull(),
    connectionId: id("connection_id", 120).notNull(),
    modelId: varchar("model_id", { length: 240 }).notNull(),
    displayName: varchar("display_name", { length: 240 }).notNull(),
    modalitiesJson: text("modalities_json").notNull(),
    available: boolean("available").notNull().default(true),
    metadataJson: longtext("metadata_json").notNull(),
    discoveredAt: timestamp("discovered_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [
    uniqueIndex("model_catalog_connection_model_unique").on(
      table.connectionId,
      table.modelId,
    ),
    index("model_catalog_workspace_available_idx").on(
      table.workspaceId,
      table.available,
    ),
    foreignKey({
      name: "model_catalog_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "model_catalog_connection_fk",
      columns: [table.connectionId],
      foreignColumns: [modelConnections.id],
    }).onDelete("cascade"),
  ],
);

export const modelExecutionAudits = mysqlTable(
  "xiaoluo_v2_model_execution_audits",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36).notNull(),
    userId: id("user_id", 36).notNull(),
    runId: id("run_id", 120),
    nodeId: id("node_id", 120),
    requestedConnectionId: id("requested_connection_id", 120),
    actualConnectionId: id("actual_connection_id", 120),
    modelName: varchar("model_name", { length: 240 }).notNull(),
    modality: varchar("modality", { length: 20 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    attempts: int("attempts", { unsigned: true }).notNull().default(1),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    latencyMs: int("latency_ms", { unsigned: true }),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at"),
    completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
  },
  (table) => [
    index("model_audits_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("model_audits_run_idx").on(table.runId),
    foreignKey({
      name: "model_audit_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "model_audit_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("restrict"),
  ],
);

export const modelUsageStats = mysqlTable(
  "xiaoluo_v2_model_usage_stats",
  {
    workspaceId: id("workspace_id", 36).notNull(),
    connectionId: id("connection_id", 120).notNull(),
    usageDay: varchar("usage_day", { length: 10 }).notNull(),
    modality: varchar("modality", { length: 20 }).notNull(),
    totalCount: bigint("total_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    successCount: bigint("success_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    failureCount: bigint("failure_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    retryCount: bigint("retry_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    fallbackCount: bigint("fallback_count", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    primaryKey({
      name: "model_usage_stats_pk",
      columns: [
        table.workspaceId,
        table.connectionId,
        table.usageDay,
        table.modality,
      ],
    }),
    index("model_usage_workspace_day_idx").on(
      table.workspaceId,
      table.usageDay,
    ),
    foreignKey({
      name: "model_usage_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
  ],
);

export const registryEvents = mysqlTable(
  "xiaoluo_v2_registry_events",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: id("actor_user_id", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    entityId: id("entity_id").notNull(),
    detailJson: longtext("detail_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [index("registry_events_created_idx").on(table.createdAt)],
);

export const rateLimitBuckets = mysqlTable(
  "xiaoluo_v2_rate_limit_buckets",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    subject: varchar("subject", { length: 160 }).notNull(),
    route: varchar("route", { length: 160 }).notNull(),
    windowStartedAt: datetime("window_started_at", {
      mode: "string",
      fsp: 3,
    }).notNull(),
    count: int("count", { unsigned: true }).notNull().default(1),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("rate_limit_subject_route_idx").on(table.subject, table.route),
    index("rate_limit_updated_idx").on(table.updatedAt),
  ],
);

export const kernelRuns = mysqlTable("xiaoluo_v2_kernel_runs", {
  id: id("id", 120).primaryKey(),
  workspaceId: id("workspace_id", 36)
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: id("created_by", 36)
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  canvasId: id("canvas_id", 36).references(() => canvases.id, {
    onDelete: "set null",
  }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("queued"),
  desiredStatus: varchar("desired_status", { length: 32 })
    .notNull()
    .default("running"),
  graphJson: longtext("graph_json").notNull(),
  error: text("error"),
  leaseOwner: varchar("lease_owner", { length: 160 }),
  leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }),
  heartbeatAt: datetime("heartbeat_at", { mode: "string", fsp: 3 }),
  createdAt: timestamp("created_at"),
  startedAt: datetime("started_at", { mode: "string", fsp: 3 }),
  completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
  updatedAt: timestamp("updated_at"),
});

export const kernelTasks = mysqlTable(
  "xiaoluo_v2_kernel_tasks",
  {
    id: id("id").primaryKey(),
    runId: id("run_id", 120)
      .notNull()
      .references(() => kernelRuns.id, { onDelete: "cascade" }),
    nodeId: id("node_id", 120).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    dependenciesJson: longtext("dependencies_json").notNull(),
    inputJson: longtext("input_json"),
    outputJson: longtext("output_json"),
    executor: varchar("executor", { length: 240 }),
    error: text("error"),
    attempt: int("attempt", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(3),
    leaseOwner: varchar("lease_owner", { length: 160 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }),
    startedAt: datetime("started_at", { mode: "string", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("kernel_tasks_run_idx").on(table.runId)],
);

export const runEvents = mysqlTable(
  "xiaoluo_v2_run_events",
  {
    id: id("id", 120).primaryKey(),
    runId: id("run_id", 120)
      .notNull()
      .references(() => kernelRuns.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    nodeId: id("node_id", 120),
    payloadJson: longtext("payload_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("run_events_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const generationJobs = mysqlTable(
  "xiaoluo_v2_generation_jobs",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: id("requested_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    runId: id("run_id", 120).references(() => kernelRuns.id, {
      onDelete: "set null",
    }),
    nodeId: id("node_id", 120),
    kind: varchar("kind", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    progress: int("progress", { unsigned: true }).notNull().default(0),
    provider: varchar("provider", { length: 120 }).notNull(),
    modelConnectionId: id("model_connection_id", 120),
    externalJobId: varchar("external_job_id", { length: 240 }),
    pollUrl: text("poll_url"),
    cancelUrl: text("cancel_url"),
    providerStatus: varchar("provider_status", { length: 80 }),
    pollCount: int("poll_count", { unsigned: true }).notNull().default(0),
    maxPolls: int("max_polls", { unsigned: true }).notNull().default(180),
    nextPollAt: datetime("next_poll_at", { mode: "string", fsp: 3 }),
    lastPolledAt: datetime("last_polled_at", { mode: "string", fsp: 3 }),
    leaseOwner: varchar("lease_owner", { length: 160 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "string", fsp: 3 }),
    inputJson: longtext("input_json").notNull(),
    outputJson: longtext("output_json"),
    error: text("error"),
    createdAt: timestamp("created_at"),
    startedAt: datetime("started_at", { mode: "string", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("generation_jobs_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("generation_jobs_due_idx").on(
      table.status,
      table.nextPollAt,
      table.leaseExpiresAt,
    ),
    index("generation_jobs_run_idx").on(table.runId),
  ],
);

export const isolatedWorkerJobs = mysqlTable(
  "xiaoluo_v2_isolated_worker_jobs",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestedBy: id("requested_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    packageId: id("package_id", 120).references(() => packages.id, {
      onDelete: "set null",
    }),
    runtime: mysqlEnum("runtime", ["node", "python", "cli"]).notNull(),
    status: mysqlEnum("status", [
      "queued",
      "dispatched",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ])
      .notNull()
      .default("queued"),
    endpointOrigin: varchar("endpoint_origin", { length: 300 }),
    externalExecutionId: varchar("external_execution_id", { length: 240 }),
    requestJson: longtext("request_json").notNull(),
    responseJson: longtext("response_json"),
    policyJson: longtext("policy_json").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at"),
    startedAt: datetime("started_at", { mode: "string", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "string", fsp: 3 }),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("isolated_jobs_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index("isolated_jobs_external_idx").on(table.externalExecutionId),
  ],
);

export const systemHeartbeats = mysqlTable(
  "xiaoluo_v2_system_heartbeats",
  {
    component: varchar("component", { length: 80 }).primaryKey(),
    instanceId: varchar("instance_id", { length: 160 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("healthy"),
    detailJson: longtext("detail_json").notNull(),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("system_heartbeats_seen_idx").on(table.lastSeenAt)],
);

export const assetFolders = mysqlTable(
  "xiaoluo_v2_asset_folders",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 180 }).notNull(),
    parentId: id("parent_id", 120),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("asset_folders_workspace_idx").on(table.workspaceId),
    index("asset_folders_parent_idx").on(table.parentId),
  ],
);

export const assets = mysqlTable(
  "xiaoluo_v2_assets",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uri: varchar("uri", { length: 240 }).notNull().unique(),
    name: varchar("name", { length: 240 }).notNull(),
    kind: varchar("kind", { length: 40 }).notNull(),
    mimeType: varchar("mime_type", { length: 180 }).notNull(),
    size: bigint("size", { mode: "number", unsigned: true }).notNull(),
    folderId: id("folder_id", 120),
    currentVersionId: id("current_version_id", 120),
    currentVersion: int("current_version", { unsigned: true })
      .notNull()
      .default(1),
    versionCount: int("version_count", { unsigned: true })
      .notNull()
      .default(1),
    tagsJson: longtext("tags_json").notNull(),
    description: text("description").notNull(),
    searchText: longtext("search_text").notNull(),
    sourceType: varchar("source_type", { length: 80 })
      .notNull()
      .default("upload"),
    sourceRef: varchar("source_ref", { length: 240 }),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    favorite: boolean("favorite").notNull().default(false),
    status: varchar("status", { length: 32 }).notNull().default("ready"),
    missingAt: datetime("missing_at", { mode: "string", fsp: 3 }),
    trashedAt: datetime("trashed_at", { mode: "string", fsp: 3 }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("assets_workspace_idx").on(table.workspaceId),
    index("assets_folder_idx").on(table.folderId),
    index("assets_hash_idx").on(table.contentHash),
  ],
);

export const assetCollections = mysqlTable(
  "xiaoluo_v2_asset_collections",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36)
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 180 }).notNull(),
    description: text("description").notNull(),
    createdBy: id("created_by", 36)
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("asset_collections_workspace_idx").on(table.workspaceId),
  ],
);

export const assetCollectionItems = mysqlTable(
  "xiaoluo_v2_asset_collection_items",
  {
    collectionId: id("collection_id", 120)
      .notNull()
      .references(() => assetCollections.id, { onDelete: "cascade" }),
    assetId: id("asset_id", 120)
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.assetId] }),
  ],
);

export const assetVersions = mysqlTable(
  "xiaoluo_v2_asset_versions",
  {
    id: id("id", 120).primaryKey(),
    assetId: id("asset_id", 120)
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    version: int("version", { unsigned: true }).notNull(),
    blobKey: varchar("blob_key", { length: 420 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    mimeType: varchar("mime_type", { length: 180 }).notNull(),
    size: bigint("size", { mode: "number", unsigned: true }).notNull(),
    sourceType: varchar("source_type", { length: 80 })
      .notNull()
      .default("upload"),
    sourceRef: varchar("source_ref", { length: 240 }),
    metadataJson: longtext("metadata_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("asset_versions_hash_idx").on(table.contentHash),
    uniqueIndex("asset_versions_asset_version_unique").on(
      table.assetId,
      table.version,
    ),
  ],
);

export const assetRelations = mysqlTable(
  "xiaoluo_v2_asset_relations",
  {
    id: id("id", 120).primaryKey(),
    fromAssetId: id("from_asset_id", 120)
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    toAssetId: id("to_asset_id", 120)
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    relationType: varchar("relation_type", { length: 80 }).notNull(),
    metadataJson: longtext("metadata_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("asset_relations_from_idx").on(table.fromAssetId),
    index("asset_relations_to_idx").on(table.toAssetId),
  ],
);

export const auditLogs = mysqlTable(
  "xiaoluo_v2_audit_logs",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36).references(() => workspaces.id, {
      onDelete: "set null",
    }),
    actorUserId: id("actor_user_id", 36).references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    entityType: varchar("entity_type", { length: 80 }).notNull(),
    entityId: id("entity_id", 160).notNull(),
    requestId: varchar("request_id", { length: 120 }),
    detailJson: longtext("detail_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("audit_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("audit_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_entity_idx").on(table.entityType, table.entityId),
  ],
);

export const outboxEvents = mysqlTable(
  "xiaoluo_v2_outbox_events",
  {
    id: id("id", 120).primaryKey(),
    workspaceId: id("workspace_id", 36).references(() => workspaces.id, {
      onDelete: "set null",
    }),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: id("aggregate_id", 160).notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    payloadJson: longtext("payload_json").notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "published",
      "failed",
    ])
      .notNull()
      .default("pending"),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    availableAt: timestamp("available_at"),
    claimedAt: datetime("claimed_at", { mode: "string", fsp: 3 }),
    publishedAt: datetime("published_at", { mode: "string", fsp: 3 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("outbox_delivery_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    index("outbox_aggregate_idx").on(table.aggregateType, table.aggregateId),
  ],
);
