import { drizzle } from "drizzle-orm/mysql2";
import { getMysqlPool } from "../app/lib/mysql";
import * as schema from "./schema";

export async function getDb() {
  return drizzle(await getMysqlPool(), { schema, mode: "default" });
}
