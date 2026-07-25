import { readFile } from "node:fs/promises";
import process from "node:process";
import mysql from "mysql2/promise";

const dryRun = process.argv.includes("--dry-run");
const verifyOnly = process.argv.includes("--verify");
const inspectOnly = process.argv.includes("--inspect");
const required = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing database configuration: ${missing.join(", ")}`);
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  ssl:
    process.env.DB_SSL_MODE === "disabled"
      ? undefined
      : { rejectUnauthorized: process.env.DB_SSL_MODE === "required" },
});

const migrations = [
  "0000_common_randall",
  "0001_brainy_virginia_dare",
  "0002_bizarre_meltdown",
  "0003_lively_morg",
  "0004_clever_shotgun",
  "0005_grey_peter_parker",
  "0006_unknown_havok",
  "0007_living_mole_man",
  "0008_kind_arclight",
  "0009_wealthy_magma",
  "0010_equal_layla_miller",
  "0011_dynamic_skill_model_contract",
];

async function tableExists(name) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [name],
  );
  return rows.length > 0;
}

async function normalizeTableCollation(name) {
  const [rows] = await connection.execute(
    `SELECT TABLE_COLLATION AS tableCollation
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [name],
  );
  if (rows[0]?.tableCollation === "utf8mb4_unicode_ci") return;
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`Unsafe migration table name: ${name}`);
  }
  await connection.query(
    `ALTER TABLE \`${name}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
}

async function columnExists(table, column) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

async function constraintExists(table, constraint) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?
     LIMIT 1`,
    [table, constraint],
  );
  return rows.length > 0;
}

async function indexExists(table, index) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function executeIdempotently(statement) {
  const createTable = statement.match(
    /^CREATE TABLE `([^`]+)`/i,
  );
  if (createTable) {
    if (await tableExists(createTable[1])) {
      await normalizeTableCollation(createTable[1]);
      return "skipped";
    }
    await connection.query(statement);
    await normalizeTableCollation(createTable[1]);
    return "applied";
  }

  const addConstraint = statement.match(
    /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)`/i,
  );
  if (
    addConstraint &&
    (await constraintExists(addConstraint[1], addConstraint[2]))
  ) {
    return "skipped";
  }

  const createIndex = statement.match(
    /^CREATE (?:UNIQUE )?INDEX `([^`]+)`\s+ON `([^`]+)`/i,
  );
  if (
    createIndex &&
    (await indexExists(createIndex[2], createIndex[1]))
  ) {
    return "skipped";
  }

  const addColumn = statement.match(
    /^ALTER TABLE `([^`]+)` ADD `([^`]+)`/i,
  );
  if (addColumn && (await columnExists(addColumn[1], addColumn[2]))) {
    return "skipped";
  }

  await connection.query(statement);
  return "applied";
}

async function ensureLedger() {
  await connection.execute(
    `CREATE TABLE IF NOT EXISTS xiaoluo_v2_schema_migrations (
      id VARCHAR(120) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      execution_ms INT UNSIGNED NOT NULL,
      baseline TINYINT(1) NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

async function checksum(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function migrationState() {
  const [rows] = await connection.execute(
    "SELECT id, checksum, baseline FROM xiaoluo_v2_schema_migrations",
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function verify() {
  const expectedTables = [
    "xiaoluo_v2_intent_conversations",
    "xiaoluo_v2_intent_messages",
    "xiaoluo_v2_intent_plans",
    "xiaoluo_v2_run_events",
    "xiaoluo_v2_generation_jobs",
    "xiaoluo_v2_secret_refs",
    "xiaoluo_v2_canvas_snapshots",
    "xiaoluo_v2_package_versions",
    "xiaoluo_v2_asset_collections",
    "xiaoluo_v2_user_preferences",
    "xiaoluo_v2_user_security_settings",
    "xiaoluo_v2_model_catalog_entries",
    "xiaoluo_v2_model_execution_audits",
    "xiaoluo_v2_model_usage_stats",
    "xiaoluo_v2_canvas_share_links",
    "xiaoluo_v2_rate_limit_buckets",
    "xiaoluo_v2_audit_logs",
    "xiaoluo_v2_outbox_events",
    "xiaoluo_v2_canvas_presence",
    "xiaoluo_v2_canvas_comments",
    "xiaoluo_v2_canvas_collaboration_events",
    "xiaoluo_v2_trusted_publishers",
    "xiaoluo_v2_publisher_keys",
    "xiaoluo_v2_package_reviews",
    "xiaoluo_v2_isolated_worker_jobs",
    "xiaoluo_v2_system_heartbeats",
  ];
  const absent = [];
  for (const table of expectedTables) {
    if (!(await tableExists(table))) absent.push(table);
  }
  const [columns] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
         (TABLE_NAME = 'xiaoluo_v2_kernel_runs' AND COLUMN_NAME = 'workspace_id')
         OR (TABLE_NAME = 'xiaoluo_v2_model_connections' AND COLUMN_NAME = 'secret_ref_id')
         OR (TABLE_NAME = 'xiaoluo_v2_packages' AND COLUMN_NAME = 'package_key')
         OR (TABLE_NAME = 'xiaoluo_v2_auth_sessions' AND COLUMN_NAME = 'device_name')
         OR (TABLE_NAME = 'xiaoluo_v2_auth_sessions' AND COLUMN_NAME = 'refresh_token_hash')
         OR (TABLE_NAME = 'xiaoluo_v2_users' AND COLUMN_NAME = 'username')
         OR (TABLE_NAME = 'xiaoluo_v2_model_connections' AND COLUMN_NAME = 'circuit_state')
         OR (TABLE_NAME = 'xiaoluo_v2_generation_jobs' AND COLUMN_NAME = 'poll_url')
         OR (TABLE_NAME = 'xiaoluo_v2_canvas_edges' AND COLUMN_NAME = 'source_port_id')
         OR (TABLE_NAME = 'xiaoluo_v2_canvas_edges' AND COLUMN_NAME = 'target_port_id')
         OR (TABLE_NAME = 'xiaoluo_v2_canvas_edges' AND COLUMN_NAME = 'data_type')
         OR (TABLE_NAME = 'xiaoluo_v2_audit_logs' AND COLUMN_NAME = 'request_id')
         OR (TABLE_NAME = 'xiaoluo_v2_outbox_events' AND COLUMN_NAME = 'status')
         OR (TABLE_NAME = 'xiaoluo_v2_packages' AND COLUMN_NAME = 'publisher_id')
         OR (TABLE_NAME = 'xiaoluo_v2_packages' AND COLUMN_NAME = 'review_id')
         OR (TABLE_NAME = 'xiaoluo_v2_packages' AND COLUMN_NAME = 'trust_state')
         OR (TABLE_NAME = 'xiaoluo_v2_generation_jobs' AND COLUMN_NAME = 'lease_owner')
         OR (TABLE_NAME = 'xiaoluo_v2_generation_jobs' AND COLUMN_NAME = 'lease_expires_at')
         OR (TABLE_NAME = 'xiaoluo_v2_package_capabilities' AND COLUMN_NAME = 'ports_json')
         OR (TABLE_NAME = 'xiaoluo_v2_package_capabilities' AND COLUMN_NAME = 'model_requirements_json')
         OR (TABLE_NAME = 'xiaoluo_v2_package_capabilities' AND COLUMN_NAME = 'execution_mode')
         OR (TABLE_NAME = 'xiaoluo_v2_model_connections' AND COLUMN_NAME = 'parameter_schema_json')
         OR (TABLE_NAME = 'xiaoluo_v2_model_connections' AND COLUMN_NAME = 'ui_schema_json')
         OR (TABLE_NAME = 'xiaoluo_v2_model_connections' AND COLUMN_NAME = 'capability_tags_json')
       )`,
  );
  if (absent.length || columns.length !== 24) {
    throw new Error(
      `Schema verification failed. Missing tables: ${absent.join(", ") || "none"}; key columns: ${columns.length}/24`,
    );
  }
  const [nodeKindColumns] = await connection.execute(
    `SELECT COLUMN_TYPE AS columnType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'xiaoluo_v2_canvas_nodes'
       AND COLUMN_NAME = 'kind'
     LIMIT 1`,
  );
  const nodeKindType = String(nodeKindColumns[0]?.columnType ?? "");
  if (!nodeKindType.includes("'audio'") || !nodeKindType.includes("'document'")) {
    throw new Error("Schema verification failed. Canvas node kind enum is incomplete");
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      tables: expectedTables.length,
      keyColumns: 24,
      canvasNodeKinds: 5,
    }),
  );
}

try {
  const [[migrationLock]] = await connection.query(
    "SELECT GET_LOCK('xiaoluo_v2_schema_migration', 30) AS acquired",
  );
  if (Number(migrationLock.acquired) !== 1) {
    throw new Error("Could not acquire the XiaoLuo schema migration lock");
  }
  await ensureLedger();
  if (inspectOnly) {
    const [columns] = await connection.execute(
      `SELECT TABLE_NAME AS tableName,
              COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType,
              COLLATION_NAME AS collationName
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (
           (TABLE_NAME = 'xiaoluo_v2_users' AND COLUMN_NAME = 'id')
           OR (TABLE_NAME = 'xiaoluo_v2_workspaces' AND COLUMN_NAME = 'id')
           OR (
             TABLE_NAME = 'xiaoluo_v2_asset_folders'
             AND COLUMN_NAME = 'workspace_id'
           )
         )
       ORDER BY TABLE_NAME, COLUMN_NAME`,
    );
    process.stdout.write(JSON.stringify({ columns }));
  } else if (verifyOnly) {
    await verify();
    process.exitCode = 0;
  } else {
    const applied = await migrationState();
    if (
      !applied.has("0000_common_randall") &&
      (await tableExists("xiaoluo_v2_users"))
    ) {
      const sql = await readFile(
        new URL("../drizzle/0000_common_randall.sql", import.meta.url),
        "utf8",
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_schema_migrations
          (id, checksum, execution_ms, baseline)
         VALUES (?, ?, 0, 1)`,
        ["0000_common_randall", await checksum(sql)],
      );
      applied.set("0000_common_randall", {
        id: "0000_common_randall",
        baseline: 1,
      });
    }

    const plan = [];
    for (const id of migrations) {
      const sql = await readFile(
        new URL(`../drizzle/${id}.sql`, import.meta.url),
        "utf8",
      );
      const digest = await checksum(sql);
      const known = applied.get(id);
      if (known && !known.baseline) {
        if (known.checksum && known.checksum !== digest) {
          throw new Error(`Migration checksum mismatch: ${id}`);
        }
        continue;
      }
      const statements = sql
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      plan.push({ id, digest, statements, reconcile: Boolean(known?.baseline) });
    }

    if (dryRun) {
      process.stdout.write(
        JSON.stringify({
          dryRun: true,
          pending: plan.map((item) => ({
            id: item.id,
            statements: item.statements.length,
            reconcile: item.reconcile,
          })),
        }),
      );
    } else {
      for (const migration of plan) {
        const started = Date.now();
        let appliedStatements = 0;
        let skippedStatements = 0;
        for (const statement of migration.statements) {
          const result = await executeIdempotently(statement);
          if (result === "applied") appliedStatements += 1;
          else skippedStatements += 1;
        }
        if (migration.reconcile) {
          await connection.execute(
            `UPDATE xiaoluo_v2_schema_migrations
             SET checksum = ?, execution_ms = ?, baseline = 0
             WHERE id = ?`,
            [migration.digest, Date.now() - started, migration.id],
          );
        } else {
          await connection.execute(
            `INSERT INTO xiaoluo_v2_schema_migrations
              (id, checksum, execution_ms, baseline)
             VALUES (?, ?, ?, 0)`,
            [migration.id, migration.digest, Date.now() - started],
          );
        }
        process.stdout.write(
          `${JSON.stringify({
            migration: migration.id,
            appliedStatements,
            skippedStatements,
          })}\n`,
        );
      }
      await verify();
    }
  }
} finally {
  await connection
    .query("SELECT RELEASE_LOCK('xiaoluo_v2_schema_migration')")
    .catch(() => undefined);
  await connection.end();
}
