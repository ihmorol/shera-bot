/**
 * FEATURE QA journey 6 — the credit ledger.
 *
 * The user journey: the account is nearly broke, an automated run hits the
 * model leg, and the D48 story plays out over the REAL surfaces — the run
 * pauses VISIBLY with reason `insufficient_credits` (never a silent stall,
 * never a QUEUED placement), the model call never happens, the credits pill
 * reads exhausted, and the trigger re-arms paused. The recorded control-plane
 * top-up (S32) then applies the grant, resumes the paused run, the run
 * COMPLETES through the re-drive (reserve → call → settle), the drill-down
 * sums exactly to the ledger, a replayed top-up id cannot double-grant, and
 * the cancel path releases a hold with reason `task_cancelled`.
 *
 * The only service seams are the recorded channels: the ledger grant (the
 * funding path), `fireOccurrence` (the operator/scheduler fire seam), and
 `applyCreditTopUp` (the S32 internal admin command — the same one the
 * control plane drives over the internal channel). Everything user-visible
 * is HTTP.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
  type FeatureRuntime,
} from "./helpers/runtime-harness.js";

const USER = { type: "user", id: "user_emon" } as const;
const ADMIN = { type: "admin", id: "admin-token:j6" } as const;
const FIXTURE_KEY = "sk-fixture-0123456789abcdefSECRET";
const FIXTURE_COMPLETION = "Sweep compiled after the top-up.";

let completions = 0;
const completionServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    completions += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-j6",
        object: "chat.completion",
        created: 0,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: FIXTURE_COMPLETION },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5000, completion_tokens: 2000, total_tokens: 7000 },
      }),
    );
  });
});

let serverListening = false;
async function completionOrigin(): Promise<string> {
  if (!serverListening) {
    serverListening = true;
    await new Promise<void>((resolve) => completionServer.listen(0, "127.0.0.1", resolve));
  }
  return `http://127.0.0.1:${(completionServer.address() as AddressInfo).port}/v1`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => completionServer.close(() => resolve()));
  await cleanupTempResources();
});

const openRuntimes: FeatureRuntime[] = [];

afterEach(async () => {
  completions = 0;
});

async function composeFundedJourney(): Promise<FeatureRuntime> {
  const journey = await composeJourney({ providerEnforcement: true });
  openRuntimes.push(journey);
  return journey;
}

describe("J6: credit ledger", () => {
  it("the broke account pauses visibly, the top-up resumes and completes the run, and a replayed top-up cannot double-grant", async () => {
    const journey = await composeFundedJourney();
    const { origin, runtime } = journey;
    const ledger = runtime.credits;

    // ── Funding: a TINY grant — the pre-flight consult passes, the model
    // leg's bounded estimate does not. ──
    ledger.ensureAccount(WS);
    ledger.grant({ workspace_id: WS, amount_units: 1, related_id: null });

    // The platform provider (the E9 admin provisioning path — HTTP).
    const provider = await fetch(origin + "/v1/providers/platform", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS,
        provider_id: "prov_j6_platform",
        display_name: "Platform endpoint (J6)",
        protocol: "openai-compatible",
        base_url: await completionOrigin(),
        api_mode: "api_key",
        credential: FIXTURE_KEY,
        default_model_id: "fixture-model",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
      }),
    });
    expect(provider.status).toBe(201);
    const providerView = (await provider.json()) as Record<string, unknown>;
    const providerId = providerView["id"] as string;

    // The Operation + the schedule (HTTP) targeting the provider pair.
    const created = await postJson(origin, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "J6 top-up operation",
      roster_agent_ids: ["agent_researcher"],
      coordinator_agent_id: "agent_general_assistant",
    });
    expect(created.status).toBe(201);
    const operationId = (created.body as { operation_id: string }).operation_id;
    const schedule = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      kind: "schedule",
      name: "J6 schedule",
      target_operation_id: operationId,
      config: {
        cron: "0 9 * * 1",
        plan: { prompt: "Compile the sweep." },
        provider: { provider_id: providerId, model: "fixture-model" },
      },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(schedule.status).toBe(201);
    const triggerId = (schedule.body as { trigger_id: string }).trigger_id;

    // ── THE FIRE: the run pauses for credits, visibly ──
    completions = 0;
    const dueAt = "2026-11-02T09:00:00.000Z";
    const outcome = await runtime.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: `schedule:${triggerId}:${dueAt}`,
      dueAt,
      detail: { due_at: dueAt },
    });
    expect(outcome.outcome).toBe("paused_credits");
    const runId = (outcome as { runId: string | null }).runId;
    expect(runId).toBeTruthy();

    // The run reads PAUSED through the HTTP runs list (the run card).
    const runs = await getJson(origin, `/v1/operations/${operationId}/runs?workspace_id=${WS}`);
    const runRow = (runs.body["runs"] as Array<Record<string, unknown>>).find(
      (row) => row["run_id"] === runId,
    );
    expect(runRow).toMatchObject({ state: "PAUSED" });

    // The typed run.credit_paused record with the explicit reason.
    const stream = runtime.journal.readFrom(WS, `task:${runId!}`, 0, 100);
    const pauseRecord = stream.find((row) => row.event_type === "run.credit_paused");
    expect(pauseRecord).toBeDefined();
    expect(JSON.parse(pauseRecord!.payload)).toMatchObject({ reason: "insufficient_credits" });

    // The model call never happened (the reservation refused first).
    expect(completions).toBe(0);

    // The credits pill reads the LEDGER'S OWN numbers (HTTP): the 1-unit
    // grant is still unspent (the pause is the RESERVATION estimate's
    // refusal, not the exhaustion flag).
    const summary = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(summary.body["account"]).toMatchObject({
      granted_units: 1,
      charged_units: 0,
      reserved_units: 0,
      remaining_units: 1,
      exhausted: false,
    });

    // The credit-paused trigger pauses with the recorded reason (it re-arms
    // at the top-up).
    const triggerView = runtime.schedules.getTriggerView(WS, triggerId);
    expect(triggerView).toMatchObject({ state: "paused", pause_reason: "insufficient_credits" });

    // ── THE TOP-UP: the recorded S32 command — grant + resume + re-drive ──
    const applied = await runtime.adminCommands.applyCreditTopUp({
      workspaceId: WS,
      topupId: "topup_j6_0001",
      amount: 100,
      actor: ADMIN,
    });
    expect(applied.resumed_run_ids).toEqual([runId]);

    // The resumed run COMPLETES: the re-drive re-walked it with the funded
    // account (reserve → call → settle).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const resumedRuns = await getJson(
      origin,
      `/v1/operations/${operationId}/runs?workspace_id=${WS}`,
    );
    const resumedRow = (resumedRuns.body["runs"] as Array<Record<string, unknown>>).find(
      (row) => row["run_id"] === runId,
    );
    expect(resumedRow).toMatchObject({ state: "SUCCEEDED" });
    expect(completions).toBe(1);

    // The credits read model reconciles: grant 101, charge 70, remainder 31.
    const after = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(after.body["account"]).toMatchObject({
      granted_units: 101,
      charged_units: 70,
      reserved_units: 0,
      remaining_units: 31,
      exhausted: false,
    });

    // The drill-down sums EXACTLY to the ledger (AC8's pinning read).
    const drill = await getJson(origin, `/v1/credits/runs/${runId!}?workspace_id=${WS}`);
    expect(drill.body["charged_units"]).toBe(70);
    expect(drill.body["charged_units"]).toBe(
      (after.body["account"] as Record<string, unknown>)["charged_units"],
    );

    // The trigger re-armed: active again, no pause reason.
    const rearmed = runtime.schedules.getTriggerView(WS, triggerId);
    expect(rearmed).toMatchObject({ state: "active", pause_reason: null });

    // ── THE REPLAY: the same topup id cannot double-grant ──
    const replayed = await runtime.adminCommands.applyCreditTopUp({
      workspaceId: WS,
      topupId: "topup_j6_0001",
      amount: 100,
      actor: ADMIN,
    });
    expect(replayed.grant_deduplicated).toBe(true);
    expect(replayed.resumed_run_ids).toEqual([]);
    const afterReplay = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect((afterReplay.body["account"] as Record<string, unknown>)["granted_units"]).toBe(101);
    expect(completions).toBe(1); // the completed run was not re-driven
  });

  it("cancelling a credited run releases the hold with reason task_cancelled — the reserved counter is given back", async () => {
    const journey = await composeFundedJourney();
    const { origin, runtime } = journey;
    const ledger = runtime.credits;
    ledger.ensureAccount(WS);
    ledger.grant({ workspace_id: WS, amount_units: 200, related_id: null });

    const created = await postJson(origin, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "J6 cancel-release operation",
      roster_agent_ids: ["agent_researcher"],
      coordinator_agent_id: "agent_general_assistant",
    });
    expect(created.status).toBe(201);
    const operationId = (created.body as { operation_id: string }).operation_id;
    const run = await postJson(origin, `/v1/operations/${operationId}/runs`, {
      workspace_id: WS,
      run_id: "run_j6_cancel_release",
    });
    expect(run.status).toBe(201);

    // The hold taken through the runtime's OWN credits service (the seam the
    // model leg consults — never a test-only funding path).
    const reserved = ledger.reserveForRun({
      workspace_id: WS,
      task_id: "run_j6_cancel_release",
      estimate_units: 50,
    });
    if (!reserved.ok) throw new Error("the hold was refused before the cancel");

    // Pre-state: the hold is visible in the pill (50 reserved).
    const before = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(before.body["account"]).toMatchObject({
      granted_units: 200,
      charged_units: 0,
      reserved_units: 50,
    });

    // The USER stop control through the composed HTTP route.
    const cancel = await postJson(
      origin,
      `/v1/operations/${operationId}/runs/run_j6_cancel_release/cancel`,
      { workspace_id: WS, cancelled_by: { type: "user", id: "user_emon" } },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body["outcome"]).toBe("cancelled");

    // The release: the reserved counter is given back, the movement row
    // records reason task_cancelled, and the drill-down renders the release.
    const after = await getJson(origin, `/v1/credits?workspace_id=${WS}`);
    expect(after.body["account"]).toMatchObject({
      granted_units: 200,
      charged_units: 0,
      reserved_units: 0,
    });
    const drill = (await getJson(
      origin,
      `/v1/credits/runs/run_j6_cancel_release?workspace_id=${WS}`,
    )) as unknown as {
      body: { released_units: number; releases: Array<{ reason: string; released_units: number }> };
    };
    expect(drill.body["released_units"]).toBe(50);
    // The release row records the D8 cancellation reason.
    const release = (drill.body["releases"] ?? []).find((row) => row.reason === "task_cancelled");
    expect(release).toBeDefined();
    expect(release!["released_units"]).toBe(50);
  });
});
