/**
 * The credit ledger's storage-enforced append-only guarantee (S24 review F5,
 * AC9; D23 rule 2) — the v20 no-update/no-delete triggers on
 * credit_transaction RAISE on any direct row mutation, so no in-place edit
 * or row removal is representable at the storage layer, repository
 * discipline or not.
 *
 * These pins live BESIDE THE SCHEMA on purpose: the boundary contract keeps
 * every SQL statement inside adapters/sqlite (the settlement suite's copy
 * was relocated here verbatim), and the proof is inherently raw — a direct
 * exec against the real connection is exactly the act the trigger must
 * refuse.
 *
 * Real SQLite, real migrations. Vocabulary: Pack → Operations → Agents (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import { applyMigrations } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import { CreditLedgerRepository } from "./credit-ledger-repository.ts";
import { CreditLedgerService } from "../../modules/credits/credit-ledger.service.ts";

const WS = "ws-credit-settle";
const CLOCK = "2026-11-02T12:00:00.000Z";

interface Harness {
  dir: string;
  conn: SqliteConnection;
  ledger: CreditLedgerService;
}

const harnesses: Harness[] = [];

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s24-append-only-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const repo = new CreditLedgerRepository(tx);
  const ledger = new CreditLedgerService({ repository: repo, tx, now: () => CLOCK });
  const harness: Harness = { dir, conn, ledger };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

describe("append-only is storage-enforced (review F5, AC9)", () => {
  it("a direct raw UPDATE on credit_transaction via the connection RAISEs — no in-place edit is representable", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 50, related_id: null });
    expect(() =>
      harness.conn.db.exec(
        "UPDATE credit_transaction SET amount_units = 999 WHERE workspace_id = 'ws-credit-settle'",
      ),
    ).toThrowError(/append_only/i);
  });

  it("a direct raw DELETE on credit_transaction via the connection RAISEs — no row removal is representable", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 50, related_id: null });
    expect(() =>
      harness.conn.db.exec(
        "DELETE FROM credit_transaction WHERE workspace_id = 'ws-credit-settle'",
      ),
    ).toThrowError(/append_only/i);
  });
});
