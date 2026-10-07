/**
 * Short-transaction primitive for the container-local database (S07; AC2).
 *
 * A state transition and its event append must commit atomically or not at
 * all. Repositories and services share one SqliteTransactions instance: when
 * no transaction is open, writes run directly on the base connection; when a
 * transaction is open, every participant routes to the same transactional
 * connection, so nested compositions (a service operation inside an outer
 * transaction) join the outer atomic unit instead of nesting SQLite
 * transactions.
 *
 * Write transactions use BEGIN IMMEDIATE with bounded lock retries so
 * concurrent writers take a bounded, honest failure (G4) instead of hanging.
 */
import type { DatabaseSync } from "node:sqlite";

import { MAX_LOCK_RETRIES } from "./connection.ts";

/**
 * The connection handle a transactional unit receives, re-exported as an
 * adapter type: modules compose transactions through the adapter's public
 * surface and never import the sqlite driver directly (D23 rule 2 boundary
 * guard — node:sqlite stays inside adapters/sqlite).
 */
export type { DatabaseSync as SqliteExec };

function isBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class SqliteTransactions {
  private current: DatabaseSync | null = null;

  constructor(private readonly db: DatabaseSync) {}

  /** The connection writes should target right now (transactional if open). */
  connection(): DatabaseSync {
    return this.current ?? this.db;
  }

  /** True while an atomic unit is open (used by tests and diagnostics). */
  get inTransaction(): boolean {
    return this.current !== null;
  }

  /**
   * Run `fn` inside one short transaction: it commits only if `fn` returns,
   * and rolls back everything (transition AND event append) if it throws.
   */
  transaction<T>(fn: (tx: DatabaseSync) => T): T {
    if (this.current !== null) {
      // Nested composition joins the outer atomic unit.
      return fn(this.current);
    }

    let attempt = 0;
    for (;;) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusyError(error) && attempt < MAX_LOCK_RETRIES) {
          attempt += 1;
          sleepSync(25 * attempt);
          continue;
        }
        throw error;
      }

      this.current = this.db;
      try {
        const result = fn(this.db);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // SQLite may have already invalidated the transaction (e.g. the
          // failure was fatal at the connection level); the original error
          // below is the one that matters.
        }
        throw error;
      } finally {
        this.current = null;
      }
    }
  }
}
