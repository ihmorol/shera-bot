/**
 * PostgreSQL client (D24: Drizzle ORM via node-postgres). The connection
 * string is an environment reference only (G3) — never a literal.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type ControlPlaneDb = NodePgDatabase;

export function createDb(databaseUrl: string): { db: ControlPlaneDb; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  return { db: drizzle(pool), pool };
}
