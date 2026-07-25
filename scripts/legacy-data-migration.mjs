import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import mysql from "mysql2/promise";
import OSS from "ali-oss";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const verify = args.includes("--verify");
const manifestFlag = args.indexOf("--manifest");
const manifestPath =
  manifestFlag >= 0
    ? args[manifestFlag + 1]
    : process.env.LEGACY_MIGRATION_MANIFEST;
if (!manifestPath) {
  throw new Error(
    "Use --manifest <path> or LEGACY_MIGRATION_MANIFEST to select a migration manifest.",
  );
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.entities)) {
  throw new Error("Legacy migration manifest must use schemaVersion 1 or 2.");
}

const identifier = /^[A-Za-z0-9_]+$/;
function safeIdentifier(value, label) {
  if (typeof value !== "string" || !identifier.test(value)) {
    throw new Error(`Unsafe ${label}: ${String(value)}`);
  }
  return `\`${value}\``;
}

function config(prefix, fallback = {}) {
  const required = ["HOST", "PORT", "USER", "PASSWORD", "NAME"];
  const values = Object.fromEntries(
    required.map((key) => [
      key,
      process.env[`${prefix}_${key}`] ?? fallback[key],
    ]),
  );
  const missing = required.filter((key) => !values[key]);
  if (missing.length) {
    throw new Error(
      `Missing ${prefix} configuration: ${missing
        .map((key) => `${prefix}_${key}`)
        .join(", ")}`,
    );
  }
  return {
    host: values.HOST,
    port: Number(values.PORT),
    user: values.USER,
    password: values.PASSWORD,
    database: values.NAME,
    charset: "utf8mb4",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ssl:
      process.env[`${prefix}_SSL_MODE`] === "disabled"
        ? undefined
        : {
            rejectUnauthorized:
              process.env[`${prefix}_SSL_MODE`] === "required",
          },
  };
}

const targetFallback = {
  HOST: process.env.DB_HOST,
  PORT: process.env.DB_PORT,
  USER: process.env.DB_USER,
  PASSWORD: process.env.DB_PASSWORD,
  NAME: process.env.DB_NAME,
};
const source = await mysql.createConnection(config("LEGACY_DB"));
const target = await mysql.createConnection(config("DB", targetFallback));
const chunkSize = Math.max(
  100,
  Math.min(2_000, Number(process.env.LEGACY_MIGRATION_CHUNK_SIZE ?? 500)),
);

function ossConfig(prefix) {
  const values = {
    region: process.env[`${prefix}_REGION`],
    accessKeyId: process.env[`${prefix}_ACCESS_KEY_ID`],
    accessKeySecret: process.env[`${prefix}_ACCESS_KEY_SECRET`],
    bucket: process.env[`${prefix}_BUCKET`],
    endpoint: process.env[`${prefix}_ENDPOINT`],
  };
  const missing = Object.entries(values)
    .filter(([key, value]) => key !== "endpoint" && !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing ${prefix} OSS configuration: ${missing.join(", ")}`);
  }
  return new OSS({
    region: values.region,
    accessKeyId: values.accessKeyId,
    accessKeySecret: values.accessKeySecret,
    bucket: values.bucket,
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
    secure: true,
  });
}

async function listOss(client, prefix) {
  const objects = [];
  let marker;
  do {
    const page = await client.list({ prefix, marker, "max-keys": 1000 });
    for (const object of page.objects ?? []) {
      objects.push({
        name: object.name,
        size: Number(object.size ?? 0),
        etag: String(object.etag ?? "").replaceAll('"', ""),
      });
    }
    marker = page.nextMarker;
  } while (marker);
  return objects;
}

async function migrateObjects(specification) {
  const sourceClient = ossConfig("LEGACY_OSS");
  const targetClient = ossConfig("OSS");
  const sourcePrefix = String(specification.sourcePrefix ?? "");
  const targetPrefix = String(specification.targetPrefix ?? "");
  const sourceObjects = await listOss(sourceClient, sourcePrefix);
  let targetObjects = await listOss(targetClient, targetPrefix);
  const targetByName = new Map(targetObjects.map((object) => [object.name, object]));
  const expectedTargetName = (name) =>
    `${targetPrefix}${name.slice(sourcePrefix.length)}`;
  const beforeMissing = sourceObjects.filter((object) => {
    const targetObject = targetByName.get(expectedTargetName(object.name));
    return !targetObject || targetObject.size !== object.size || targetObject.etag !== object.etag;
  });
  let copied = 0;
  if (apply && specification.copy === true) {
    for (const object of beforeMissing) {
      const sourceStream = await sourceClient.getStream(object.name);
      await targetClient.put(expectedTargetName(object.name), sourceStream.stream);
      copied += 1;
    }
    targetObjects = await listOss(targetClient, targetPrefix);
  }
  const finalTargetByName = new Map(targetObjects.map((object) => [object.name, object]));
  const missing = sourceObjects.filter((object) => {
    const targetObject = finalTargetByName.get(expectedTargetName(object.name));
    return !targetObject || targetObject.size !== object.size || targetObject.etag !== object.etag;
  });
  const expectedNames = new Set(sourceObjects.map((object) => expectedTargetName(object.name)));
  const orphaned = targetObjects.filter((object) => !expectedNames.has(object.name));
  const digest = (objects) => {
    const hash = createHash("sha256");
    for (const object of [...objects].sort((first, second) => first.name.localeCompare(second.name))) {
      hash.update(`${object.name}\0${object.size}\0${object.etag}\n`);
    }
    return hash.digest("hex");
  };
  return {
    id: specification.id ?? "legacy-oss",
    source: { count: sourceObjects.length, fingerprint: digest(sourceObjects) },
    target: { count: targetObjects.length, fingerprint: digest(targetObjects) },
    copied,
    missing: missing.map((object) => object.name),
    orphaned: orphaned.map((object) => object.name),
    matched: missing.length === 0,
  };
}

function canonicalRow(row, columns) {
  return JSON.stringify(
    Object.fromEntries(
      columns.map((column) => [
        column,
        row[column] instanceof Date
          ? row[column].toISOString()
          : row[column] ?? null,
      ]),
    ),
  );
}

function validateEntity(entity) {
  if (
    !entity ||
    typeof entity.id !== "string" ||
    !entity.source ||
    !entity.target ||
    !entity.columnMap ||
    typeof entity.columnMap !== "object"
  ) {
    throw new Error("Every entity needs id, source, target, and columnMap.");
  }
  safeIdentifier(entity.source.table, "source table");
  safeIdentifier(entity.target.table, "target table");
  safeIdentifier(entity.source.key, "source key");
  safeIdentifier(entity.target.key, "target key");
  const pairs = Object.entries(entity.columnMap);
  if (!pairs.length) throw new Error(`${entity.id} has no column mappings.`);
  for (const [sourceColumn, targetColumn] of pairs) {
    safeIdentifier(sourceColumn, "source column");
    safeIdentifier(targetColumn, "target column");
  }
  if (
    entity.columnMap[entity.source.key] !== entity.target.key
  ) {
    throw new Error(`${entity.id} must map the source key to the target key.`);
  }
  return pairs;
}

async function readSourceChunk(entity, pairs, cursor) {
  const sourceTable = safeIdentifier(entity.source.table, "source table");
  const sourceKey = safeIdentifier(entity.source.key, "source key");
  const select = pairs
    .map(
      ([sourceColumn, targetColumn]) =>
        `${safeIdentifier(sourceColumn, "source column")} AS ${safeIdentifier(
          targetColumn,
          "target alias",
        )}`,
    )
    .join(", ");
  const [rows] = await source.execute(
    `SELECT ${select} FROM ${sourceTable}
     ${cursor === null ? "" : `WHERE ${sourceKey} > ?`}
     ORDER BY ${sourceKey}
     LIMIT ${chunkSize}`,
    cursor === null ? [] : [cursor],
  );
  return rows;
}

async function digestSource(entity, pairs) {
  const targetColumns = pairs.map(([, targetColumn]) => targetColumn);
  const targetKey = entity.target.key;
  const hash = createHash("sha256");
  let count = 0;
  let cursor = null;
  while (true) {
    const rows = await readSourceChunk(entity, pairs, cursor);
    if (!rows.length) break;
    for (const row of rows) {
      hash.update(canonicalRow(row, targetColumns));
      hash.update("\n");
    }
    count += rows.length;
    cursor = rows.at(-1)[targetKey];
    if (rows.length < chunkSize) break;
  }
  return { count, sha256: hash.digest("hex") };
}

async function digestTarget(entity, pairs) {
  const targetTable = safeIdentifier(entity.target.table, "target table");
  const targetKey = safeIdentifier(entity.target.key, "target key");
  const targetColumns = pairs.map(([, targetColumn]) => targetColumn);
  const select = targetColumns
    .map((column) => safeIdentifier(column, "target column"))
    .join(", ");
  const hash = createHash("sha256");
  let count = 0;
  let cursor = null;
  while (true) {
    const [rows] = await target.execute(
      `SELECT ${select} FROM ${targetTable}
       ${cursor === null ? "" : `WHERE ${targetKey} > ?`}
       ORDER BY ${targetKey}
       LIMIT ${chunkSize}`,
      cursor === null ? [] : [cursor],
    );
    if (!rows.length) break;
    for (const row of rows) {
      hash.update(canonicalRow(row, targetColumns));
      hash.update("\n");
    }
    count += rows.length;
    cursor = rows.at(-1)[entity.target.key];
    if (rows.length < chunkSize) break;
  }
  return { count, sha256: hash.digest("hex") };
}

async function applyEntity(entity, pairs) {
  if (entity.copy !== true) return { inserted: 0, skipped: true };
  const table = safeIdentifier(entity.target.table, "target table");
  const columns = pairs.map(([, targetColumn]) => targetColumn);
  const quotedColumns = columns
    .map((column) => safeIdentifier(column, "target column"))
    .join(", ");
  const key = safeIdentifier(entity.target.key, "target key");
  let cursor = null;
  let inserted = 0;
  while (true) {
    const rows = await readSourceChunk(entity, pairs, cursor);
    if (!rows.length) break;
    const values = rows.flatMap((row) => columns.map((column) => row[column]));
    const placeholders = rows
      .map(() => `(${columns.map(() => "?").join(",")})`)
      .join(",");
    await target.beginTransaction();
    try {
      const [result] = await target.execute(
        `INSERT INTO ${table} (${quotedColumns}) VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE ${key} = ${key}`,
        values,
      );
      inserted += result.affectedRows;
      await target.commit();
    } catch (error) {
      await target.rollback();
      throw error;
    }
    cursor = rows.at(-1)[entity.target.key];
    if (rows.length < chunkSize) break;
  }
  return { inserted, skipped: false };
}

const report = {
  mode: apply ? "apply" : verify ? "verify" : "dry-run",
  manifest: manifestPath,
  startedAt: new Date().toISOString(),
  entities: [],
  objects: [],
};

try {
  for (const entity of manifest.entities) {
    const pairs = validateEntity(entity);
    const before = {
      source: await digestSource(entity, pairs),
      target: await digestTarget(entity, pairs),
    };
    if (
      Number.isInteger(entity.expectedSourceCount) &&
      before.source.count !== entity.expectedSourceCount
    ) {
      throw new Error(
        `${entity.id}: source count ${before.source.count} does not match expected ${entity.expectedSourceCount}.`,
      );
    }
    const mutation = apply
      ? await applyEntity(entity, pairs)
      : { inserted: 0, skipped: true };
    const after = apply
      ? {
          source: before.source,
          target: await digestTarget(entity, pairs),
        }
      : before;
    const matched =
      after.source.count === after.target.count &&
      after.source.sha256 === after.target.sha256;
    report.entities.push({
      id: entity.id,
      copyEnabled: entity.copy === true,
      before,
      mutation,
      after,
      matched,
    });
    if ((apply || verify) && !matched) {
      throw new Error(`${entity.id}: golden-data comparison failed.`);
    }
  }
  for (const specification of manifest.objects ?? []) {
    const objectReport = await migrateObjects(specification);
    report.objects.push(objectReport);
    if ((apply || verify) && !objectReport.matched) {
      throw new Error(`${objectReport.id}: OSS inventory comparison failed.`);
    }
  }
  report.ok = true;
  report.completedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : "unknown";
  report.completedAt = new Date().toISOString();
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([source.end(), target.end()]);
}
