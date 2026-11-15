import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps asynchronous job schedules in the MySQL application timezone", async () => {
  const [asyncJobs, mysql] = await Promise.all([
    source("app/lib/model-async-jobs.ts"),
    source("app/lib/mysql.ts"),
  ]);

  assert.match(mysql, /date\.getTime\(\) \+ 8 \* 3600_000/);
  assert.match(
    asyncJobs,
    /function futureMysql\(milliseconds: number\) \{\s*return mysqlNow\(new Date\(Date\.now\(\) \+ milliseconds\)\);\s*\}/,
  );
});

test("does not reacquire an asynchronous job before its next poll time", async () => {
  const asyncJobs = await source("app/lib/model-async-jobs.ts");

  assert.match(
    asyncJobs,
    /AND next_poll_at IS NOT NULL\s+AND next_poll_at <= CURRENT_TIMESTAMP\(3\)/,
  );
});
