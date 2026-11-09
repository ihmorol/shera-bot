/**
 * The restore service (S33 chunk 4; issue #34's restore posture, PRD §12,
 * E11, D24, D47, G3/G4).
 *
 * THE WALK, in the issue's recorded order with one honest refinement:
 *
 *   1. policy      — the restore-candidate gate (assertRestorableRow). A
 *                    known-bad row is refused BEFORE services are stopped:
 *                    services are never taken down for a snapshot that can
 *                    never restore. An unknown id is refused here too, and
 *                    a restic-kind snapshot is never restored by a different
 *                    backend (no silent fallback).
 *   2. stop        — the stop-services posture (the injected port; the drill
 *                    and the admin path supply the real stop). A stop
 *                    failure refuses typed before anything is touched.
 *   3. verify      — the snapshot FILE is re-verified on disk (it can rot
 *                    between the ledger and the disk, E11's "verify the
 *                    snapshot's integrity" as a restore step). A failure
 *                    raises the ALERT on the row (the alert path, the same
 *                    one the scheduled check raises) and refuses typed.
 *   4. database    — the target database is REPLACED: stale -wal/-shm
 *                    removed, the snapshot's copy moved in atomically
 *                    (write-to-sibling + rename).
 *   5. volume      — the workspace mounts are REPLACED by the snapshot's
 *                    captured volume through the backend's restore walk
 *                    (the excluded names are never deleted — D22/E9 holds on
 *                    the clear leg too).
 *   6. migrations  — applyMigrations over the restored file (D24: "run
 *                    migrations if required" — the helper is idempotent, so
 *                    the walk always attempts and records the honest
 *                    before/after applied versions).
 *   7. restart     — the start-services port runs LAST.
 *
 * After the restart the ledger row is stamped `restored_at`. Every refusal
 * is a TYPED result (never a thrown error across the caller's boundary) and
 * rides the redacted fault log (G3: bounded detail — the restore path has no
 * secret material, and the detail is the stage's error message bounded at
 * 300 characters).
 */
import { copyFileSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BackupSnapshotRow } from "../../adapters/sqlite/backup-snapshots-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations, appliedMigrationVersions } from "../../adapters/sqlite/migrations.ts";
import { assertRestorableRow, type BackupSnapshotLedger } from "./backup-service.ts";
import {
  databaseFileNames,
  CopyVolumeBackend,
  type VolumeSnapshotBackend,
} from "./volume-backend.ts";

export type RestoreStage =
  "policy" | "stop" | "verify" | "database" | "volume" | "migrations" | "restart";

export type RestoreFailureCode =
  | "RESTORE_SNAPSHOT_NOT_FOUND"
  | "RESTORE_SNAPSHOT_CORRUPT"
  | "RESTORE_STOP_FAILED"
  | "RESTORE_DATABASE_FAILED"
  | "RESTORE_VOLUME_FAILED"
  | "RESTORE_MIGRATION_FAILED"
  | "RESTORE_RESTART_FAILED";

export type RestoreResult =
  | {
      restored: true;
      snapshot_id: string;
      restored_at: string;
      /** The applied migration versions BEFORE the post-restore migration
       * leg (the snapshot's schema at birth). */
      migrated_from: number[];
      /** The applied versions AFTER the leg (the runtime's current head). */
      migrated_to: number[];
      db_bytes: number;
      volume_entries: string[];
    }
  | {
      restored: false;
      snapshot_id: string;
      failed_stage: RestoreStage;
      code: RestoreFailureCode;
      detail: string;
      restored_at: string;
      /** True when the data was ALREADY replaced when the walk failed (only
       * the volume/migrations/restart stages can produce this — the operator
       * is told the restored data is in place even though the walk failed). */
      replaced_before_failure: boolean;
    };

export interface RestoreServiceDeps {
  workspaceId: string;
  /** The TARGET database file path (the file the restore replaces). */
  dbPath: string;
  /** The target volume roots (the mounts the restore replaces), in the SAME
   * order the snapshot's backend captured them. */
  volumeRoots: readonly string[];
  snapshots: BackupSnapshotLedger;
  /** The recorded verification helper (the same one snapshot time used). */
  verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  /** The stop-services posture (the real stop for the deployment; the drill
   * supplies its own). */
  stopServices: () => void | Promise<void>;
  /** The start-services port (runs last). */
  startServices: () => void | Promise<void>;
  /** The volume backend (default: the copy backend; a restic-kind row is
   * refused rather than silently restored by a different backend). */
  volumeBackend?: VolumeSnapshotBackend;
  /** The migration walk over a restored database file (default: the
   * adapter's open → read-applied → applyMigrations → read-applied → close
   * walk). */
  migrations?: ((dbPath: string) => Promise<MigrationVersions>) | undefined;
  now?: (() => string) | undefined;
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** The stage hook (the drill's progress line; tests pin the order). */
  onStage?: ((stage: RestoreStage) => void) | undefined;
}

/** The applied migration versions before and after the post-restore leg. */
export interface MigrationVersions {
  before: number[];
  after: number[];
}

export class RestoreService {
  private readonly workspaceId: string;
  private readonly dbPath: string;
  private readonly volumeRoots: readonly string[];
  private readonly snapshots: BackupSnapshotLedger;
  private readonly verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  private readonly stopServices: () => void | Promise<void>;
  private readonly startServices: () => void | Promise<void>;
  private readonly volumeBackend: VolumeSnapshotBackend;
  private readonly migrations: (dbPath: string) => Promise<MigrationVersions>;
  private readonly now: () => string;
  private readonly logFault: (event: string, fields: Record<string, unknown>) => void;
  private readonly onStage: (stage: RestoreStage) => void;

  constructor(deps: RestoreServiceDeps) {
    this.workspaceId = deps.workspaceId;
    this.dbPath = deps.dbPath;
    this.volumeRoots = deps.volumeRoots;
    this.snapshots = deps.snapshots;
    this.verifyDatabaseCopy = deps.verifyDatabaseCopy;
    this.stopServices = deps.stopServices;
    this.startServices = deps.startServices;
    this.volumeBackend = deps.volumeBackend ?? new CopyVolumeBackend();
    this.migrations = deps.migrations ?? defaultMigrationWalk;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.logFault = deps.logFault ?? (() => {});
    this.onStage = deps.onStage ?? (() => {});
  }

  async restoreSnapshot(input: { snapshotId: string }): Promise<RestoreResult> {
    const restoredAt = this.now();
    // Stage 1 — the policy gate (before ANY mutation, before the stop).
    this.onStage("policy");
    let row: BackupSnapshotRow;
    try {
      row = this.snapshots.require(this.workspaceId, input.snapshotId);
    } catch {
      return this.refuse(
        input.snapshotId,
        "policy",
        "RESTORE_SNAPSHOT_NOT_FOUND",
        `snapshot ${input.snapshotId} does not exist in this workspace`,
        restoredAt,
        false,
      );
    }
    try {
      assertRestorableRow(row);
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "policy",
        "RESTORE_SNAPSHOT_CORRUPT",
        error instanceof Error ? error.message : String(error),
        restoredAt,
        false,
      );
    }
    if (row.volume_kind !== this.volumeBackend.kind) {
      return this.refuse(
        input.snapshotId,
        "policy",
        "RESTORE_VOLUME_FAILED",
        `the snapshot's volume kind is "${row.volume_kind}" but the configured ` +
          `backend is "${this.volumeBackend.kind}" — no silent fallback`,
        restoredAt,
        false,
      );
    }

    // Stage 2 — the stop posture.
    this.onStage("stop");
    try {
      await this.stopServices();
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "stop",
        "RESTORE_STOP_FAILED",
        error instanceof Error ? error.message : String(error),
        restoredAt,
        false,
      );
    }

    // Stage 3 — the snapshot FILE re-verified on disk.
    this.onStage("verify");
    const snapshotDb = join(row.snapshot_dir, "runtime.db");
    const verification = this.verifyDatabaseCopy(snapshotDb);
    if (!verification.ok) {
      // The alert path: a file that rots between the ledger and the restore
      // is raised on the row exactly like the scheduled check raises it.
      this.snapshots.markAlert(
        this.workspaceId,
        input.snapshotId,
        verification.message.slice(0, 300),
      );
      return this.refuse(
        input.snapshotId,
        "verify",
        "RESTORE_SNAPSHOT_CORRUPT",
        verification.message,
        restoredAt,
        false,
      );
    }

    // Stage 4 — the target database replaced (stale WAL siblings removed,
    // the snapshot copy moved in through a sibling rename).
    this.onStage("database");
    try {
      rmSync(`${this.dbPath}-wal`, { force: true });
      rmSync(`${this.dbPath}-shm`, { force: true });
      const stagingPath = `${this.dbPath}.restore-staging`;
      rmSync(stagingPath, { force: true });
      copyFileSync(snapshotDb, stagingPath);
      renameSync(stagingPath, this.dbPath);
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "database",
        "RESTORE_DATABASE_FAILED",
        error instanceof Error ? error.message : String(error),
        restoredAt,
        false,
      );
    }

    // Stage 5 — the workspace mounts replaced through the backend's restore
    // walk (the manifest comes from the snapshot's self-describing sidecar:
    // the restore must work without the runtime's ledger database).
    this.onStage("volume");
    const volumeDir = join(row.snapshot_dir, "volume");
    let volumeEntries: string[];
    try {
      const restored = await this.volumeBackend.restoreVolume({
        volumeDir,
        roots: this.volumeRoots,
        manifest: readSidecarManifest(row.snapshot_dir),
        excludeNames: this.restoreExcludeNames(),
      });
      volumeEntries = restored.entries;
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "volume",
        "RESTORE_VOLUME_FAILED",
        error instanceof Error ? error.message : String(error),
        restoredAt,
        true,
      );
    }

    // Stage 6 — migrations over the restored file (D24; the honest
    // before/after applied versions ride the result).
    this.onStage("migrations");
    let versions: MigrationVersions;
    try {
      versions = await this.migrations(this.dbPath);
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "migrations",
        "RESTORE_MIGRATION_FAILED",
        error instanceof Error ? error.message : String(error),
        restoredAt,
        true,
      );
    }

    // Stage 7 — restart LAST.
    this.onStage("restart");
    try {
      await this.startServices();
    } catch (error) {
      return this.refuse(
        input.snapshotId,
        "restart",
        "RESTORE_RESTART_FAILED",
        `the restored data is IN PLACE but the restart failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        restoredAt,
        true,
      );
    }

    // The ledger stamps the restore (post-restart — a stamped restore means
    // the walk COMPLETED).
    this.snapshots.markRestored(this.workspaceId, input.snapshotId, restoredAt);
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.dbPath).size;
    } catch {
      // best effort — the size honesty is not worth a failure here
    }
    return {
      restored: true,
      snapshot_id: input.snapshotId,
      restored_at: restoredAt,
      migrated_from: versions.before,
      migrated_to: versions.after,
      db_bytes: dbBytes,
      volume_entries: volumeEntries,
    };
  }

  /** The exclusion vocabulary for the restore's DELETE leg: the same
   * recorded names the snapshot never captured (the live database files and
   * the credential key files) are the names the replace never deletes. */
  private restoreExcludeNames(): ReadonlySet<string> {
    const names = new Set(databaseFileNames(this.dbPath));
    for (const name of ["provider-credentials.key", "project-credentials.key"]) {
      names.add(name);
    }
    return names;
  }

  private refuse(
    snapshotId: string,
    stage: RestoreStage,
    code: RestoreFailureCode,
    detail: string,
    restoredAt: string,
    replacedBeforeFailure: boolean,
  ): RestoreResult {
    const bounded = detail.slice(0, 300);
    this.logFault("backup_restore_refused", {
      snapshot_id: snapshotId,
      stage,
      code,
      reason: bounded,
      at: restoredAt,
    });
    return {
      restored: false,
      snapshot_id: snapshotId,
      failed_stage: stage,
      code,
      detail: bounded,
      restored_at: restoredAt,
      replaced_before_failure: replacedBeforeFailure,
    };
  }
}

/** The sidecar's volume manifest, read from the snapshot directory. The
 * sidecar is the self-describing leg (the ledger may live in a database the
 * restore is ABOUT to replace); a missing or malformed manifest refuses the
 * walk. */
function readSidecarManifest(snapshotDir: string): string[] {
  const sidecar = JSON.parse(readFileSync(join(snapshotDir, "snapshot.json"), "utf8")) as {
    volume_entries?: string[];
  };
  if (!Array.isArray(sidecar.volume_entries)) {
    throw new Error("the snapshot sidecar has no volume_entries manifest");
  }
  return sidecar.volume_entries;
}

/** The default migration walk: open the restored file through the adapter
 * (the recorded pragmas), read the applied versions, run applyMigrations
 * (idempotent — the D24 "if required" is "always attempt"), read again,
 * close. A file with NO schema_migrations table is not a runtime database —
 * the walk refuses rather than silently re-migrating from zero over an
 * unknown file. */
export async function defaultMigrationWalk(dbPath: string): Promise<MigrationVersions> {
  let conn: SqliteConnection;
  try {
    conn = openDatabase(dbPath);
  } catch (error) {
    throw new Error(
      `the restored database could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  try {
    const before = appliedMigrationVersions(conn.db);
    if (before.length === 0) {
      throw new Error("the restored database has no schema_migrations table");
    }
    applyMigrations(conn.db);
    const after = appliedMigrationVersions(conn.db);
    return { before, after };
  } finally {
    conn.close();
  }
}
