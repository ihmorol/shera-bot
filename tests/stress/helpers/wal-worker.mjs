/**
 * WAL contention worker (stress scenario 4): a REAL parallel writer on the
 * container-local SQLite file. Runs in a node:worker_threads thread with its
 * OWN connection to the same database the product connection holds open —
 * the only way SQLite contention is actually exercised in a single-process
 * test runtime (node:sqlite is synchronous; in-process "concurrency"
 * serializes by construction).
 *
 * The worker mirrors the product's recorded write contract exactly (the
 * adapter's pragmas, BEGIN IMMEDIATE, sequence allocation INSIDE the
 * transaction, the composite-PK journal insert with the idempotency clause)
 * so the serialization invariants the product relies on are tested under
 * real thread-level parallelism, and SQLITE_BUSY surfaces as the bounded
 * retry the adapter promises — never a leak.
 */
import { DatabaseSync } from "node:sqlite";
import { workerData, parentPort } from "node:worker_threads";

const { dbPath, workspaceId, workerId, iterations, holdMs } = workerData;

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

const streamId = `stress-wal-worker-${workerId}`;
const MAX_LOCK_RETRIES = 5;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const INSERT = `INSERT INTO event_journal
  (stream_id, sequence, event_id, event_type, schema_version, payload, workspace_id, occurred_at, correlation_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (workspace_id, event_id) DO NOTHING`;
const NEXT_SEQ =
  "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM event_journal WHERE stream_id = ? AND workspace_id = ?";

let committed = 0;
let busyRetries = 0;
// Contention evidence: a BEGIN IMMEDIATE that took longer than 1ms waited
// on a sibling's write lock (the busy_timeout absorbing the wait — the
// SQLITE_BUSY error itself only surfaces past the 5s bound).
let contendedBegins = 0;
let totalBeginWaitMs = 0;
const errors = [];

for (let i = 1; i <= iterations; i += 1) {
  let began = false;
  // BEGIN IMMEDIATE with the bounded retry — the product's recorded contract.
  for (let attempt = 0; attempt <= MAX_LOCK_RETRIES; attempt += 1) {
    const beginStart = process.hrtime.bigint();
    try {
      db.exec("BEGIN IMMEDIATE");
      const beginWaitMs = Number(process.hrtime.bigint() - beginStart) / 1e6;
      if (beginWaitMs > 1) {
        contendedBegins += 1;
        totalBeginWaitMs += beginWaitMs;
      }
      began = true;
      break;
    } catch (error) {
      if (error && error.code === "SQLITE_BUSY" && attempt < MAX_LOCK_RETRIES) {
        busyRetries += 1;
        sleepSync(25 * (attempt + 1));
        continue;
      }
      errors.push(`begin:${error && error.code ? error.code : String(error && error.message)}`);
      break;
    }
  }
  if (!began) continue;

  try {
    const row = db.prepare(NEXT_SEQ).get(streamId, workspaceId);
    const sequence = row ? Number(row.next_sequence) : 1;
    // A deliberate hold INSIDE the write transaction widens the contention
    // window so sibling writers genuinely collide on the write lock.
    if (holdMs > 0) sleepSync(holdMs);
    db.prepare(INSERT).run(
      streamId,
      sequence,
      `evt_wal_${workerId}_${i}`,
      "worker.progress",
      1,
      JSON.stringify({ worker: workerId, n: i }),
      workspaceId,
      new Date().toISOString(),
      streamId,
    );
    db.exec("COMMIT");
    committed += 1;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the failure may have invalidated the transaction already
    }
    errors.push(`unit:${error && error.code ? error.code : String(error && error.message)}`);
  }
}

try {
  db.close();
} catch {
  // already closed
}

parentPort.postMessage({ workerId, committed, busyRetries, contendedBegins, totalBeginWaitMs, errors, streamId });
