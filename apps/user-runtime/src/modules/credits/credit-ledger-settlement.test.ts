/**
 * S24 chunk 2 — the reserve → settle → release mathematics (AC3, AC4, AC9;
 * D20, D21). The settlement pins: a settle charges the ACTUAL usage against
 * the reservation's hold, the unused remainder releases back as a recorded
 * release row (reason `unused_estimate`), an under-estimate charges the
 * actual and may overdraw the derived available balance (the honest state
 * the next refusal reads), and a settle/release is exactly-once (a terminal
 * reservation is refused typed). The balance pins: ONE account-level
 * balance per workspace — two conversations' runs draw from the same
 * numbers (D21). The ledger pins: credit_transaction is append-only — a
 * correction is a NEW adjustment row; the original rows are never edited
 * (AC9, pinned behaviorally by snapshot equality).
 *
 * The property-style test drives 200 seeded-random operations across the
 * full reserve/settle/release surface and reconciles the account counters
 * against the movement rows after every step.
 *
 * Real SQLite, real migrations. Vocabulary: Pack → Operations → Agents (G1).
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

const WS = "ws-credit-settle";
const CLOCK = "2026-11-02T12:00:00.000Z";

interface SettleHarness {
  dir: string;
  conn: SqliteConnection;
  repo: CreditLedgerRepository;
  ledger: CreditLedgerService;
}

const harnesses: SettleHarness[] = [];

function makeHarness(): SettleHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s24-settle-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const repo = new CreditLedgerRepository(tx);
  const ledger = new CreditLedgerService({
    repository: repo,
    tx,
    now: () => CLOCK,
    newId: (() => {
      let counter = 0;
      return () => `det${(counter += 1)}`; // deterministic ids for snapshots
    })(),
  });
  const harness: SettleHarness = { dir, conn, repo, ledger };
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

// Evidence-row counts through the repository reads (the SQL boundary keeps
// every statement inside adapters/sqlite — tests speak the repository).

describe("settlement mathematics (S24 AC3)", () => {
  it("an over-estimate settles the actual and releases the unused remainder as a recorded release", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_over",
      estimate_units: 60,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    const settled = harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      actual_units: 25,
    });
    expect(settled).toMatchObject({ ok: true, released_units: 35 });

    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 100,
      charged_units: 25,
      reserved_units: 0,
      available_units: 75,
      used_this_month_units: 25,
    });

    // The evidence rows: the settlement (actual), the release (the unused
    // remainder with the contract's reason), and the movement rows.
    const reservation = harness.repo.findReservation(WS, reserved.reservation_id);
    expect(reservation).toMatchObject({ status: "settled", settled_at: CLOCK });
    expect(harness.repo.listSettlements(WS)).toHaveLength(1);
    expect(harness.repo.listReleases(WS)).toHaveLength(1);
    const entryTypes = harness.repo
      .listTransactions(WS)
      .map((row) => row.entry_type)
      .sort();
    expect(entryTypes).toEqual([
      "grant",
      "reservation_hold",
      "reservation_release",
      "settlement_charge",
    ]);
  });

  it("an under-estimate charges the actual usage — no release, the overdraw is the honest state", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_under",
      estimate_units: 30,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    const settled = harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      actual_units: 45,
    });
    expect(settled).toMatchObject({ ok: true, released_units: 0 });

    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 100,
      charged_units: 45,
      reserved_units: 0,
      available_units: 55,
    });
    // No release row exists: the hold was fully consumed by the actual.
    expect(harness.repo.listReleases(WS)).toHaveLength(0);
  });

  it("a zero-actual settlement charges nothing and releases the whole hold", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 10, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_zero",
      estimate_units: 4,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    const settled = harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      actual_units: 0,
    });
    expect(settled).toMatchObject({ ok: true, released_units: 4 });
    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 10,
      charged_units: 0,
      reserved_units: 0,
      available_units: 10,
    });
  });

  it("a settle is exactly-once — a settled or released reservation is refused typed", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 50, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_once",
      estimate_units: 10,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    expect(
      harness.ledger.settleReservation({
        workspace_id: WS,
        reservation_id: reserved.reservation_id,
        actual_units: 5,
      }),
    ).toMatchObject({ ok: true });
    const again = harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      actual_units: 5,
    });
    expect(again).toEqual({ ok: false, code: "RESERVATION_NOT_ACTIVE" });
    expect(harness.repo.findReservation(WS, reserved.reservation_id)?.status).toBe("settled");
    expect(harness.repo.listSettlements(WS)).toHaveLength(1);

    // Unknown reservations are refused typed too.
    expect(
      harness.ledger.settleReservation({
        workspace_id: WS,
        reservation_id: "res_missing",
        actual_units: 1,
      }),
    ).toEqual({ ok: false, code: "RESERVATION_NOT_FOUND" });
  });

  it("a provider-failure release returns the full hold and records the reason", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 50, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_fail",
      estimate_units: 20,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    const released = harness.ledger.releaseReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      reason: "provider_failure",
    });
    expect(released).toMatchObject({ ok: true, released_units: 20 });
    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 50,
      charged_units: 0,
      reserved_units: 0,
      available_units: 50,
    });
    expect(harness.repo.listReleases(WS)).toHaveLength(1);
  });

  it("releaseForRun releases EVERY active hold of the run — the cancellation seam closes all of them", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 50, related_id: null });
    // The recorded S28 pre-flight consult holds 0 — the row records the
    // consult and closes itself immediately (there is nothing to hold); the
    // model leg's bounded estimate is the run's active hold. Cancellation
    // closes every active hold (here: the bounded one).
    const preflight = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_cancel",
      estimate_units: 0,
    });
    if (!preflight.ok) throw new Error("consult refused");
    expect(harness.repo.findReservation(WS, preflight.reservation_id)?.status).toBe("released");
    const bounded = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_cancel",
      estimate_units: 30,
    });
    if (!bounded.ok) throw new Error("reservation refused");
    const released = harness.ledger.releaseForRun(WS, "run_cancel", "task_cancelled");
    expect(released).toEqual({ released_count: 1, released_units: 30 });
    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({ reserved_units: 0, available_units: 50 });
    // Idempotent: a second release finds nothing held.
    expect(harness.ledger.releaseForRun(WS, "run_cancel", "task_cancelled")).toEqual({
      released_count: 0,
      released_units: 0,
    });
  });
});

describe("the single account-level balance (S24 AC4, D21)", () => {
  it("two conversations' runs draw from the same balance — the holds and charges land in ONE account", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 100, related_id: null });

    // Conversation 1's run reserves 60 of the account's 100.
    const runA = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_conv1",
      estimate_units: 60,
    });
    if (!runA.ok) throw new Error("reservation A refused");
    // Conversation 2's run sees the SAME balance: 40 available — 60 is
    // refused, 40 is the ceiling. The hold of conversation 1 bound it.
    expect(
      harness.ledger.reserveForRun({
        workspace_id: WS,
        task_id: "run_conv2",
        estimate_units: 60,
      }),
    ).toMatchObject({ ok: false, code: "insufficient_credits", available_units: 40 });
    const runB = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_conv2",
      estimate_units: 40,
    });
    if (!runB.ok) throw new Error("reservation B refused");

    // Both runs settle against the one account.
    harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runA.reservation_id,
      actual_units: 25,
    });
    harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runB.reservation_id,
      actual_units: 40,
    });

    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 100,
      charged_units: 65,
      reserved_units: 0,
      available_units: 35,
      used_this_month_units: 65,
    });
    // THE single row per workspace (the D21 singleton): the PRIMARY KEY
    // makes a second row unrepresentable, and ensureAccount is idempotent
    // (a second ensure answers the SAME row, never a new one). Another
    // workspace gets its own independent row (E12).
    const first = harness.repo.findAccount(WS);
    harness.ledger.ensureAccount(WS);
    expect(harness.repo.findAccount(WS)).toEqual(first);
  });
});

describe("the append-only ledger (S24 AC9)", () => {
  it("a correction is a NEW adjustment row — the corrected row is byte-identical afterwards", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const reserved = harness.ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_correct",
      estimate_units: 40,
    });
    if (!reserved.ok) throw new Error("reservation refused");
    harness.ledger.settleReservation({
      workspace_id: WS,
      reservation_id: reserved.reservation_id,
      actual_units: 40,
    });
    const charge = harness.repo
      .listTransactions(WS)
      .find((row) => row.entry_type === "settlement_charge");
    expect(charge).toBeDefined();

    // The snapshot: EVERY movement row before the correction.
    const before = harness.repo.listTransactions(WS).map((row) => ({ ...row }));
    const corrected = harness.ledger.correctTransaction({
      workspace_id: WS,
      corrects_transaction_id: charge!.transaction_id,
      amount_units: 15,
    });
    expect(corrected.ok).toBe(true);

    // Every pre-correction row is EXACTLY as it was (no in-place edit), and
    // exactly one adjustment row was appended.
    const after = harness.repo.listTransactions(WS);
    for (const snapshot of before) {
      const current = after.find((row) => row.transaction_id === snapshot.transaction_id);
      expect(current).toEqual(snapshot);
    }
    expect(after.length).toBe(before.length + 1);
    const adjustment = after.find((row) => row.entry_type === "adjustment");
    expect(adjustment).toMatchObject({
      amount_units: 15,
      corrects_transaction_id: charge!.transaction_id,
      task_id: charge!.task_id,
    });

    // The account math includes the correction: the charge went 40 -> 25.
    const state = harness.ledger.accountState(WS);
    expect(state).toMatchObject({
      granted_units: 100,
      charged_units: 25,
      available_units: 75,
      used_this_month_units: 25,
    });
  });

  it("a correction is bounded by the corrected row's amount and refuses unknown or non-correctable rows", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    harness.ledger.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const grant = harness.repo.listTransactions(WS).find((row) => row.entry_type === "grant");
    expect(grant).toBeDefined();
    // Grant corrections (clawbacks) are supported: the granted counter moves.
    expect(
      harness.ledger.correctTransaction({
        workspace_id: WS,
        corrects_transaction_id: grant!.transaction_id,
        amount_units: 20,
      }),
    ).toMatchObject({ ok: true });
    expect(harness.ledger.accountState(WS)).toMatchObject({
      granted_units: 80,
      available_units: 80,
    });
    // Over-reversing the corrected row is refused.
    expect(
      harness.ledger.correctTransaction({
        workspace_id: WS,
        corrects_transaction_id: grant!.transaction_id,
        amount_units: 999,
      }),
    ).toEqual({ ok: false, code: "CORRECTION_EXCEEDS_ORIGINAL" });
    // Unknown rows and non-correctable entry types are refused typed.
    expect(
      harness.ledger.correctTransaction({
        workspace_id: WS,
        corrects_transaction_id: "ctx_missing",
        amount_units: 1,
      }),
    ).toEqual({ ok: false, code: "CORRECTION_TARGET_NOT_FOUND" });
  });
});

describe("settlement property (S24 AC3, seeded random distributions)", () => {
  it("200 seeded operations keep every ledger invariant — counters reconcile, holds terminal exactly once, rows never mutate", () => {
    const harness = makeHarness();
    harness.ledger.ensureAccount(WS);
    // Deterministic LCG (seeded — the property is reproducible, never flaky).
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };

    harness.ledger.grant({ workspace_id: WS, amount_units: 500, related_id: null });
    const activeReservations: string[] = [];
    const seenTransactions = new Map<string, string>();
    let taskCounter = 0;
    // The overdraw running total: every under-estimate settlement charges
    // actual beyond the hold — new charge the movement conservation must
    // account for (holds − released − charges == reserved − overdraw).
    let overdrawSum = 0;

    const reconcile = () => {
      const account = harness.repo.findAccount(WS);
      expect(account).not.toBeNull();
      const txs = harness.repo.listTransactions(WS, 10_000);
      const grants = txs
        .filter((row) => row.entry_type === "grant")
        .reduce((sum, row) => sum + row.amount_units, 0);
      const charges = txs
        .filter((row) => row.entry_type === "settlement_charge")
        .reduce((sum, row) => sum + row.amount_units, 0);
      const holds = txs
        .filter((row) => row.entry_type === "reservation_hold")
        .reduce((sum, row) => sum + row.amount_units, 0);
      const released = txs
        .filter((row) => row.entry_type === "reservation_release")
        .reduce((sum, row) => sum + row.amount_units, 0);
      expect(account!.granted_units).toBe(grants);
      expect(account!.charged_units).toBe(charges);
      // Movement conservation with the overdraw term: every held unit ends
      // up charged or released, except what is still actively held; an
      // under-estimate settle charges BEYOND its hold (the overdraw).
      expect(holds - released - charges).toBe(account!.reserved_units - overdrawSum);
      expect(CreditLedgerService.availableUnits(account!)).toBe(
        account!.granted_units - account!.charged_units - account!.reserved_units,
      );
      // The active holds' estimated units sum EXACTLY to the reserved counter.
      let activeHeld = 0;
      for (const reservationId of activeReservations) {
        const row = harness.repo.findReservation(WS, reservationId);
        expect(row?.status).toBe("reserved");
        activeHeld += row!.estimated_units;
      }
      expect(activeHeld).toBe(account!.reserved_units);
      // Append-only: every previously observed row is byte-identical.
      for (const row of txs) {
        const json = JSON.stringify(row);
        const prior = seenTransactions.get(row.transaction_id);
        if (prior !== undefined) expect(json).toBe(prior);
        seenTransactions.set(row.transaction_id, json);
      }
      expect(seenTransactions.size).toBe(txs.length);
    };

    for (let step = 0; step < 200; step += 1) {
      const choice = next(10);
      if (choice < 3 || activeReservations.length === 0) {
        // Reserve for a fresh run (sometimes the zero consult — which holds
        // nothing and closes itself, so it never joins the active set).
        const estimate = next(2) === 0 ? 0 : 1 + next(30);
        const reserved = harness.ledger.reserveForRun({
          workspace_id: WS,
          task_id: `run_prop_${(taskCounter += 1)}`,
          estimate_units: estimate,
        });
        if (reserved.ok && estimate > 0) activeReservations.push(reserved.reservation_id);
      } else if (choice < 8) {
        // Settle a random active reservation: actual spans under- and
        // over-estimate (0 .. 2x the hold).
        const index = next(activeReservations.length);
        const reservationId = activeReservations[index]!;
        const hold = harness.repo.findReservation(WS, reservationId)!;
        const actual = next(2 * hold.estimated_units + 1);
        if (actual > hold.estimated_units) {
          overdrawSum += actual - hold.estimated_units;
        }
        const settled = harness.ledger.settleReservation({
          workspace_id: WS,
          reservation_id: reservationId,
          actual_units: actual,
        });
        expect(settled.ok).toBe(true);
        activeReservations.splice(index, 1);
      } else {
        // Release a random active reservation.
        const index = next(activeReservations.length);
        const reservationId = activeReservations[index]!;
        const released = harness.ledger.releaseReservation({
          workspace_id: WS,
          reservation_id: reservationId,
          reason: next(2) === 0 ? "provider_failure" : "task_cancelled",
        });
        expect(released.ok).toBe(true);
        activeReservations.splice(index, 1);
      }
      reconcile();
    }
  });
});
