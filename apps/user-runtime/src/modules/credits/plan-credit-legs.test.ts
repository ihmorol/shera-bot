/**
 * S24 chunk 3 — the credit legs of the model call (AC5, AC6, AC7, D20, D48,
 * E13, G4). The model leg of the autonomous plan runner is the runtime's
 * REAL in-runtime model call, and the credit discipline lives there:
 *
 * - AC5: a CUSTOM-provider call (origin 'user') consumes NO Shera credits —
 *   but the usage record (tokens, latency) is kept, with charged_units 0.
 * - AC6: an AMBIGUOUS platform-provider outcome (the provider may or may
 *   not have processed the request — a timeout after send) does NOT retry
 *   blindly and does NOT silently release the reservation: the outcome is
 *   recorded on the run's stream (run.credit_outcome_ambiguous) and the run
 *   enters the E13 recovery class (RECOVERY_REQUIRED) — the hold stands.
 * - AC7: an exhausted account pauses ONLY the model call — a plan with no
 *   model leg (the tool leg through the S21 executor) runs to completion
 *   with zero available credits; credits never gate a tool, a file write,
 *   or any external action (D20; no capability change).
 * - and the D20 complement: a clean provider failure (the request never
 *   landed) RELEASES the reservation (reason provider_failure).
 *
 * The model endpoint is a LOCAL fake (the S23/S28 fixture pattern) — the
 * proof is the request counter and the ledger rows, never a mock assertion.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "../../transport/local-api/compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "../../transport/local-api/compose.ts";
import { CreditLedgerRepository } from "../../adapters/sqlite/credit-ledger-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = join(here, "../../../../../agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const FIXTURE_KEY = "sk-fixture-0123456789abcdefSECRET";
const USER = { type: "user", id: "emon" };

const FIXTURE_COMPLETION = "Sweep compiled.";

let completions = 0;
const completionServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    completions += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-s24",
        object: "chat.completion",
        created: 0,
        model: "fixture-model",
        choices: [
          { index: 0, message: { role: "assistant", content: FIXTURE_COMPLETION }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5000, completion_tokens: 2000, total_tokens: 7000 },
      }),
    );
  });
});

let hangings = 0;
const hangingServer: Server = createServer(() => {
  hangings += 1; // never responds — the request is sent and may be processed
});

let listening = false;
function listenAll(): void {
  if (listening) return;
  listening = true;
  completionServer.listen(0, "127.0.0.1");
  hangingServer.listen(0, "127.0.0.1");
}
function baseUrlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => completionServer.close(() => resolve()));
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
});

const openConnections: SqliteConnection[] = [];

interface CreditRuntime {
  runtime: RuntimeHandle;
  ledgerRepo: CreditLedgerRepository;
  close(): Promise<void>;
}

async function composeCredit(modelCallTimeoutMs?: number): Promise<CreditRuntime> {
  listenAll();
  const dbPath = join(makeTempDir("shera-s24-legs-"), "runtime.db");
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    providerEnforcement: true,
    ...(modelCallTimeoutMs !== undefined ? { modelCallTimeoutMs } : {}),
  });
  trackConnection(runtime);
  const conn = openDatabase(dbPath);
  openConnections.push(conn);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  return {
    runtime,
    ledgerRepo: new CreditLedgerRepository(new SqliteTransactions(conn.db)),
    close: () => runtime.close(),
  };
}

const openRuntimes: CreditRuntime[] = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    await runtime.close();
  }
  await cleanupTempResources();
});

async function createScheduledRun(
  runtime: RuntimeHandle,
  providerId: string,
  model: string,
  plan: Record<string, unknown>,
): Promise<{ triggerId: string; operationId: string }> {
  const operation = await fetch(`${origin(runtime)}/v1/operations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: WS,
      definition_ref: null,
      name: "Credit legs operation",
      roster_agent_ids: ["agent_researcher"],
      coordinator_agent_id: "agent_general_assistant",
    }),
  });
  const operationId = ((await operation.json()) as { operation_id: string }).operation_id;
  const created = await fetch(`${origin(runtime)}/v1/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: WS,
      kind: "schedule",
      name: "credit legs schedule",
      target_operation_id: operationId,
      config: { cron: "0 9 * * 1", plan, provider: { provider_id: providerId, model } },
      catch_up_policy: "skip",
      actor: USER,
    }),
  });
  const triggerId = ((await created.json()) as { trigger_id: string }).trigger_id;
  return { triggerId, operationId };
}

function origin(runtime: RuntimeHandle): string {
  const address = runtime.httpServer.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

async function fire(
  runtime: RuntimeHandle,
  triggerId: string,
): Promise<{ outcome: string; runId?: string; code?: string }> {
  const dueAt = "2026-11-02T09:00:00.000Z";
  const outcome = await runtime.scheduler.fireOccurrence(WS, triggerId, {
    idempotencyKey: `schedule:${triggerId}:${dueAt}`,
    dueAt,
    detail: { due_at: dueAt },
  });
  return outcome as { outcome: string; runId?: string; code?: string };
}

describe("the model call's credit legs (S24)", () => {
  it("AC5: a custom-provider call records usage with ZERO credit movement", async () => {
    const credit = await composeCredit();
    openRuntimes.push(credit);
    const { runtime, ledgerRepo } = credit;

    // Funded account: ANY credit movement would be visible in the counters.
    runtime.credits.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const before = ledgerRepo.findAccount(WS);

    // The CUSTOM provider (origin 'user') against the local fake endpoint.
    const provider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Custom local endpoint",
      protocol: "openai-compatible",
      base_url: baseUrlOf(completionServer),
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "user",
    });

    const { triggerId, operationId } = await createScheduledRun(
      runtime,
      provider.id,
      "fixture-model",
      { prompt: "Compile the sweep." },
    );
    completions = 0;
    const outcome = await fire(runtime, triggerId);
    expect(outcome.outcome).toBe("fired");
    expect(completions).toBe(1);

    const runId = outcome.runId!;
    const run = runtime.operations.getRun(WS, operationId, runId);
    expect(run.state).toBe("SUCCEEDED");

    // The usage IS recorded locally (tokens + latency), charged_units 0.
    const usage = ledgerRepo.listUsageForTask(WS, runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      provider_origin: "user",
      charged_units: 0,
      input_tokens: 5000,
      output_tokens: 2000,
    });
    expect(usage[0]?.latency_ms).not.toBeNull();

    // ZERO credit movement: no reservation, no movement rows, unchanged
    // counters (D20 — custom providers never consume Shera credits).
    expect(ledgerRepo.listActiveReservationsForTask(WS, runId)).toHaveLength(0);
    expect(ledgerRepo.listTransactions(WS)).toHaveLength(1); // the grant only
    expect(ledgerRepo.findAccount(WS)).toEqual(before);
  });

  it("AC6: an ambiguous outcome does not retry and does not release — the hold stands and the run enters recovery", async () => {
    const credit = await composeCredit(400);
    openRuntimes.push(credit);
    const { runtime, ledgerRepo } = credit;

    runtime.credits.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    const provider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Platform hanging endpoint",
      protocol: "openai-compatible",
      base_url: baseUrlOf(hangingServer),
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "platform",
    });

    const { triggerId, operationId } = await createScheduledRun(
      runtime,
      provider.id,
      "fixture-model",
      { prompt: "Compile the sweep." },
    );
    hangings = 0;
    const outcome = await fire(runtime, triggerId);
    // The firing landed a run (the run exists; its state is its own truth).
    expect(outcome.outcome).toBe("recovery_required");
    const runId = outcome.runId!;

    // The E13 recovery class: RECOVERY_REQUIRED — never a blind retry.
    const run = runtime.operations.getRun(WS, operationId, runId);
    expect(run.state).toBe("RECOVERY_REQUIRED");
    expect(hangings).toBe(1);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    expect(hangings).toBe(1); // no second attempt anywhere

    // The reservation was NOT released and NOT settled: the provider may
    // have processed the request — the hold stands (never silently given
    // back, never charged on a guess).
    const active = ledgerRepo.listActiveReservationsForTask(WS, runId);
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(ledgerRepo.listReleases(WS)).toHaveLength(0);
    expect(ledgerRepo.listSettlements(WS)).toHaveLength(0);

    // The decision is RECORDED and VISIBLE on the run's stream.
    const stream = runtime.journal.readFrom(WS, `task:${runId}`, 0, 100);
    const ambiguity = stream.find((row) => row.event_type === "run.credit_outcome_ambiguous");
    expect(ambiguity).toBeDefined();
    const payload = JSON.parse(ambiguity!.payload) as { reason?: string; provider_id?: string };
    expect(payload.reason).toBe("ambiguous_provider_outcome");
    expect(payload.provider_id).toBe(provider.id);
  });

  it("AC7: an exhausted account pauses only the model call — the tool leg runs with zero credits", async () => {
    const credit = await composeCredit();
    openRuntimes.push(credit);
    const { runtime, ledgerRepo } = credit;

    // Fully exhausted: the account exists with nothing granted.
    runtime.credits.ensureAccount(WS);
    expect(ledgerRepo.findAccount(WS)).toMatchObject({
      granted_units: 0,
      charged_units: 0,
      reserved_units: 0,
    });

    const platformProvider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Platform endpoint (exhausted)",
      protocol: "openai-compatible",
      base_url: baseUrlOf(completionServer),
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "platform",
    });

    // (a) The TOOL-ONLY plan: no model leg, so NO credit consult anywhere —
    // the run completes and the tool executes (no capability change, D20).
    runtime.noteStore.set("datasets/literature.md", "Seed papers: A, B, C.");
    const toolOnly = await createScheduledRun(runtime, platformProvider.id, "fixture-model", {
      tool: {
        tool_id: "tool_note_read",
        tool_version: "1.0.0",
        capability: "file.read",
        args: { path: "datasets/literature.md" },
      },
    });
    const toolOutcome = await fire(runtime, toolOnly.triggerId);
    expect(toolOutcome.outcome).toBe("fired");
    const toolRun = runtime.operations.getRun(WS, toolOnly.operationId, toolOutcome.runId!);
    expect(toolRun.state).toBe("SUCCEEDED");
    const conn = openConnections[0]!;
    const tools = new ToolsRepository(new SqliteTransactions(conn.db));
    const history = tools.listExecutionsByTask(WS, toolOutcome.runId!);
    expect(history.find((row) => row.tool_id === "tool_note_read")?.status).toBe("succeeded");

    // (b) The MODEL plan: the reservation is refused — the D48 pause.
    const modelPlan = await createScheduledRun(
      runtime,
      platformProvider.id,
      "fixture-model",
      { prompt: "Compile the sweep." },
    );
    const modelOutcome = await fire(runtime, modelPlan.triggerId);
    expect(modelOutcome.outcome).toBe("paused_credits");
    const modelRun = runtime.operations.getRun(WS, modelPlan.operationId, modelOutcome.runId!);
    expect(modelRun.state).toBe("PAUSED");
    expect(modelRun.state).not.toBe("QUEUED");

    // The capability surface is unchanged: the same account that paused the
    // model call executed the tool. The ledger moved nothing for the tool.
    const toolUsage = ledgerRepo.listUsageForTask(WS, toolOutcome.runId!);
    expect(toolUsage).toHaveLength(0);
  });

  it("a clean provider failure (the request never landed) releases the reservation", async () => {
    const credit = await composeCredit();
    openRuntimes.push(credit);
    const { runtime, ledgerRepo } = credit;

    runtime.credits.grant({ workspace_id: WS, amount_units: 100, related_id: null });
    // A CLOSED port: the request cannot land — a clean provider failure.
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const provider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Platform dead endpoint",
      protocol: "openai-compatible",
      base_url: `http://127.0.0.1:${deadPort}/v1`,
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "platform",
    });

    const { triggerId, operationId } = await createScheduledRun(
      runtime,
      provider.id,
      "fixture-model",
      { prompt: "Compile the sweep." },
    );
    const outcome = await fire(runtime, triggerId);
    expect(outcome.outcome).toBe("failed");
    const run = runtime.operations.getRun(WS, operationId, outcome.runId!);
    expect(run.state).toBe("FAILED");

    // The hold was released (D20: provider failures release), nothing
    // charged, the balance whole again.
    const releases = ledgerRepo.listReleases(WS);
    expect(releases.length).toBeGreaterThanOrEqual(1);
    expect(releases.every((row) => row.reason === "provider_failure")).toBe(true);
    expect(ledgerRepo.listSettlements(WS)).toHaveLength(0);
    expect(ledgerRepo.findAccount(WS)).toMatchObject({
      granted_units: 100,
      charged_units: 0,
      reserved_units: 0,
    });
  });
});
