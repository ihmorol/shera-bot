/**
 * S24 chunk 5 — the credits HTTP surface (AC8; D20, D21, G4): the summary
 * and the per-run drill-down render the LEDGER'S OWN numbers. The pinning
 * read: the drill-down sums EXACTLY to the ledger — every run's charged
 * units (net of corrections) plus the grant-side movements reconcile the
 * account, and the summary's remaining is the derived available balance.
 */
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = join(here, "../../../../../agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const OTHER_WS = "ws-other-0000";

interface CreditsRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

const openRuntimes: CreditsRuntime[] = [];

async function composeCredits(): Promise<CreditsRuntime> {
  const dbPath = join(makeTempDir("shera-s24-credits-api-"), "runtime.db");
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    await runtime.close();
  }
  await cleanupTempResources();
});

afterAll(async () => {
  await cleanupTempResources();
});

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the credits HTTP surface (S24 AC8)", () => {
  it("the summary renders the ledger's own numbers — remaining, reserved, used-this-month, custom usage", async () => {
    const credits = await composeCredits();
    openRuntimes.push(credits);
    const { runtime, origin } = credits;
    const ledger = runtime.credits;
    ledger.ensureAccount(WS);
    ledger.grant({ workspace_id: WS, amount_units: 200, related_id: "topup_seed" });

    // Two runs draw the balance down; a custom-provider call records usage
    // with zero credit movement.
    const runA = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_api_a",
      estimate_units: 50,
    });
    if (!runA.ok) throw new Error("reserve A refused");
    ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runA.reservation_id,
      actual_units: 30,
    });
    const runB = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_api_b",
      estimate_units: 40,
    });
    if (!runB.ok) throw new Error("reserve B refused");
    ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runB.reservation_id,
      actual_units: 20,
    });
    ledger.recordUsage({
      workspace_id: WS,
      usage_id: "usage_custom_1",
      task_id: "run_custom",
      provider_id: "prov_custom",
      model: "custom-model",
      provider_origin: "user",
      input_tokens: 1200,
      output_tokens: 300,
      latency_ms: 410,
      charged_units: 0,
    });

    const summary = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(summary.status).toBe(200);
    const account = summary.body["account"] as Record<string, unknown>;
    expect(account).toMatchObject({
      granted_units: 200,
      charged_units: 50,
      reserved_units: 0,
      remaining_units: 150,
      used_this_month_units: 50,
      exhausted: false,
    });
    expect(summary.body["custom_provider_usage"]).toMatchObject({
      calls: 1,
      input_tokens: 1200,
      output_tokens: 300,
      providers: ["prov_custom"],
    });

    // An exhausted account reads as exhausted (the pause card's flag).
    const broke = await composeCredits();
    openRuntimes.push(broke);
    broke.runtime.credits.ensureAccount(WS);
    const brokeSummary = await getJson(broke.origin, `/v1/credits?workspace_id=${WS}`);
    expect((brokeSummary.body["account"] as Record<string, unknown>)["exhausted"]).toBe(true);
  });

  it("the per-run drill-down sums EXACTLY to the ledger — corrections included", async () => {
    const credits = await composeCredits();
    openRuntimes.push(credits);
    const { runtime, origin } = credits;
    const ledger = runtime.credits;
    ledger.ensureAccount(WS);
    ledger.grant({ workspace_id: WS, amount_units: 200, related_id: null });

    const runA = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_drill_a",
      estimate_units: 60,
    });
    if (!runA.ok) throw new Error("reserve A refused");
    ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runA.reservation_id,
      actual_units: 40,
    });
    const runB = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_drill_b",
      estimate_units: 30,
    });
    if (!runB.ok) throw new Error("reserve B refused");
    ledger.settleReservation({
      workspace_id: WS,
      reservation_id: runB.reservation_id,
      actual_units: 10,
    });
    // A correction on run A's charge: the drill-down nets it.
    const movementsA = (await getJson(origin, `/v1/credits/runs/run_drill_a?workspace_id=${WS}`))
      .body as unknown as { movements: Array<{ transaction_id: string; entry_type: string }> };
    const chargeRow = movementsA.movements.find((row) => row.entry_type === "settlement_charge");
    expect(chargeRow).toBeDefined();
    ledger.correctTransaction({
      workspace_id: WS,
      corrects_transaction_id: chargeRow!.transaction_id,
      amount_units: 5,
    });

    // The drill-downs sum EXACTLY to the account: every run's charged_units
    // net to the charged counter (the grants hold no task_id).
    const account = ledger.accountState(WS)!;
    const drillA = (await getJson(origin, `/v1/credits/runs/run_drill_a?workspace_id=${WS}`))
      .body as unknown as { charged_units: number; released_units: number; usage: unknown[] };
    const drillB = (await getJson(origin, `/v1/credits/runs/run_drill_b?workspace_id=${WS}`))
      .body as unknown as { charged_units: number };
    expect(drillA).toMatchObject({ charged_units: 35, released_units: 20 });
    expect(drillB).toMatchObject({ charged_units: 10 });
    expect(drillA.charged_units + drillB.charged_units).toBe(account.charged_units);

    // An active hold shows in the drill-down (the run mid-call).
    const runC = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_drill_c",
      estimate_units: 25,
    });
    if (!runC.ok) throw new Error("reserve C refused");
    const drillC = (await getJson(origin, `/v1/credits/runs/run_drill_c?workspace_id=${WS}`))
      .body as unknown as { charged_units: number; active_reserved_units: number };
    expect(drillC).toMatchObject({ charged_units: 0, active_reserved_units: 25 });
    const accountWithHold = ledger.accountState(WS)!;
    expect(accountWithHold.reserved_units).toBe(25);
  });

  it("typed refusals: workspace mismatch 403, unknown run 404, missing workspace 400", async () => {
    const credits = await composeCredits();
    openRuntimes.push(credits);
    const { runtime, origin } = credits;
    runtime.credits.ensureAccount(WS);

    const mismatch = await getJson(origin, `/v1/credits?workspace_id=${OTHER_WS}`);
    expect(mismatch.status).toBe(403);
    const missing = await getJson(origin, "/v1/credits");
    expect(missing.status).toBe(400);
    const unknownRun = await getJson(origin, `/v1/credits/runs/run_missing?workspace_id=${WS}`);
    expect(unknownRun.status).toBe(404);
    const mismatchRun = await getJson(origin, `/v1/credits/runs/run_x?workspace_id=${OTHER_WS}`);
    expect(mismatchRun.status).toBe(403);
  });
});
