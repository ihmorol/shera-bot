/**
 * The backup service (S33 chunk 1; issue #34; PRD §12, E11, E17, D22, D24,
 * G3/G4).
 *
 * THE MECHANISM, STATED EXPLICITLY (the E11 requirement): snapshots are
 * consistent database copies produced with the recorded E17 export helper —
 * the D13 spike's final call: the consistent whole-database export taken on
 * the live WAL connection (the driver exposes no online-backup API; the
 * measured copy is self-contained, carries WAL-resident writes, and sits far
 * inside the six-hour schedule). Every copy is verified at snapshot time
 * with the recorded integrity statement (the adapter's verify helper); a
 * copy that fails is refused at birth. The workspace
 * volume (private folders, projects, browser profile) is captured beside the
 * database copy by the configured volume backend, EXCLUDING the credential
 * key files and the live database files (D22/E9 — keys are excluded from
 * backups unless the snapshot is explicitly encrypted and authorized; the
 * exclusion is asserted by inspection in the suite, not assumed).
 *
 * The ledger only ever holds RESTORABLE snapshots: a failed verification is
 * recorded through the redacted fault log and the typed result, and the bad
 * copy's directory is removed — a corrupt file never sits in the snapshot
 * root as a restore candidate. Retention keeps the latest seven restorable
 * snapshots; the eighth snapshot removes the OLDEST and never the newest.
 *
 * The six-hour schedule (chunk 2) drives the same takeSnapshot walk through
 * an injected clock seam — the recorded S28 discipline: tests drive the
 * clock, never wall-clock sleeps.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type {
  BackupSnapshotInsert,
  BackupSnapshotRow,
  BackupTriggeredBy,
} from "../../adapters/sqlite/backup-snapshots-repository.ts";
import {
  CopyVolumeBackend,
  databaseFileNames,
  type VolumeSnapshotBackend,
} from "./volume-backend.ts";

/** PRD §12: keep the latest seven snapshots. */
export const RETENTION_KEEP = 7;

/** PRD §12: snapshot every six hours (the schedule seam's default tick). */
export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** The typed failure the takeSnapshot walk can report. */
export type BackupServiceFailureCode =
  | "SNAPSHOT_DIR_CONFLICT"
  | "SNAPSHOT_EXPORT_FAILED"
  | "SNAPSHOT_INTEGRITY_FAILED"
  | "SNAPSHOT_VOLUME_FAILED"
  | "SNAPSHOT_LEDGER_REFUSED";

export class BackupServiceError extends Error {
  readonly code: BackupServiceFailureCode;
  readonly category: "conflict" | "internal" | "state";
  readonly snapshotId: string | null;

  constructor(code: BackupServiceFailureCode, message: string, snapshotId: string | null = null) {
    super(`${code}: ${message}`);
    this.name = "BackupServiceError";
    this.code = code;
    this.category =
      code === "SNAPSHOT_DIR_CONFLICT"
        ? "conflict"
        : code === "SNAPSHOT_LEDGER_REFUSED"
          ? "state"
          : "internal";
    this.snapshotId = snapshotId;
  }
}

/** The structural ledger surface the service needs (the repository
 * implements it; tests may substitute). */
export interface BackupSnapshotLedger {
  record(input: BackupSnapshotInsert): void;
  require(workspaceId: string, snapshotId: string): BackupSnapshotRow;
  listNewestFirst(workspaceId: string): BackupSnapshotRow[];
  markAlert(workspaceId: string, snapshotId: string, alert: string): void;
  setRetainedIndex(workspaceId: string, snapshotId: string, index: number | null): void;
  delete(workspaceId: string, snapshotId: string): boolean;
}

export interface BackupServiceDeps {
  workspaceId: string;
  /** The live database file path (its name is part of the exclusion set). */
  dbPath: string;
  /** Where snapshots live — a SIBLING of the data dir by convention. */
  snapshotRoot: string;
  /** The recorded export helper (E17): a consistent whole-database copy. */
  exportDatabase: (targetPath: string) => void;
  /** The recorded verification helper: the integrity statement over a file. */
  verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  /** The snapshot ledger. */
  snapshots: BackupSnapshotLedger;
  /** The volume roots (default: the data dir beside the database file). */
  volumeRoots?: readonly string[];
  /** The volume backend (default: the dependency-free copy backend). */
  volumeBackend?: VolumeSnapshotBackend;
  /** Deterministic clock (the injected-clock discipline). */
  now?: (() => string) | undefined;
  /** The redacted fault sink (the alert's log leg, G3). */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export type TakeSnapshotResult =
  | {
      taken: true;
      snapshot_id: string;
      taken_at: string;
      db_bytes: number;
      integrity: "ok";
      volume_entries: string[];
      volume_bytes: number;
      volume_kind: "copy" | "restic";
      snapshot_dir: string;
      retained_index: number;
      removed: string[];
    }
  | {
      taken: false;
      snapshot_id: string;
      taken_at: string;
      reason: "integrity_failed";
      integrity_message: string;
      snapshot_dir: string;
    };

export interface RetentionResult {
  kept: number;
  removed: string[];
}

export class BackupService {
  readonly snapshots: BackupSnapshotLedger;
  private readonly workspaceId: string;
  private readonly dbPath: string;
  private readonly snapshotRoot: string;
  private readonly exportDatabase: (targetPath: string) => void;
  private readonly verifyDatabaseCopy: (path: string) => { ok: boolean; message: string };
  private readonly volumeRoots: readonly string[];
  private readonly volumeBackend: VolumeSnapshotBackend;
  private readonly now: () => string;
  private readonly logFault: (event: string, fields: Record<string, unknown>) => void;

  constructor(deps: BackupServiceDeps) {
    this.workspaceId = deps.workspaceId;
    this.dbPath = deps.dbPath;
    this.snapshotRoot = deps.snapshotRoot;
    this.exportDatabase = deps.exportDatabase;
    this.verifyDatabaseCopy = deps.verifyDatabaseCopy;
    this.snapshots = deps.snapshots;
    this.volumeRoots = deps.volumeRoots ?? [dirname(deps.dbPath)];
    this.volumeBackend = deps.volumeBackend ?? new CopyVolumeBackend();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.logFault = deps.logFault ?? (() => {});
  }

  /** The exclusion set for THIS service: the credential key files (the
   * recorded vocabulary) plus this database's own file names. */
  volumeExcludeNames(): ReadonlySet<string> {
    const names = new Set(databaseFileNames(this.dbPath));
    for (const name of ["provider-credentials.key", "project-credentials.key"]) {
      names.add(name);
    }
    names.add(basename(this.snapshotRoot));
    return names;
  }

  /**
   * Take one snapshot: export the database, verify the copy, capture the
   * volume, record the ledger row, then enforce retention. `snapshotRef`
   * names an admin-triggered snapshot with the control plane's ref (the
   * 1:1 ref-to-snapshot identity); scheduled snapshots mint their own id.
   */
  async takeSnapshot(input: {
    triggeredBy: BackupTriggeredBy;
    snapshotRef?: string | undefined;
  }): Promise<TakeSnapshotResult> {
    const snapshotId = input.snapshotRef ?? `snapshot_${randomUUID()}`;
    const takenAt = this.now();
    const snapshotDir = join(this.snapshotRoot, snapshotId);
    if (existsSync(snapshotDir)) {
      throw new BackupServiceError(
        "SNAPSHOT_DIR_CONFLICT",
        `a snapshot directory already exists for ${snapshotId}`,
        snapshotId,
      );
    }
    mkdirSync(snapshotDir, { recursive: true });
    const dbTarget = join(snapshotDir, "runtime.db");
    try {
      this.exportDatabase(dbTarget);
    } catch (error) {
      rmSync(snapshotDir, { recursive: true, force: true });
      this.logFault("backup_snapshot_failed", {
        snapshot_id: snapshotId,
        stage: "export",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      throw new BackupServiceError(
        "SNAPSHOT_EXPORT_FAILED",
        error instanceof Error ? error.message.slice(0, 300) : "the database export failed",
        snapshotId,
      );
    }

    // E11: every snapshot is verified at snapshot time. A failed copy is
    // refused at birth — its directory is removed, the failure rides the
    // redacted fault log and the typed result, and NO ledger row exists (the
    // ledger only ever holds restorable snapshots).
    const integrity = this.verifyDatabaseCopy(dbTarget);
    if (!integrity.ok) {
      rmSync(snapshotDir, { recursive: true, force: true });
      this.logFault("backup_snapshot_failed", {
        snapshot_id: snapshotId,
        stage: "integrity",
        reason: integrity.message.slice(0, 300),
      });
      return {
        taken: false,
        snapshot_id: snapshotId,
        taken_at: takenAt,
        reason: "integrity_failed",
        integrity_message: integrity.message,
        snapshot_dir: snapshotDir,
      };
    }

    // The workspace volume (private folders, projects, browser profile) —
    // with the key files and the live database files excluded (D22/E9).
    const volumeDir = join(snapshotDir, "volume");
    mkdirSync(volumeDir, { recursive: true });
    const volume = await this.volumeBackend.snapshotVolume({
      roots: this.volumeRoots,
      targetDir: volumeDir,
      excludeNames: this.volumeExcludeNames(),
    });

    const dbBytes = statSize(dbTarget);
    const insert: BackupSnapshotInsert = {
      workspace_id: this.workspaceId,
      snapshot_id: snapshotId,
      taken_at: takenAt,
      triggered_by: input.triggeredBy,
      db_bytes: dbBytes,
      integrity_status: "ok",
      volume_kind: this.volumeBackend.kind,
      snapshot_dir: snapshotDir,
    };
    try {
      this.snapshots.record(insert);
    } catch (error) {
      rmSync(snapshotDir, { recursive: true, force: true });
      throw new BackupServiceError(
        "SNAPSHOT_LEDGER_REFUSED",
        error instanceof Error ? error.message.slice(0, 300) : "the ledger refused the snapshot",
        snapshotId,
      );
    }

    // The sidecar makes the snapshot directory self-describing (the drill
    // and the restore read it without the runtime's database). Retention is
    // the LEDGER's authority — the sidecar records identity, integrity, and
    // the volume manifest only.
    const sidecar: SnapshotSidecar = {
      snapshot_id: snapshotId,
      workspace_id: this.workspaceId,
      taken_at: takenAt,
      triggered_by: input.triggeredBy,
      integrity_status: "ok",
      integrity_message: integrity.message,
      db_bytes: dbBytes,
      volume_kind: this.volumeBackend.kind,
      volume_roots: [...this.volumeRoots],
      volume_entries: volume.entries,
    };
    writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(sidecar, null, 2));

    const retention = this.enforceRetention(RETENTION_KEEP);
    const row = this.snapshots.require(this.workspaceId, snapshotId);
    return {
      taken: true,
      snapshot_id: snapshotId,
      taken_at: takenAt,
      db_bytes: dbBytes,
      integrity: "ok",
      volume_entries: volume.entries,
      volume_bytes: volume.bytes,
      volume_kind: this.volumeBackend.kind,
      snapshot_dir: snapshotDir,
      retained_index: row.retained_index ?? 1,
      removed: retention.removed,
    };
  }

  /**
   * Retention (PRD §12): keep the latest seven restorable snapshots; every
   * snapshot beyond the window removes the OLDEST — never the newest. The
   * survivors' retention indexes are rewritten 1..n (1 = newest) so the
   * control-plane metadata and the ledger agree.
   */
  enforceRetention(keep: number = RETENTION_KEEP): RetentionResult {
    const effectiveKeep = Math.max(1, keep);
    const newestFirst = this.snapshots.listNewestFirst(this.workspaceId);
    const survivors = newestFirst.slice(0, effectiveKeep);
    const removed: string[] = [];
    for (const row of newestFirst.slice(effectiveKeep)) {
      rmSync(row.snapshot_dir, { recursive: true, force: true });
      this.snapshots.delete(this.workspaceId, row.snapshot_id);
      removed.push(row.snapshot_id);
    }
    survivors.forEach((row, index) => {
      if (row.retained_index !== index + 1) {
        this.snapshots.setRetainedIndex(this.workspaceId, row.snapshot_id, index + 1);
      }
    });
    return { kept: survivors.length, removed };
  }

  /** The snapshot directories currently on disk under the root (drill and
   * verification support; the ledger remains the authority). */
  snapshotDirectoriesOnDisk(): string[] {
    if (!existsSync(this.snapshotRoot)) {
      return [];
    }
    return readdirSafe(this.snapshotRoot)
      .filter((name) => existsSync(join(this.snapshotRoot, name, "snapshot.json")))
      .sort();
  }
}

/** The sidecar shape (`snapshot.json` inside every snapshot directory). */
export interface SnapshotSidecar {
  snapshot_id: string;
  workspace_id: string;
  taken_at: string;
  triggered_by: BackupTriggeredBy;
  integrity_status: "ok";
  integrity_message: string;
  db_bytes: number;
  volume_kind: "copy" | "restic";
  volume_roots: string[];
  volume_entries: string[];
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
