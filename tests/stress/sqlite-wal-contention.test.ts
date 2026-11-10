/**
 * Stress scenario 4: SQLite product-state WAL contention — parallel writers
 * on the container-local database.
 *
 * What is REAL here: the product's openDatabase pragmas (asserted, not
 * assumed — WAL, foreign keys, the bounded busy timeout), the product's
 * EventsService append path (its own BEGIN IMMEDIATE unit per event), the
 * product's journal repository reads, and — through the worker threads —
 * REAL thread-level parallel writers holding write locks on the SAME
 * database file while the main thread's product writers keep working.
 *
 * Why worker threads: node:sqlite is synchronous, so in-process
 * "concurrency" serializes by construction and never exercises the lock
 * contract. Six workers with their own connections take BEGIN IMMEDIATE
 * write locks (with a deliberate in-transaction hold to widen the collision
 * window) while the main thread's PRODUCT writers append through
 * EventsService — every product write that hits a worker-held lock waits on
 * the busy timeout and retries through the adapter's bounded lock-retry
 * loop, exactly the recorded SQLITE_BUSY posture (G4: a bounded, honest
 * wait — never a hang, never a leak).
 *
 * The invariants:
 *
 *   W1  no SQLITE_BUSY leak: every product append and every worker unit
 *       commits — zero surfaced SQLITE_BUSY after the bounded retries;
 *   W2  transactions serialize: per-stream sequences are exactly 1..n with
 *       no duplicate or lost rows (the composite PK would fail loudly on
 *       any broken serialization);
 *   W3  the main thread's product writers and the workers interleave freely
 *       — all committed rows are present and unique;
 *   W4  the pragmas survive the storm (journal_mode still wal; foreign_keys
 *       still on; busy_timeout still the recorded bound);
 *   W5  the WAL stays healthy: a TRUNCATE checkpoint succeeds and the file
 *       passes the integrity check after the storm.
 *
 * Governing records: E17 (node:sqlite, WAL mode, bounded busy timeout, short
 * transactions), AC1/AC2 (pragma assertions, atomic units), G4 (bounded
 * honest failure).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUSY_TIMEOUT_MS,
  openDatabase,
  walCheckpointTruncate,
  verifySnapshotIntegrity,
  assertRequiredPragmas,
} from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";

const WS = "ws-stress-wal";
const WORKER_COUNT = 6;
const WORKER_ITERATIONS = 40;
const WORKER_HOLD_MS = 2;

const WAL_WORKER_SCRIPT = fileURLToPath(
  new URL("./helpers/wal-worker.mjs", import.meta.url),
);

const dirs: string[] = [];
const conns: Array<{ close(): void }> = [];

afterEach(() => {
  for (const conn of conns.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface WorkerReport {
  workerId: number;
  committed: number;
  busyRetries: number;
  contendedBegins: number;
  totalBeginWaitMs: number;
  errors: string[];
  streamId: string;
}

function runWorker(index: number, holdMs: number): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WAL_WORKER_SCRIPT, {
      workerData: {
        dbPath: current.dbPath,
        workspaceId: WS,
        workerId: index,
        iterations: WORKER_ITERATIONS,
        holdMs,
      },
    });
    worker.on("message", (report: WorkerReport) => {
      void worker.terminate();
      resolve(report);
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`wal worker ${index} exited ${code}`));
    });
  });
}

let current: { dbPath: string } = { dbPath: "" };

describe("stress: SQLite product-state WAL contention (parallel writers)", () => {
  it("six parallel worker writers plus product writers serialize cleanly — no SQLITE_BUSY leak, no lost or duplicated row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-stress-wal-"));
    dirs.push(dir);
    const dbPath = join(dir, "runtime.db");
    current = { dbPath };

    // The product connection: the pragmas are ASSERTED after opening (AC1).
    const conn = openDatabase(dbPath);
    conns.push(conn);
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);

    // THE STORM: six REAL parallel writers each take 40 write-locked
    // transactions (with an in-transaction hold that widens the collision
    // window) while the main thread's PRODUCT writers keep appending through
    // EventsService. The workers and the product writers contend on the same
    // file: every product append that hits a worker-held write lock waits
    // through the busy timeout, and the adapter's bounded retry loop absorbs
    // the rest.
    const productStreams = Array.from(
      { length: 4 },
      (_, index) => `stress-wal-product-${index + 1}`,
    );
    let productAppends = 0;
    const productFailures: string[] = [];

    const productWriter = async (streamId: string): Promise<void> => {
      for (let i = 1; i <= WORKER_ITERATIONS; i += 1) {
        // Yield: workers grab the write lock between product appends.
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          events.appendEvent({
            event_id: `evt_wal_product_${streamId}_${i}`,
            stream_id: streamId,
            type: "worker.progress",
            payload: {
              worker_id: `wk_${streamId}`,
              workspace_id: WS,
              run_id: streamId,
              percent: Math.round((i / WORKER_ITERATIONS) * 100),
              text: `product append ${i}`,
            },
            workspace_id: WS,
            correlation_id: streamId,
          });
          productAppends += 1;
        } catch (error) {
          productFailures.push(
            `${streamId}/${i}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };

    const workerPromises = Array.from({ length: WORKER_COUNT }, (_, index) =>
      runWorker(index + 1, WORKER_HOLD_MS),
    );
    const productPromises = productStreams.map((streamId) => productWriter(streamId));
    const [reports, ] = await Promise.all([
      Promise.all(workerPromises),
      Promise.all(productPromises),
    ]);

    // W1: no SQLITE_BUSY leak — every worker unit committed, and every
    // product append committed.
    for (const report of reports) {
      expect(
        report.errors,
        `worker ${report.workerId} surfaced errors: ${report.errors.slice(0, 5).join(" | ")}`,
      ).toEqual([]);
      expect(
        report.committed,
        `worker ${report.workerId} lost units under contention`,
      ).toBe(WORKER_ITERATIONS);
    }
    expect(
      productFailures,
      `product writers surfaced errors: ${productFailures.slice(0, 5).join(" | ")}`,
    ).toEqual([]);
    expect(productAppends).toBe(productStreams.length * WORKER_ITERATIONS);
    // The lock contract was genuinely exercised: workers report the begins
    // that WAITED on a sibling's write lock (the busy_timeout absorbing the
    // wait — a surfaced SQLITE_BUSY needs a 5s hold and would be W1's
    // failure). Zero contended begins would mean the storm never stressed
    // the serialization contract.
    const totalContendedBegins = reports.reduce((sum, report) => sum + report.contendedBegins, 0);
    expect(
      totalContendedBegins,
      "the contention window never materialized — the storm did not stress the lock contract",
    ).toBeGreaterThan(0);

    // W2: transactions serialize — each stream's rows are exactly 1..n.
    for (const report of reports) {
      const rows = journal.listStream(report.streamId, WS);
      expect(
        rows.length,
        `worker ${report.workerId} stream row count`,
      ).toBe(WORKER_ITERATIONS);
      for (let index = 0; index < rows.length; index += 1) {
        expect(
          rows[index]?.sequence,
          `worker ${report.workerId} stream serialization break at ${index}`,
        ).toBe(index + 1);
      }
    }
    for (const streamId of productStreams) {
      const rows = journal.listStream(streamId, WS);
      expect(rows.length).toBe(WORKER_ITERATIONS);
      for (let index = 0; index < rows.length; index += 1) {
        expect(rows[index]?.sequence, `product stream ${streamId} gap`).toBe(index + 1);
      }
    }

    // W3: all committed rows unique across the whole journal.
    const all = journal.listWorkspaceStreams(WS).flatMap((streamId) =>
      journal.listStream(streamId, WS).map((row) => row.event_id),
    );
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(
      WORKER_COUNT * WORKER_ITERATIONS + productStreams.length * WORKER_ITERATIONS,
    );

    // W4: the pragmas survive the storm.
    assertRequiredPragmas(conn.db);
    expect(BUSY_TIMEOUT_MS).toBe(5_000);

    // W5: the WAL stays healthy — a TRUNCATE checkpoint succeeds, the file
    // passes the integrity check.
    walCheckpointTruncate(conn.db);
    const integrity = verifySnapshotIntegrity(dbPath);
    expect(integrity.ok, `post-storm integrity: ${integrity.message}`).toBe(true);
  }, 120_000);
});
