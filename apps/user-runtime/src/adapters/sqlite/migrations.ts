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
 * storage layer, not only at the API layer. The journal's primary key is
 * (workspace_id, stream_id, sequence): streams live INSIDE workspaces, so the
 * same aggregate id in two workspaces never collides (AC3). event_id
 * uniqueness is workspace-scoped too — UNIQUE (workspace_id, event_id), so
 * the same event id in two workspaces are independent rows (E12) and the
 * idempotent no-op for a repeated event_id can only ever match a row the
 * SAME workspace wrote (C-3; schema not shipped anywhere — branch unmerged,
 * edited in place per the committed-migration discipline).
 *
 * v2 — command receipts (D23 rule 6): one row per accepted command keyed by
 * (workspace_id, idempotency_key), recorded in the SAME transaction as the
 * command's effects, so a repeated key replays the recorded result instead of
 * duplicating effects.
 *
 * v3 — workspace pack pinning (S10; D19, D28): the workspace record gains the
 * pin columns D28 names for the prototype — agent_pack_id, agent_pack_version,
 * manifest_hash, installed_at. One pinned pack version per workspace (D19):
 * a task is permanently associated with the version pinned at its creation
 * (the task.created journal payload carries the creation-time snapshot), so a
 * pack upgrade affects NEW tasks only. The four pin columns are either all
 * set (pinned) or all NULL (a workspace exists but no pack is installed yet);
 * a half-pinned row is unrepresentable. This is the first table keyed by
 * workspace_id ALONE — a workspace is the tenant root, not a child record;
 * every other product-state table keeps the (workspace_id, id) scoping (E12).
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
        UNIQUE (workspace_id, event_id)
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
  {
    version: 2,
    name: "command-receipts",
    sql: `
      CREATE TABLE IF NOT EXISTS command_receipts (
        workspace_id    TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_type    TEXT NOT NULL,
        result_json     TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (workspace_id, idempotency_key)
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "workspace-pack-pinning",
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id       TEXT NOT NULL PRIMARY KEY,
        agent_pack_id      TEXT,
        agent_pack_version TEXT,
        manifest_hash      TEXT,
        installed_at       TEXT,
        CHECK (
          (
            agent_pack_id IS NULL
            AND agent_pack_version IS NULL
            AND manifest_hash IS NULL
            AND installed_at IS NULL
          )
          OR
          (
            agent_pack_id IS NOT NULL
            AND agent_pack_version IS NOT NULL
            AND manifest_hash IS NOT NULL
            AND installed_at IS NOT NULL
          )
        )
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
