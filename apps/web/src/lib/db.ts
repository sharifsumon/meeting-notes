import "server-only";
import { createDb, type Database } from "@minuteflow/db";
import { env } from "@/env";

const globalForDb = globalThis as unknown as { db?: Database };

/** Shared database client, reused across hot reloads in dev. */
export function db(): Database {
  globalForDb.db ??= createDb(env().DATABASE_URL);
  return globalForDb.db;
}
