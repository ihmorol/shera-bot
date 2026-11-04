/**
 * S24 review fix F7 — the aggregation reads cannot silently truncate. The
 * `used_this_month` summary computed over `listTransactions`' default
 * 200-row bound, and `runCost`/`runsSummary` over an explicit 10,000-row
 * bound, undercount a busy account: the displayed truth must be the WHOLE
 * ledger's, so the reads aggregate in SQL (SUM over the month window /
 * per-task movements) instead of filtering an in-memory page.
 *
 * The pins drive MORE rows than each bound (250 charges past the 200
 * default; a 10,050-movement workspace past the 10,000 bound) and hold the
 * numbers to the full sum. Real SQLite, real migrations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { CreditLedgerRepository } from "../../adapters/sqlite/credit-ledger-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { CreditLedgerService } from "./credit-ledger.service.ts";

const WS = "ws-credit-agg";
const CLOCK = "2026-11-02T12:00:00.000Z";

interface AggHarness {
  dir: string;
  conn: SqliteConnection;
  repo: CreditLedgerRepository;
  ledger: CreditLedgerService;
  tx: SqliteTransactions;
}

const harnesses: AggHarness[] = [];

function makeHarness(): AggHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s24-agg-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const repo = new CreditLedgerRepository(tx);
  const ledger = new CreditLedgerService({ repository: repo, tx, now: () => CLOCK });
  const harness: AggHarness = { dir, conn, repo, ledger, tx };
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

function seedCharges(
  harness: AggHarness,
  taskId: string,
  count: number,
  createdAt: string,
  amountUnits = 1,
): void {
  harness.tx.transaction((exec) => {
    for (let index = 0; index < count; index += 1) {
      const transactionId = `ctx_${taskId}_${String(index).padStart(6, "0")}`;
      harness.repo.insertTransaction(
        {
          workspace_id: WS,
          transaction_id: transactionId,
          entry_type: "settlement_charge",
          amount_units: amountUnits,
          task_id: taskId,
          reservation_id: `res_${transactionId}`,
          related_id: null,
          corrects_transaction_id: null,
          created_at: createdAt,
        },
        exec,
      );
      harness.repo.applyAccountDelta(WS, { charged: amountUnits }, createdAt, exec);
    }
    return null;
  });
}

describe("the aggregation reads see past the list bounds (review F7)", () => {
  it("used_this_month sums the WHOLE month window — 250 charges past the 200-row list default still read 250", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 1000, related_id: null });
    seedCharges(harness, "run_wide", 250, "2026-11-02T08:00:00.000Z");
    expect(harness.repo.listTransactions(WS)).toHaveLength(200); // the list bound holds
    const state = harness.ledger.accountState(WS);
    expect(state).not.toBeNull();
    expect(state?.used_this_month_units).toBe(250);
    expect(state?.charged_units).toBe(250);
  });

  it("runCost reads the run's OWN rows, not a 10,000-row workspace page — 50 old charges survive 10,000 newer ones", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 20_000, related_id: null });
    // The target run's charges are the OLDEST rows (they fall outside the
    // newest-10,000 window of the workspace-wide list).
    seedCharges(harness, "run_old", 50, "2026-11-01T00:00:00.000Z");
    for (let batch = 0; batch < 20; batch += 1) {
      seedCharges(harness, `run_noise_${batch}`, 505, "2026-11-02T09:00:00.000Z");
    }
    expect(harness.repo.listTransactions(WS, 10_000)).toHaveLength(10_000); // the page is full

    const drill = harness.ledger.runCost(WS, "run_old");
    expect(drill).not.toBeNull();
    expect(drill?.charged_units).toBe(50);
    expect(drill?.movements).toHaveLength(50);
  });

  it("runsSummary aggregates over EVERY movement — the old run is not silently dropped past the 10,000 bound", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 20_000, related_id: null });
    seedCharges(harness, "run_old", 50, "2026-11-01T00:00:00.000Z");
    for (let batch = 0; batch < 20; batch += 1) {
      seedCharges(harness, `run_noise_${batch}`, 505, "2026-11-02T09:00:00.000Z");
    }

    const summary = harness.ledger.runsSummary(WS, 50);
    const oldRun = summary.find((row) => row.task_id === "run_old");
    expect(oldRun).toBeDefined();
    expect(oldRun?.charged_units).toBe(50);
  });

  it("the month netting is exact in the aggregate — a charge-reversing adjustment subtracts at any ledger size", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 1000, related_id: null });
    seedCharges(harness, "run_wide", 220, "2026-11-02T08:00:00.000Z");
    // A charge-reversing correction (a NEW adjustment row naming the target).
    const target = harness.repo
      .listTransactions(WS)
      .find((row) => row.entry_type === "settlement_charge");
    harness.repo.insertTransaction({
      workspace_id: WS,
      transaction_id: "ctx_adjust_1",
      entry_type: "adjustment",
      amount_units: 20,
      task_id: target?.task_id ?? null,
      reservation_id: target?.reservation_id ?? null,
      related_id: null,
      corrects_transaction_id: target?.transaction_id ?? null,
      created_at: "2026-11-02T10:00:00.000Z",
    });
    const state = harness.ledger.accountState(WS);
    expect(state?.used_this_month_units).toBe(200);
  });
});
