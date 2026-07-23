import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const packages = sqliteTable("packages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description").notNull().default(""),
  packageType: text("package_type").notNull(),
  runtimeType: text("runtime_type").notNull(),
  runtimeUrl: text("runtime_url"),
  manifestJson: text("manifest_json").notNull(),
  permissionsJson: text("permissions_json").notNull().default("[]"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  installedAt: text("installed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const packageCapabilities = sqliteTable("package_capabilities", {
  id: text("id").primaryKey(),
  packageId: text("package_id")
    .notNull()
    .references(() => packages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  modality: text("modality").notNull(),
  contributionType: text("contribution_type").notNull(),
  inputSchemaJson: text("input_schema_json").notNull().default("{}"),
  outputSchemaJson: text("output_schema_json").notNull().default("{}"),
  uiSchemaJson: text("ui_schema_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const modelConnections = sqliteTable("model_connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull(),
  baseUrl: text("base_url").notNull(),
  modelName: text("model_name").notNull(),
  modalitiesJson: text("modalities_json").notNull(),
  credentialRef: text("credential_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  state: text("state").notNull().default("attention"),
  latencyMs: integer("latency_ms"),
  lastCheckedAt: text("last_checked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const registryEvents = sqliteTable("registry_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  entityId: text("entity_id").notNull(),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kernelRuns = sqliteTable("kernel_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("queued"),
  graphJson: text("graph_json").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kernelTasks = sqliteTable("kernel_tasks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => kernelRuns.id, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  status: text("status").notNull().default("queued"),
  dependenciesJson: text("dependencies_json").notNull().default("[]"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  executor: text("executor"),
  error: text("error"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const assetFolders = sqliteTable(
  "asset_folders",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("asset_folders_parent_id_idx").on(table.parentId)],
);

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  uri: text("uri").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  folderId: text("folder_id"),
  currentVersionId: text("current_version_id"),
  currentVersion: integer("current_version").notNull().default(1),
  versionCount: integer("version_count").notNull().default(1),
  tagsJson: text("tags_json").notNull().default("[]"),
  description: text("description").notNull().default(""),
  searchText: text("search_text").notNull().default(""),
  sourceType: text("source_type").notNull().default("upload"),
  sourceRef: text("source_ref"),
  contentHash: text("content_hash").notNull(),
  status: text("status").notNull().default("ready"),
  trashedAt: text("trashed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("assets_folder_id_idx").on(table.folderId),
  index("assets_content_hash_idx").on(table.contentHash),
]);

export const assetVersions = sqliteTable("asset_versions", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  blobKey: text("blob_key").notNull(),
  contentHash: text("content_hash").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  sourceType: text("source_type").notNull().default("upload"),
  sourceRef: text("source_ref"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("asset_versions_asset_id_idx").on(table.assetId),
  index("asset_versions_content_hash_idx").on(table.contentHash),
  uniqueIndex("asset_versions_asset_version_unique").on(
    table.assetId,
    table.version,
  ),
]);

export const assetRelations = sqliteTable("asset_relations", {
  id: text("id").primaryKey(),
  fromAssetId: text("from_asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  toAssetId: text("to_asset_id")
    .notNull()
    .references(() => assets.id, { onDelete: "cascade" }),
  relationType: text("relation_type").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("asset_relations_from_idx").on(table.fromAssetId),
  index("asset_relations_to_idx").on(table.toAssetId),
]);
