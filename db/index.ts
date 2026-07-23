import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const registrySchema = [
  `CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    package_type TEXT NOT NULL,
    runtime_type TEXT NOT NULL,
    runtime_url TEXT,
    manifest_json TEXT NOT NULL,
    permissions_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS package_capabilities (
    id TEXT PRIMARY KEY NOT NULL,
    package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    modality TEXT NOT NULL,
    contribution_type TEXT NOT NULL,
    input_schema_json TEXT NOT NULL DEFAULT '{}',
    output_schema_json TEXT NOT NULL DEFAULT '{}',
    ui_schema_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS model_connections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    model_name TEXT NOT NULL,
    modalities_json TEXT NOT NULL,
    credential_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'attention',
    latency_ms INTEGER,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS registry_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS kernel_runs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    graph_json TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS kernel_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES kernel_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    dependencies_json TEXT NOT NULL DEFAULT '[]',
    input_json TEXT,
    output_json TEXT,
    executor TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS kernel_tasks_run_id_idx
    ON kernel_tasks (run_id)`,
  `CREATE TABLE IF NOT EXISTS asset_folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    uri TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    folder_id TEXT,
    current_version_id TEXT,
    current_version INTEGER NOT NULL DEFAULT 1,
    version_count INTEGER NOT NULL DEFAULT 1,
    tags_json TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'upload',
    source_ref TEXT,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    trashed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS asset_versions (
    id TEXT PRIMARY KEY NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'upload',
    source_ref TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS asset_relations (
    id TEXT PRIMARY KEY NOT NULL,
    from_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    to_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS assets_folder_id_idx ON assets (folder_id)`,
  `CREATE INDEX IF NOT EXISTS assets_content_hash_idx ON assets (content_hash)`,
  `CREATE INDEX IF NOT EXISTS asset_folders_parent_id_idx
    ON asset_folders (parent_id)`,
  `CREATE INDEX IF NOT EXISTS asset_versions_asset_id_idx
    ON asset_versions (asset_id)`,
  `CREATE INDEX IF NOT EXISTS asset_versions_content_hash_idx
    ON asset_versions (content_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS asset_versions_asset_version_unique
    ON asset_versions (asset_id, version)`,
  `CREATE INDEX IF NOT EXISTS asset_relations_from_idx
    ON asset_relations (from_asset_id)`,
  `CREATE INDEX IF NOT EXISTS asset_relations_to_idx
    ON asset_relations (to_asset_id)`,
] as const;

let schemaReady: Promise<unknown> | undefined;

export async function getDb() {
  const { env } = await import("cloudflare:workers");
  const database = env.DB;
  if (!database) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  schemaReady ??= database.batch(
    registrySchema.map((statement) => database.prepare(statement)),
  );
  await schemaReady;

  return drizzle(database, { schema });
}
