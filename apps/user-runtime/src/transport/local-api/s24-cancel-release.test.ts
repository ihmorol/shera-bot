/**
 * S24 review fix F6 — the composed cancellation→ledger release e2e: a REAL
 * composed runtime (real SQLite, real HTTP, the production composition)
 * cancels a credited run, and the recorded S22 cancellation seam closes the
 * run's credit hold through the REAL ledger — reason `task_cancelled`, the
 * `reservation_release` movement row recorded, the account's reserved
 * counter given back. The composed e2e is the pin the unit suites could
 * not be: the release fires through the composed `reservations` port (the
 * same RunCancellationService the user stop control uses), not through a
 * test-owned ledger handle.
 *
 * The hold is taken through the runtime's OWN credits service (the same
 * seam the model leg consults — never a test-only funding path, G4); the
 * reads are the credits HTTP surface's own drill-down and summary, so the
 * assertion is what the UI renders (AC8's pinning read).
 *
 * Governing records: PRD §9; D20, D8; review F6; E35 (the S22 release seam).
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
const ACTOR = { type: "user" as const, id: "user_owner" };
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

const runtimes: Array<{ runtime: RuntimeHandle; origin: string }> = [];

afterEach(async () => {
  for (const handle of runtimes.splice(0)) {
    await handle.runtime.close();
  }
  await cleanupTempResources();
});

afterAll(async () => {
  await cleanupTempResources();
});

async function composeCancellationRuntime(): Promise<{ runtime: RuntimeHandle; origin: string }> {
  const dbPath = join(makeTempDir("shera-s24-cancel-release-"), "runtime.db");
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  const handle = { runtime, origin: `http://127.0.0.1:${address.port}` };
  runtimes.push(handle);
  return handle;
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the composed cancellation closes the credited run's hold (review F6)", () => {
  it("cancelling a credited run releases the hold with reason task_cancelled — the movement row lands and the account's reserved counter is given back", async () => {
    const { runtime, origin } = await composeCancellationRuntime();

    // The account is funded and the run holds a REAL reservation through
    // the runtime's own credits service (the model leg's seam).
    const ledger = runtime.credits;
    ledger.ensureAccount(WS);
    ledger.grant({ workspace_id: WS, amount_units: 200, related_id: null });
    const created = await postJson(origin, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "S24 cancel-release op",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: GENERAL,
    });
    expect(created.status).toBe(201);
    const operationId = (created.body as { operation_id: string }).operation_id;
    const run = await postJson(origin, `/v1/operations/${operationId}/runs`, {
      workspace_id: WS,
      run_id: "run_cancel_release",
    });
    expect(run.status).toBe(201);

    const reserved = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_cancel_release",
      estimate_units: 50,
    });
    if (!reserved.ok) throw new Error("the hold was refused before the cancel");
    expect(reserved.ok).toBe(true);

    // Pre-state: the hold is visible in the summary (50 reserved).
    const before = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(before.status).toBe(200);
    expect(before.body["account"]).toMatchObject({
      granted_units: 200,
      charged_units: 0,
      reserved_units: 50,
    });

    // The USER stop control through the composed HTTP route — the recorded
    // D8 cancellation, the same path the run's stop button drives.
    const cancel = await postJson(origin, `/v1/operations/${operationId}/runs/run_cancel_release/cancel`, {
      workspace_id: WS,
      cancelled_by: ACTOR,
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({
      outcome: "cancelled",
      state: "CANCELLED",
      reservation_release_requested: true,
    });

    // The drill-down: the release row names the CANCELLATION reason, the
    // movement row is the ledger's own reservation_release, and nothing
    // stays held.
    const drillDown = await getJson(origin, `/v1/credits/runs/run_cancel_release?workspace_id=${WS}`);
    expect(drillDown.status).toBe(200);
    const releases = drillDown.body["releases"] as Array<Record<string, unknown>>;
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      reservation_id: reserved.reservation_id,
      task_id: "run_cancel_release",
      released_units: 50,
      reason: "task_cancelled",
    });
    const movements = drillDown.body["movements"] as Array<Record<string, unknown>>;
    const releaseMovements = movements.filter((row) => row["entry_type"] === "reservation_release");
    expect(releaseMovements).toHaveLength(1);
    expect(releaseMovements[0]).toMatchObject({ amount_units: 50 });
    expect(drillDown.body["active_reserved_units"]).toBe(0);

    // The account delta: the hold is given back — reserved 50 → 0, nothing
    // charged, the balance whole again.
    const after = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(after.status).toBe(200);
    expect(after.body["account"]).toMatchObject({
      granted_units: 200,
      charged_units: 0,
      reserved_units: 0,
      remaining_units: 200,
    });
  });
});
