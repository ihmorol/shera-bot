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
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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

export interface VolumeRestoreRequest {
  /** The snapshot's volume directory (its `roots/` subtree). */
  volumeDir: string;
  /** The volume roots to restore INTO (the same roots, same order). */
  roots: readonly string[];
  /** The captured manifest (the snapshot result's `entries` rows). */
  manifest: readonly string[];
  /** Names never to DELETE on the clear leg either (D22/E9: the excluded
   * names can never be captured, and the restore's replace never deletes
   * them at a root either). */
  excludeNames: ReadonlySet<string>;
}

export interface VolumeRestoreResult {
  /** The restored root entries, as `<rootIndex>:<entryName>` rows. */
  entries: string[];
}

export interface VolumeSnapshotBackend {
  readonly kind: BackupVolumeKindTag;
  snapshotVolume(request: VolumeSnapshotRequest): Promise<VolumeSnapshotResult>;
  /** The reverse walk: REPLACE each root's top-level content with the
   * snapshot's (the mount-replacement semantics; the excluded names are
   * never deleted on the clear leg). */
  restoreVolume(request: VolumeRestoreRequest): Promise<VolumeRestoreResult>;
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
      mkdirSync(rootTarget, { recursive: true });
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
        // The walk NEVER descends into an excluded name, and the exclusion
        // holds at EVERY directory level: an excluded file inside a captured
        // directory (projects/provider-credentials.key) is skipped here —
        // not copied wholesale by a recursive cpSync (the D22/E9 inspection
        // caught exactly that hole; the recorded names are excluded by name
        // at every depth).
        copyExcluding(source, target, request.excludeNames);
        entries.push(`${rootIndex}:${entry.name}`);
        bytes += entry.isDirectory() ? directoryBytes(source) : statSync(source).size;
      }
    });
    return { entries, bytes };
  }

  /** The reverse walk (the replace semantics): for each root, CLEAR its
   * top-level entries (never an excluded name — D22/E9 holds on the delete
   * leg too), then copy the snapshot's captured entries back. */
  async restoreVolume(request: VolumeRestoreRequest): Promise<VolumeRestoreResult> {
    const entries: string[] = [];
    const byRoot = new Map<string, string[]>();
    for (const row of request.manifest) {
      const sep = row.indexOf(":");
      if (sep <= 0) continue;
      const rootIndex = row.slice(0, sep);
      const name = row.slice(sep + 1);
      if (name.length === 0) continue;
      const list = byRoot.get(rootIndex) ?? [];
      list.push(name);
      byRoot.set(rootIndex, list);
    }
    request.roots.forEach((root, rootIndex) => {
      const captured = byRoot.get(String(rootIndex)) ?? [];
      if (existsSync(root)) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (request.excludeNames.has(entry.name) || captured.includes(entry.name)) {
            continue;
          }
          rmSync(join(root, entry.name), { recursive: true, force: true });
        }
      } else {
        mkdirSync(root, { recursive: true });
      }
      const rootSource = join(request.volumeDir, "roots", String(rootIndex));
      for (const name of captured) {
        const source = join(rootSource, name);
        if (!existsSync(source)) {
          throw new Error(`the snapshot's volume is missing its captured entry ${name}`);
        }
        cpSync(source, join(root, name), { recursive: true, force: false, errorOnExist: true });
        entries.push(`${rootIndex}:${name}`);
      }
    });
    return { entries };
  }
}

/** The exclusion-honoring recursive copy: every directory level is walked
 * (never a wholesale cpSync — an excluded name inside a captured directory
 * must be skipped, not swept in), and an excluded name is never created in
 * the target (D22/E9 at every depth). */
function copyExcluding(
  source: string,
  target: string,
  excludeNames: ReadonlySet<string>,
): void {
  const stat = statSync(source);
  if (!stat.isDirectory()) {
    copyFileSync(source, target);
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) {
      continue;
    }
    copyExcluding(join(source, entry.name), join(target, entry.name), excludeNames);
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
