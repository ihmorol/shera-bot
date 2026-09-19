/**
 * S03 spike — contention child for bench-sqlite.ts.
 *
 * Both drivers (node:sqlite, better-sqlite3) are SYNCHRONOUS: a busy_timeout
 * wait blocks the native thread, so a second writer must run in its own
 * process — otherwise it would deadlock the first writer's COMMIT timer.
 * This child opens its own connection, sets PRAGMA busy_timeout, performs one
 * INSERT into operation_events, and prints one JSON result line.
 *
 * Run by bench-sqlite.ts; not part of the supervision scenarios.
 */
import Database from "better-sqlite3";
import { DatabaseSync } from "node:sqlite";

import { nowMs, parseArgs, round2 } from "./contract.ts";

const args = parseArgs(process.argv.slice(2));
const driver = args["driver"] ?? "node:sqlite";
const dbPath = args["db"] ?? "";
const busyTimeoutMs = Number(args["busy-timeout-ms"] ?? 0);
const seq = Number(args["seq"] ?? 1);

type Stmt = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};
type Handle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Stmt;
  close: () => void;
};

const db: Handle =
  driver === "node:sqlite"
    ? (new DatabaseSync(dbPath) as unknown as Handle)
    : (new (
        Database as unknown as new (p: string) => {
          exec: (sql: string) => void;
          prepare: (sql: string) => Stmt;
          close: () => void;
        }
      )(dbPath) as Handle);

db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
const stmt = db.prepare(
  "INSERT INTO operation_events (operation_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
);
const t0 = nowMs();
try {
  stmt.run(1, seq, `contended-write-${seq}-${"x".repeat(180)}`, new Date().toISOString());
  console.log(JSON.stringify({ ok: true, elapsedMs: round2(nowMs() - t0) }));
} catch (err) {
  const e = err as { code?: string; errcode?: string; message?: string };
  console.log(
    JSON.stringify({
      ok: false,
      elapsedMs: round2(nowMs() - t0),
      code: e.code ?? e.errcode ?? null,
      error: (e.message ?? String(err)).slice(0, 160),
    }),
  );
} finally {
  db.close();
}
