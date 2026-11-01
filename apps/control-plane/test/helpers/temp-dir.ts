/**
 * Bounded-backoff temp directory deletion for control-plane suites — the E20
 * Windows pattern, replicated from
 * `apps/user-runtime/test/helpers/temp-resources.ts`.
 *
 * Why this exists: the S32 admin suites compose a container-local SQLite
 * runtime inside a `mkdtemp` directory and delete it in `afterAll`. On
 * Windows the still-open SQLite handle — plus the WAL `-wal`/`-shm` sidecars
 * it owns — locks the directory tree; the single unretried `rmSync` throws
 * `EPERM`, and the suite is reported FAILED even though every assertion in it
 * passed. Two defenses, exactly per E20:
 *   1. the caller closes every owning handle BEFORE deleting (note that
 *      `composeRuntime()`'s `close()` is async — the SQLite release lands
 *      inside its promise, so it must be awaited);
 *   2. the deletion retries with a short backoff, because Windows can hold a
 *      file lock for a few milliseconds after the owning handle closes.
 *
 * Cleanup is best-effort by design: a temp directory that outlives its test
 * run is a leak, not a product defect, so it must never fail a suite whose
 * assertions all passed — but it is never invisible either (reported on
 * stderr, review finding F4's posture).
 *
 * This replicates the E20 helper instead of importing it because a cross-app
 * TEST-helper import has no precedent in this repo (the existing cross-app
 * imports are src-only, e.g. the OperationsRunSeam fixtures) and boundary
 * exceptions are allowlisted one-by-one in `scripts/boundary-guards.ts`; a
 * one-function local helper avoids a new exception entry.
 */
import { rmSync } from "node:fs";

/** Codes that mean "a handle still had the file" rather than a real failure. */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/**
 * Delete a temp directory, retrying a bounded number of times to absorb
 * Windows' short-lived lock release. Intended for `afterAll`.
 *
 * A directory that survives the retry budget is reported on stderr rather
 * than thrown: a leaked temp directory must never turn a suite whose
 * assertions all passed into a failure. A NON-transient filesystem error
 * (not EPERM/EBUSY/ENOTEMPTY) is surfaced — that is a real problem.
 */
export async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_CODES.has(code)) {
        throw error;
      }
    }
    if (attempt < 9) {
      // ~10ms before the first retry, doubling over attempts 0-8: ~5s of
      // total patience — the same budget as the E20 helper.
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  console.warn(
    `[temp-dir] could not delete ${dir}: a resource is still open after 10 retries.`,
  );
}
