/**
 * Migration runner (D24): committed, reviewed SQL migrations under
 * drizzle/ are applied with the Drizzle migrator. Schema push is never used.
 *
 * The migration chain is versioned: v1 is the S05 empty-baseline schema; every
 * later slice appends vN and the vN-1 → vN test seeds the previous released
 * state (pg_dump restore) before running this runner. The runner is a single
 * function so those tests can call it against any database state.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { ControlPlaneDb } from "./client.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_FOLDER = join(thisDir, "..", "..", "drizzle");

export async function runMigrations(db: ControlPlaneDb): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
