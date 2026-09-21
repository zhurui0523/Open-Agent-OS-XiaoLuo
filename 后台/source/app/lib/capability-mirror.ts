import { getDb } from "../../db";
import {
  packageAvailabilities,
  packageCapabilities,
  packageReviews,
  packages,
  packageVersions,
  trustedPublishers,
  workflowInstallations,
  workflowListings,
  workflowVersions,
} from "../../db/schema";
import { getFileBucket } from "./asset-kernel";

/**
 * CAPABILITY-MIRROR：能力中心（Skill/插件/Workflow）行级镜像到远程 OSS。
 * OSS 是内容的事实源与灾备源；MySQL 只是可重建的索引/查询层。
 * 任何能力变更 debounce 3s 后把 9 张表的活行整表快照写入 caps/mirror/<table>.json；
 * 机器丢失后用 scripts/capability-mirror-cli.ts import 从 OSS 原样恢复。
 */

const MIRROR_PREFIX = "caps/mirror/";

/** 导入按外键父→子；导出整表覆盖与顺序无关 */
const IMPORT_ORDER = [
  "trustedPublishers",
  "packageReviews",
  "packages",
  "packageVersions",
  "packageCapabilities",
  "packageAvailabilities",
  "workflowListings",
  "workflowVersions",
  "workflowInstallations",
] as const;

/** 清空顺序：子→父，避免外键拦截 */
const WIPE_ORDER = [
  "packageAvailabilities",
  "packageCapabilities",
  "packageVersions",
  "workflowInstallations",
  "workflowVersions",
  "workflowListings",
  "packages",
  "packageReviews",
  "trustedPublishers",
] as const;

type MirrorTable = (typeof IMPORT_ORDER)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLES: Record<MirrorTable, any> = {
  trustedPublishers,
  packageReviews,
  packages,
  packageVersions,
  packageCapabilities,
  packageAvailabilities,
  workflowListings,
  workflowVersions,
  workflowInstallations,
};

function mirrorKey(table: MirrorTable): string {
  return `${MIRROR_PREFIX}${table}.json`;
}

/** timestamp 列序列化后的 ISO 串 → 导入时还原成 Date */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function reviveDates(value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE.test(value)) return new Date(value);
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = reviveDates(item);
    }
    return out;
  }
  return value;
}

/** 整表快照写入 OSS；单表失败不阻断其余表（记日志，下次 debounce 再补） */
export async function exportCapabilityMirror(): Promise<{
  tables: string[];
  failed: string[];
}> {
  const db = await getDb();
  const bucket = await getFileBucket();
  const tables: string[] = [];
  const failed: string[] = [];
  for (const name of IMPORT_ORDER) {
    try {
      const rows = await db.select().from(TABLES[name]);
      await bucket.put(
        mirrorKey(name),
        new TextEncoder().encode(JSON.stringify(rows)),
        { httpMetadata: { contentType: "application/json" } },
      );
      tables.push(name);
    } catch (error) {
      console.error(`[capability-mirror] 表 ${name} 快照失败:`, error);
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tables, failed };
}

let mirrorTimer: ReturnType<typeof setTimeout> | null = null;

/** 变更钩子：debounce 3s 合并连续写，fire-and-forget 不阻塞业务请求 */
export function scheduleCapabilityMirrorExport(): void {
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    exportCapabilityMirror()
      .then((result) => {
        // 单表失败（多为瞬时锁等待/连接抖动）5s 后整体重试一次，仍失败留给下次变更或 CLI export
        if (result.failed.length) {
          setTimeout(() => {
            exportCapabilityMirror()
              .then((retry) => {
                if (retry.failed.length) {
                  console.error("[capability-mirror] 重试后仍失败:", retry.failed.join(" | "));
                }
              })
              .catch((error) => console.error("[capability-mirror] 重试导出失败:", error));
          }, 5_000).unref?.();
        }
      })
      .catch((error) => console.error("[capability-mirror] export failed:", error));
  }, 3_000);
  mirrorTimer.unref?.();
}

/** 灾备恢复：清空 9 张表后按 OSS 快照原样插回；返回每表恢复行数 */
export async function importCapabilityMirror(): Promise<Record<string, number>> {
  const db = await getDb();
  const bucket = await getFileBucket();
  const payload: Partial<Record<MirrorTable, unknown[]>> = {};
  for (const name of IMPORT_ORDER) {
    const object = await bucket.get(mirrorKey(name));
    if (!object?.body) continue;
    const text = await new Response(object.body).text();
    const rows = reviveDates(JSON.parse(text)) as unknown[];
    if (Array.isArray(rows)) payload[name] = rows;
  }
  for (const name of WIPE_ORDER) {
    await db.delete(TABLES[name]);
  }
  const restored: Record<string, number> = {};
  for (const name of IMPORT_ORDER) {
    const rows = payload[name];
    if (!rows?.length) {
      restored[name] = 0;
      continue;
    }
    await db.insert(TABLES[name]).values(rows as never);
    restored[name] = rows.length;
  }
  return restored;
}

/** 能力内容对象键：包体文件 / 清单 / 文件清单索引 */
export function packageContentPrefix(packageKey: string, version: string): string {
  return `caps/packages/${packageKey}/${version}/`;
}

export function packageFilesIndexKey(packageKey: string, version: string): string {
  return `${packageContentPrefix(packageKey, version)}files-index.json`;
}
