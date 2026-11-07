/**
 * Backup-snapshot ledger repository (S33 chunk 1; PRD §12, E11, E12, D23
 * rule 2) — the only place backup-snapshot SQL lives.
 *
 * One STRICT table (v22, `backup_snapshots`): the runtime's durable record
 * of every snapshot it has taken and still holds. The ledger only ever holds
 * RESTORABLE snapshots (integrity ok): a copy that fails the snapshot-time
 * verification is refused at birth — its evidence lives in the redacted
 * fault log and the typed result, never as a phantom restorable row.
 *
 * Writer-side rules enforced here: workspace scoping as the primary-key
 * prefix (E12 — one container's ledger never collides with another's), the
 * checked vocabularies (`triggered_by` / `integrity_status` / `volume_kind`)
 * that make a misrecorded row unrepresentable at the storage layer, a typed
 * duplicate refusal for a repeated snapshot id, and bounded text columns
 * (the alert reason is bounded at 300 characters — a failure detail, never a
 * log dump, G3).
 */
import type { SqliteExec, SqliteTransactions } from "./transactions.ts";

/** What started the snapshot (the recorded vocabulary). */
export type BackupTriggeredBy = "schedule" | "admin";

/** The snapshot-time verification outcome (E11: verified at snapshot time). */
export type BackupIntegrityStatus = "ok" | "failed";

/** The volume-snapshot backend that captured the workspace volume. */
export type BackupVolumeKind = "copy" | "restic";

export type BackupSnapshotFailureCode =
  "DUPLICATE_SNAPSHOT_ID" | "SNAPSHOT_NOT_FOUND" | "INVALID_SNAPSHOT";

export class BackupSnapshotError extends Error {
  readonly code: BackupSnapshotFailureCode;
  readonly category: "conflict" | "validation" | "state";

  constructor(code: BackupSnapshotFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BackupSnapshotError";
    this.code = code;
    this.category =
      code === "DUPLICATE_SNAPSHOT_ID"
        ? "conflict"
        : code === "SNAPSHOT_NOT_FOUND"
          ? "state"
          : "validation";
  }
}

export interface BackupSnapshotInsert {
  workspace_id: string;
  snapshot_id: string;
  taken_at: string;
  triggered_by: BackupTriggeredBy;
  db_bytes: number;
  integrity_status: BackupIntegrityStatus;
  volume_kind: BackupVolumeKind;
  snapshot_dir: string;
}

export interface BackupSnapshotRow extends BackupSnapshotInsert {
  /** Position in the retention window (1 = newest). Null until retention ran. */
  retained_index: number | null;
  /** The bounded refusal/failure reason when a verify or restore refused
   * this snapshot (the alert rides the row; set by markAlert). */
  alert: string | null;
  /** When this snapshot was restored (null until a restore used it). */
  restored_at: string | null;
}

export class BackupSnapshotsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  private db(exec?: SqliteExec): SqliteExec {
    return exec ?? this.tx.connection();
  }

  /** Record one snapshot. A repeated id in the SAME workspace is a typed
   * duplicate refusal (the control-plane ref is unique; a replayed execute
   * never overwrites a snapshot). */
  record(input: BackupSnapshotInsert, exec?: SqliteExec): void {
    try {
      this.db(exec)
        .prepare(
          `INSERT INTO backup_snapshots
             (workspace_id, snapshot_id, taken_at, triggered_by, db_bytes,
              integrity_status, volume_kind, snapshot_dir, retained_index, alert, restored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          input.workspace_id,
          input.snapshot_id,
          input.taken_at,
          input.triggered_by,
          input.db_bytes,
          input.integrity_status,
          input.volume_kind,
          input.snapshot_dir,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BackupSnapshotError(
          "DUPLICATE_SNAPSHOT_ID",
          `snapshot ${input.snapshot_id} already exists in this workspace`,
        );
      }
      throw new BackupSnapshotError(
        "INVALID_SNAPSHOT",
        error instanceof Error ? error.message.slice(0, 300) : "the snapshot record was refused",
      );
    }
  }

  /** One snapshot row, or null. */
  get(workspaceId: string, snapshotId: string, exec?: SqliteExec): BackupSnapshotRow | null {
    const row = this.db(exec)
      .prepare(
        `SELECT workspace_id, snapshot_id, taken_at, triggered_by, db_bytes,
                integrity_status, volume_kind, snapshot_dir, retained_index, alert, restored_at
         FROM backup_snapshots WHERE workspace_id = ? AND snapshot_id = ?`,
      )
      .get(workspaceId, snapshotId) as BackupSnapshotRow | undefined;
    return row ?? null;
  }

  /** One snapshot row, or the typed not-found error. */
  require(workspaceId: string, snapshotId: string, exec?: SqliteExec): BackupSnapshotRow {
    const row = this.get(workspaceId, snapshotId, exec);
    if (!row) {
      throw new BackupSnapshotError(
        "SNAPSHOT_NOT_FOUND",
        `snapshot ${snapshotId} does not exist in this workspace`,
      );
    }
    return row;
  }

  /** The workspace's snapshots, newest-taken first (the retention scan's
   * survivor order and the admin list's order). */
  listNewestFirst(workspaceId: string, exec?: SqliteExec): BackupSnapshotRow[] {
    return this.db(exec)
      .prepare(
        `SELECT workspace_id, snapshot_id, taken_at, triggered_by, db_bytes,
                integrity_status, volume_kind, snapshot_dir, retained_index, alert, restored_at
         FROM backup_snapshots WHERE workspace_id = ?
         ORDER BY taken_at DESC, snapshot_id DESC`,
      )
      .all(workspaceId) as unknown as BackupSnapshotRow[];
  }

  /** The workspace's snapshots, oldest-taken first (the prune order). */
  listOldestFirst(workspaceId: string, exec?: SqliteExec): BackupSnapshotRow[] {
    return this.db(exec)
      .prepare(
        `SELECT workspace_id, snapshot_id, taken_at, triggered_by, db_bytes,
                integrity_status, volume_kind, snapshot_dir, retained_index, alert, restored_at
         FROM backup_snapshots WHERE workspace_id = ?
         ORDER BY taken_at ASC, snapshot_id ASC`,
      )
      .all(workspaceId) as unknown as BackupSnapshotRow[];
  }

  /** Set (or clear) the retention index on one snapshot. */
  setRetainedIndex(
    workspaceId: string,
    snapshotId: string,
    retainedIndex: number | null,
    exec?: SqliteExec,
  ): void {
    this.require(workspaceId, snapshotId, exec);
    this.db(exec)
      .prepare(
        `UPDATE backup_snapshots SET retained_index = ?
         WHERE workspace_id = ? AND snapshot_id = ?`,
      )
      .run(retainedIndex, workspaceId, snapshotId);
  }

  /** Record the bounded alert reason on one snapshot (the corrupted-
   * snapshot refusal rides the row the operator can list). */
  markAlert(workspaceId: string, snapshotId: string, alert: string, exec?: SqliteExec): void {
    this.require(workspaceId, snapshotId, exec);
    this.db(exec)
      .prepare(`UPDATE backup_snapshots SET alert = ? WHERE workspace_id = ? AND snapshot_id = ?`)
      .run(alert.slice(0, 300), workspaceId, snapshotId);
  }

  /** Record when this snapshot was restored. */
  markRestored(
    workspaceId: string,
    snapshotId: string,
    restoredAt: string,
    exec?: SqliteExec,
  ): void {
    this.require(workspaceId, snapshotId, exec);
    this.db(exec)
      .prepare(
        `UPDATE backup_snapshots SET restored_at = ? WHERE workspace_id = ? AND snapshot_id = ?`,
      )
      .run(restoredAt, workspaceId, snapshotId);
  }

  /** Remove one snapshot row (the retention prune's ledger leg). Returns
   * whether a row was removed. */
  delete(workspaceId: string, snapshotId: string, exec?: SqliteExec): boolean {
    const result = this.db(exec)
      .prepare(`DELETE FROM backup_snapshots WHERE workspace_id = ? AND snapshot_id = ?`)
      .run(workspaceId, snapshotId);
    return result.changes > 0;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
