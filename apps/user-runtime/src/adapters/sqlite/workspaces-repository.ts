/**
 * Workspace + pack-pinning repository (S10; D19, D28) — the only place
 * workspace SQL lives.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): every method takes workspace_id
 * and every statement keys rows by it, mirroring the conversations
 * repository's contract test discipline. The workspaces table is the tenant
 * ROOT — its primary key is workspace_id alone — and carries the pack pin
 * D28 records for the prototype: one pinned pack version per workspace
 * (D19). Re-pinning (an explicit pack upgrade) updates the row; the pin that
 * a task recorded at creation lives in the task's journal payload, so an
 * upgrade here never rewrites history.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface WorkspacePackPin {
  agent_pack_id: string;
  agent_pack_version: string;
  manifest_hash: string;
  installed_at: string;
}

export interface WorkspaceRow {
  workspace_id: string;
  agent_pack_id: string | null;
  agent_pack_version: string | null;
  manifest_hash: string | null;
  installed_at: string | null;
}

export class WorkspacesRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  /** Create the workspace record if absent; idempotent (the root row). */
  ensureWorkspace(workspaceId: string, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO workspaces (workspace_id, agent_pack_id, agent_pack_version, manifest_hash, installed_at)
       VALUES (?, NULL, NULL, NULL, NULL)
       ON CONFLICT (workspace_id) DO NOTHING`,
    ).run(workspaceId);
  }

  findById(workspaceId: string, exec?: DatabaseSync): WorkspaceRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, agent_pack_id, agent_pack_version, manifest_hash, installed_at
         FROM workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ?? null;
  }

  /**
   * The workspace's pinned pack (D19/D28), or null when the workspace is
   * unpinned (the v3 CHECK constraint makes a half-pinned row impossible).
   */
  findPinnedPack(workspaceId: string, exec?: DatabaseSync): WorkspacePackPin | null {
    const row = this.findById(workspaceId, exec);
    if (row?.agent_pack_id && row.agent_pack_version && row.manifest_hash && row.installed_at) {
      return {
        agent_pack_id: row.agent_pack_id,
        agent_pack_version: row.agent_pack_version,
        manifest_hash: row.manifest_hash,
        installed_at: row.installed_at,
      };
    }
    return null;
  }

  /**
   * Record (or replace) the workspace's pack pin. First install and explicit
   * upgrades both land here — the only mutation path for the pin, so the
   * pin's provenance is this one upsert with its installed_at stamp.
   */
  pinPack(workspaceId: string, pin: WorkspacePackPin, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO workspaces (workspace_id, agent_pack_id, agent_pack_version, manifest_hash, installed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         agent_pack_id = excluded.agent_pack_id,
         agent_pack_version = excluded.agent_pack_version,
         manifest_hash = excluded.manifest_hash,
         installed_at = excluded.installed_at`,
    ).run(
      workspaceId,
      pin.agent_pack_id,
      pin.agent_pack_version,
      pin.manifest_hash,
      pin.installed_at,
    );
  }
}
