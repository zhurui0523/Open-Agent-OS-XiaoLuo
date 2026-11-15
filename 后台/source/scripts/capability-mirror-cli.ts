// CAPABILITY-MIRROR 灾备 CLI（tsx 直跑）：
//   npx tsx --env-file=.env.local scripts/capability-mirror-cli.ts export   立即把 9 张能力表快照写入 OSS
//   npx tsx --env-file=.env.local scripts/capability-mirror-cli.ts show     查看 OSS 上快照的表/行数
//   npx tsx --env-file=.env.local scripts/capability-mirror-cli.ts import --yes
//                                                                          清空本地 9 张表并按 OSS 快照恢复（破坏性）
import {
  exportCapabilityMirror,
  importCapabilityMirror,
} from "../app/lib/capability-mirror";
import { getFileBucket } from "../app/lib/asset-kernel";

const TABLES = [
  "trustedPublishers",
  "packageReviews",
  "packages",
  "packageVersions",
  "packageCapabilities",
  "packageAvailabilities",
  "workflowListings",
  "workflowVersions",
  "workflowInstallations",
];

const command = process.argv[2] ?? "show";

async function show() {
  const bucket = await getFileBucket();
  for (const table of TABLES) {
    const object = await bucket.get(`caps/mirror/${table}.json`);
    if (!object?.body) {
      console.log(`${table.padEnd(24)} MISSING`);
      continue;
    }
    const text = await new Response(object.body).text();
    const rows = JSON.parse(text) as unknown[];
    console.log(`${table.padEnd(24)} rows=${Array.isArray(rows) ? rows.length : "?"} bytes=${text.length}`);
  }
}

if (command === "export") {
  const result = await exportCapabilityMirror();
  console.log("exported tables:", result.tables.join(", "));
  if (result.failed.length) {
    console.error("failed:", result.failed.join(" | "));
    process.exit(1);
  }
  await show();
  process.exit(0);
} else if (command === "import") {
  if (process.argv[3] !== "--yes") {
    console.error("import 会清空本地 9 张能力表并按 OSS 快照恢复；确认请追加 --yes");
    process.exit(1);
  }
  const restored = await importCapabilityMirror();
  console.log("restored:", JSON.stringify(restored));
  process.exit(0);
} else if (command === "show") {
  await show();
  process.exit(0);
} else {
  console.error("unknown command: " + command);
  process.exit(1);
}
