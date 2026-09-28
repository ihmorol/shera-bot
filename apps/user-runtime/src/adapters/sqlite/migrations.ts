/**
 * Committed migration chain for the container-local SQLite database (S07).
 *
 * Mirrors the control-plane discipline (D24): migrations are committed,
 * reviewed SQL applied by a single runner — schema push is never used. Each
 * entry appends a version; the runner records applied versions in
 * schema_migrations and is safe to call on any prior state (idempotent).
 *
 * v1 — append-only event journal + the conversations aggregate. BOTH tables
 * carry workspace_id from day one (E12): every row is tenant-scoped at the
 * storage layer, not only at the API layer.
 */
import type { DatabaseSync } from "node:sqlite";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    name: "event-journal-and-conversations",
    sql: `
      CREATE TABLE IF NOT EXISTS event_journal (
        stream_id      TEXT    NOT NULL,
        sequence       INTEGER NOT NULL CHECK (sequence >= 1),
        event_id       TEXT    NOT NULL,
        event_type     TEXT    NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        payload        TEXT    NOT NULL,
        workspace_id   TEXT    NOT NULL,
        occurred_at    TEXT    NOT NULL,
        correlation_id TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, stream_id, sequence),
        UNIQUE (event_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS event_journal_workspace_idx
        ON event_journal (workspace_id, stream_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id           TEXT    NOT NULL,
        workspace_id TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        revision     INTEGER NOT NULL CHECK (revision >= 1),
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        PRIMARY KEY (workspace_id, id)
      ) STRICT;
    `,
  },
];

export function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (
      db.prepare("SELECT version FROM schema_migrations").all() as { version: number | bigint }[]
    ).map((row) => (typeof row.version === "bigint" ? Number(row.version) : row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite; the
        // original error below is the one that matters.
      }
      throw error;
    }
  }
}
