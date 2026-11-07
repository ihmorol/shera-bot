/**
 * The workspace-volume snapshot backends (S33 chunk 1; PRD §12, E11).
 *
 * The workspace VOLUME is the on-disk state beside the container-local
 * database: the Agents' private folders (`agent-files/`), the project
 * repositories and worktrees (`projects/`), and the shared browser profile.
 * Row-based state (files, artifacts, memory, checkpoints) rides the database
 * snapshot itself; this backend captures the rest.
 *
 * Two recorded backends behind ONE interface:
 *   - `copy` (the prototype default, dependency-free): a bounded recursive
 *     copy of each volume root's top-level entries into the snapshot
 *     directory, with the recorded exclusion vocabulary.
 *   - `restic` (the recorded open-source leverage, BSD-2 external binary):
 *     the same interface over the restic CLI — backup / restore / forget
 *     --keep-last 7 / check. Wired in chunk 5; never a silent fallback.
 *
 * The exclusion vocabulary (D22/E9, asserted by inspection in the suite):
 * the credential KEY FILES (provider + project custody) and the live
 * database files never enter a volume snapshot. The snapshot root itself is
 * always a SIBLING of the data dir, but the exclusion keeps the walk safe
 * even if a deployment configures it inside.
 */
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** The names a volume snapshot NEVER captures (D22/E9 key exclusion; the
 * live database rides the recorded export helper instead of a file copy). */
export const VOLUME_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "runtime.db",
  "runtime.db-wal",
  "runtime.db-shm",
  "provider-credentials.key",
  "project-credentials.key",
]);

/** The live database file's names — computed from the configured dbPath so
 * a renamed database is still excluded by name. */
export function databaseFileNames(dbPath: string): ReadonlySet<string> {
  const base = basename(dbPath);
  return new Set([base, `${base}-wal`, `${base}-shm`]);
}

export interface VolumeSnapshotRequest {
  /** The volume roots to capture (default: the data dir). */
  roots: readonly string[];
  /** The directory to write into (created by the caller). */
  targetDir: string;
  /** Names never to capture (the key files + the database file names). */
  excludeNames: ReadonlySet<string>;
}

export interface VolumeSnapshotResult {
  /** The captured root entries, as `<rootIndex>:<entryName>` rows — the
   * restore's reverse-mapping manifest (also recorded in the sidecar). */
  entries: string[];
  /** Total bytes captured (best effort, for the ledger's size honesty). */
  bytes: number;
}

export interface VolumeSnapshotBackend {
  readonly kind: BackupVolumeKindTag;
  snapshotVolume(request: VolumeSnapshotRequest): Promise<VolumeSnapshotResult>;
}

/** The backend tag (mirrors the ledger's volume_kind vocabulary). */
export type BackupVolumeKindTag = "copy" | "restic";

/**
 * The `copy` backend: deterministic, dependency-free, the prototype default.
 * Each root's TOP-LEVEL entries (minus the excluded names) are copied into
 * `<targetDir>/roots/<rootIndex>/`. The exclusion check applies at every
 * directory level so an excluded name can never smuggle in through a
 * subdirectory rename — the walk never descends into an excluded entry.
 */
export class CopyVolumeBackend implements VolumeSnapshotBackend {
  readonly kind = "copy" as const;

  async snapshotVolume(request: VolumeSnapshotRequest): Promise<VolumeSnapshotResult> {
    const entries: string[] = [];
    let bytes = 0;
    request.roots.forEach((root, rootIndex) => {
      const rootTarget = join(request.targetDir, "roots", String(rootIndex));
      if (!existsSync(root)) {
        // An absent root is captured as empty (an honest empty volume), and
        // the manifest records it so the restore recreates nothing silently.
        entries.push(`${rootIndex}:`);
        return;
      }
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (request.excludeNames.has(entry.name)) {
          continue;
        }
        const source = join(root, entry.name);
        const target = join(rootTarget, entry.name);
        cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
        entries.push(`${rootIndex}:${entry.name}`);
        bytes += entry.isDirectory() ? directoryBytes(source) : statSync(source).size;
      }
    });
    return { entries, bytes };
  }
}

/** Best-effort recursive size (the ledger's byte honesty is best effort by
 * design — a size that cannot be read is not fabricated). */
function directoryBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : statSync(full).size;
  }
  return total;
}
