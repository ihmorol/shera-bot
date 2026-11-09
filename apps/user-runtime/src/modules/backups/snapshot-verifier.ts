/**
 * The snapshot verifier (S33 chunk 3; issue #34; DEV_WORKFLOW Stage 8, E11,
 * G3/G4): the SCHEDULED check that a stored snapshot still verifies — at
 * minimum the recorded integrity statement over the live snapshot file,
 * which is exactly what this runs, over the WHOLE retained window (bounded
 * at seven by the retention rule, so the check is bounded by construction).
 *
 * THE ALERT PATH: a failed check raises the alert — the bounded reason rides
 * the snapshot's ledger row (the admin list surfaces it) and a redacted
 * fault line is recorded. A later HEALTHY verification clears the alert: an
 * environmental failure (a locked file, a hiccup) must not block a restore
 * forever, and real corruption keeps failing every check. The
 * restore-candidate policy (assertRestorableRow) refuses any row whose
 * latest verification state is not clean — a corrupt snapshot can never be
 * restored.
 */
import { join } from "node:path";

import type { BackupSnapshotRow } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import type { BackupSnapshotLedger } from "./backup-service.ts";

export type VerifyOutcome =
  | { verified: true; snapshot_id: string }
  | { verified: false; snapshot_id: string; detail: string };

export interface SnapshotVerifierDeps {
  workspaceId: string;
  /** The recorded verification helper: the integrity statement over a file. */
  verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  snapshots: BackupSnapshotLedger;
  now?: (() => string) | undefined;
  /** The redacted fault sink (the alert's log leg, G3). */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export class SnapshotVerifier {
  private readonly workspaceId: string;
  private readonly verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  private readonly snapshots: BackupSnapshotLedger;
  private readonly now: () => string;
  private readonly logFault: (event: string, fields: Record<string, unknown>) => void;

  constructor(deps: SnapshotVerifierDeps) {
    this.workspaceId = deps.workspaceId;
    this.verifyDatabaseCopy = deps.verifyDatabaseCopy;
    this.snapshots = deps.snapshots;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.logFault = deps.logFault ?? (() => {});
  }

  /** Verify ONE stored snapshot (the file the row points at). A failure
   * raises the alert on the row; a success after a failure clears it. */
  verifySnapshot(row: BackupSnapshotRow): VerifyOutcome {
    const result = this.verifyDatabaseCopy(join(row.snapshot_dir, "runtime.db"));
    if (!result.ok) {
      const detail = result.message.slice(0, 300);
      this.snapshots.markAlert(this.workspaceId, row.snapshot_id, detail);
      this.logFault("backup_snapshot_corrupt", {
        snapshot_id: row.snapshot_id,
        taken_at: row.taken_at,
        reason: detail,
        detected_at: this.now(),
      });
      return { verified: false, snapshot_id: row.snapshot_id, detail };
    }
    // A healthy check clears a stale alert (an environmental failure must
    // not block a restore forever — real corruption re-fails every check).
    if (row.alert !== null) {
      this.snapshots.clearAlert(this.workspaceId, row.snapshot_id);
    }
    return { verified: true, snapshot_id: row.snapshot_id };
  }

  /** Verify the whole retained window, newest first. */
  verifyRetainedWindow(): VerifyOutcome[] {
    const rows = this.snapshots.listNewestFirst(this.workspaceId);
    return rows.map((row) => this.verifySnapshot(row));
  }
}
