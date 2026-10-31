/**
 * Admin backup trigger service (S32, issue #33; PRD §12, §15; E11, E17).
 *
 * This slice wires the TRIGGER and the command surface. The snapshot/restore
 * MECHANISM is slice S33's (E17 recorded it: SQLite `VACUUM INTO` +
 * `PRAGMA integrity_check`, six-hour cadence, retain seven). The trigger is
 * honest by construction (G4):
 *
 * - trigger: a durable `control_backups` row with status `requested` plus a
 *   security event. The response NEVER claims a snapshot completed — S33's
 *   mechanism owns the status transition to a truthful terminal value.
 * - restore request: validates the snapshot ref against the account's
 *   recorded backups (unknown ref = typed 404), then records the request
 *   (`restore_requested` + `restored_from`) and the security event. S33
 *   performs the actual restore.
 *
 * The snapshot ref is a control-plane-generated opaque handle
 * (`snapshot_<uuid>`): the S33 mechanism resolves it to the real volume
 * snapshot; nothing here claims engine semantics.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlBackups } from "../db/schema.ts";
import { adminSnapshotNotFoundError } from "../errors.ts";

export interface AdminBackupView {
  backup_id: string;
  snapshot_ref: string;
  status: string;
  taken_at: string;
  retained_index: string | null;
}

export class AdminBackupsService {
  constructor(private readonly db: ControlPlaneDb) {}

  /** Record the backup trigger (S33's mechanism executes it). */
  async triggerBackup(accountId: string): Promise<{
    backup_id: string;
    snapshot_ref: string;
    status: string;
  }> {
    const snapshotRef = `snapshot_${randomUUID()}`;
    const inserted = await this.db
      .insert(controlBackups)
      .values({ accountId, snapshotRef, status: "requested" })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("backup insert returned no row");
    return { backup_id: row.id, snapshot_ref: row.snapshotRef, status: row.status };
  }

  /** The account's recorded backups, newest first. */
  async listBackups(accountId: string): Promise<{ backups: AdminBackupView[] }> {
    const rows = await this.db
      .select()
      .from(controlBackups)
      .where(eq(controlBackups.accountId, accountId))
      .orderBy(desc(controlBackups.takenAt))
      .limit(100);
    return {
      backups: rows.map((row) => ({
        backup_id: row.id,
        snapshot_ref: row.snapshotRef,
        status: row.status,
        taken_at: row.takenAt.toISOString(),
        retained_index: row.retainedIndex,
      })),
    };
  }

  /**
   * Record the restore REQUEST for one recorded snapshot (typed 404 on an
   * unknown ref — the seven-snapshot retention is S33's enforcement; this
   * only restores what the control plane actually recorded).
   */
  async requestRestore(
    accountId: string,
    snapshotRef: string,
  ): Promise<{
    snapshot_ref: string;
    status: string;
  }> {
    const rows = await this.db
      .select()
      .from(controlBackups)
      .where(
        and(eq(controlBackups.accountId, accountId), eq(controlBackups.snapshotRef, snapshotRef)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw adminSnapshotNotFoundError();
    }
    await this.db
      .update(controlBackups)
      .set({ status: "restore_requested", restoredFrom: snapshotRef })
      .where(eq(controlBackups.id, row.id));
    return { snapshot_ref: row.snapshotRef, status: "restore_requested" };
  }
}
