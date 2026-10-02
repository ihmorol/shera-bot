/**
 * Disposable test-resource registry (cross-platform temp cleanup).
 *
 * Why this exists: the S07/S09/S10 runtime suites each opened a container-local
 * SQLite database in a `mkdtemp` directory and, in `afterAll`, deleted the
 * directory with a bare `rmSync(dir, { recursive: true, force: true })`. On
 * POSIX that succeeds even with open descriptors, so the suites were green on
 * Linux CI. On Windows the still-open `DatabaseSync` handle — plus the WAL
 * `-wal`/`-shm` sidecars it owns — locks the directory tree, `rmSync` throws
 * `EPERM`, and the suite is reported as FAILED even though every assertion in
 * it passed. Ten suites failed this way purely because of the host platform.
 *
 * Two defects, both fixed here:
 *   1. Resource handles were never closed. `trackConnection` records each
 *      connection's `close()` so cleanup can release it before deletion.
 *   2. Deletion was a single unretried attempt. `cleanupTempResources` retries
 *      with a short backoff, because Windows can hold a file lock for a few
 *      milliseconds after the owning handle closes.
 *
 * Cleanup is best-effort by design: a temp directory that outlives its test run
 * is a leak, not a product defect, so it must never mask a real test failure
 * (and must never fail a suite whose assertions all passed).
 *
 * No SQLite driver import appears here on purpose: connections are tracked by
 * their `close()` function, which keeps this helper free of the D23 rule 2
 * persistence-boundary imports and therefore outside that boundary
 * (see `scripts/boundary-guards.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Anything with a `close()` — an open SQLite connection, or a test server. */
export interface Closeable {
  close(): void | Promise<void>;
}

const trackedDirs: string[] = [];
const trackedCloseables: Closeable[] = [];

/** Create a tracked temp directory whose prefix identifies the suite. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackedDirs.push(dir);
  return dir;
}

/**
 * Register an open resource so its handle is released before the temp
 * directories are deleted. Call this immediately after opening a database — or
 * after composing anything that owns one (`composeLocalApi`).
 */
export function trackConnection<T extends Closeable>(connection: T): T {
  trackedCloseables.push(connection);
  return connection;
}

/** Codes that mean "a handle still had the file" rather than a real failure. */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/** One deletion attempt; returns true when the tree is gone (or was absent). */
function removeOnce(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !TRANSIENT_CODES.has(code)) {
      // A genuine, non-transient filesystem problem: surface it rather than
      // silently pretending cleanup succeeded.
      throw error;
    }
    return false;
  }
}

/**
 * Release every tracked handle, then delete every tracked directory.
 *
 * Retries a bounded number of times to absorb Windows' short-lived lock
 * release. Intended for `afterAll` / `afterEach`.
 *
 * A directory that survives the retry budget is reported on stderr rather than
 * silently dropped: it means a resource is still open, which is a real defect
 * in the suite. It is reported and NOT thrown, because a leaked temp directory
 * must never turn a suite whose assertions all passed into a failure — but it
 * is never invisible either (review finding F4).
 */
export async function cleanupTempResources(): Promise<void> {
  for (const closeable of trackedCloseables.splice(0).reverse()) {
    try {
      await closeable.close();
    } catch {
      // A handle that cannot be closed must not abort cleanup for the rest.
    }
  }

  for (const dir of trackedDirs.splice(0).reverse()) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (removeOnce(dir)) {
        break;
      }
      // ~10ms before the first retry, doubling: ~10s of total patience.
      if (attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
      if (attempt === 9) {
        // Budget exhausted: a handle is still open. Visible, not thrown.
        console.warn(
          `[temp-resources] could not delete ${dir}: a resource is still open after 10 retries. ` +
            `Track every connection with trackConnection() so cleanup can close it first.`,
        );
      }
    }
  }
}
