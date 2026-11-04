/**
 * S24 review fix F8 — the model leg's usage record claims what the ledger
 * actually CHARGED, not what the runner asked it to charge. The pre-fix bug:
 * `settledUnits = actual` was assigned BEFORE `settleReservation` and its
 * typed refusal was ignored — on `RESERVATION_NOT_ACTIVE` the usage_record
 * claimed a charge that never landed. The pin: with the ledger refusing the
 * settle (the typed seam answer), the usage row records `charged_units: 0`,
 * the account moves nothing, and the hold stands exactly as the refusal
 * describes.
 *
 * The ledger is REAL (real SQLite, real migrations) behind the runner's
 * PlanCreditLedger port; only `settleReservation` is interposed to answer
 * the typed refusal — the runner's USE of the settle result is the unit
 * under test. The model endpoint is the LOCAL fixture (a real request, the
 * S23/S28 pattern — never a fabricated completion).
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { CreditLedgerRepository } from "../../adapters/sqlite/credit-ledger-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { ProviderView } from "@shera-bot/contracts";
import { CreditLedgerService } from "../credits/credit-ledger.service.ts";
import { AutonomousPlanRunner, type PlanCreditLedger } from "./autonomous-plan-runner.ts";

const WS = "ws-runner-settle";
const CLOCK = "2026-11-02T12:00:00.000Z";
const PROVIDER_ID = "prov_platform_fixture";

const FIXTURE_COMPLETION = "Settled honestly.";
const completionServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-runner-settle",
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

const harnesses: Array<{ dir: string; conn: SqliteConnection }> = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
  await new Promise<void>((resolve) => {
    if (completionServer.listening) completionServer.close(() => resolve());
    else resolve();
  });
});

async function makeRunner(): Promise<{
  runner: AutonomousPlanRunner;
  repo: CreditLedgerRepository;
  state: { settleAttempts: number };
}> {
  await new Promise<void>((resolve) => completionServer.listen(0, "127.0.0.1", resolve));
  const port = (completionServer.address() as AddressInfo).port;

  const dir = mkdtempSync(join(tmpdir(), "shera-s24-runner-settle-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  harnesses.push({ dir, conn });
  const tx = new SqliteTransactions(conn.db);
  const repo = new CreditLedgerRepository(tx);
  const realLedger = new CreditLedgerService({ repository: repo, tx, now: () => CLOCK });
  realLedger.ensureAccount(WS);
  realLedger.grant({ workspace_id: WS, amount_units: 1000, related_id: null });

  // Mutable holder — the primitive is destructured before the run, so a
  // bare `let` would snapshot 0 (the observation must outlive makeRunner).
  const state = { settleAttempts: 0 };
  // The runner's port: REAL everywhere except the settle, which answers the
  // typed refusal (the reservation is not active at settle time — the seam
  // contract the runner must honor).
  const credits: PlanCreditLedger = {
    reserveForRun: (input) => {
      const reserved = realLedger.reserveForRun({
        workspace_id: input.workspace_id,
        task_id: input.task_id,
        estimate_units: input.estimate_units,
        provider_id: input.provider_id,
        model: input.model,
      });
      if (!reserved.ok) {
        return {
          ok: false as const,
          code: "insufficient_credits" as const,
          available_units: reserved.available_units,
          requested_units: reserved.requested_units,
        };
      }
      return { ok: true as const, reservation_id: reserved.reservation_id };
    },
    activeReservationFor: (workspaceId, taskId) => realLedger.activeReservationFor(workspaceId, taskId),
    settleReservation: (input) => {
      state.settleAttempts += 1;
      return { ok: false as const, code: "RESERVATION_NOT_ACTIVE" };
    },
    releaseReservation: (input) =>
      realLedger.releaseReservation({
        workspace_id: input.workspace_id,
        reservation_id: input.reservation_id,
        reason: input.reason,
      }),
    releaseForRun: (workspaceId, taskId, reason) =>
      realLedger.releaseForRun(workspaceId, taskId, reason),
    recordUsage: (input) => realLedger.recordUsage(input),
  };

  const providerView: ProviderView = {
    id: PROVIDER_ID,
    workspace_id: WS,
    display_name: "Platform fixture",
    protocol: "openai-compatible",
    base_url: `http://127.0.0.1:${port}/v1`,
    api_mode: "api_key",
    default_model_id: "fixture-model",
    organization: null,
    project: null,
    headers: {},
    request_params: {},
    origin: "platform",
    status: "enabled",
    credential_hint: "sk-f…",
    created_at: CLOCK,
    updated_at: CLOCK,
  };

  const runner = new AutonomousPlanRunner({
    providers: {
      getProviderView: (workspaceId, providerId) =>
        workspaceId === WS && providerId === PROVIDER_ID ? providerView : null,
    },
    credentials: { decryptForCall: () => "sk-fixture-0123456789abcdefSECRET" },
    executor: {} as never, // the plan has no tool leg
    artifacts: { insertArtifact: () => undefined as never }, // no artifact leg
    journal: { nextSequence: () => 1 } as never,
    events: { appendEvent: () => undefined } as never,
    tx: { transaction: (fn: (exec: never) => unknown) => fn({} as never) } as never,
    operations: { getOperation: () => null } as never,
    credits,
    now: () => CLOCK,
    logFault: () => undefined,
  });
  return { runner, repo, state };
}

describe("the model leg claims what the ledger charged (review F8)", () => {
  it("a refused settle records charged_units 0 in the usage row — the usage record never claims a charge that did not land", async () => {
    const { runner, repo, state } = await makeRunner();
    const outcome = await runner.runPlan({
      workspace_id: WS,
      operation_id: "op_runner_settle",
      conversation_id: "conv_runner_settle",
      run_id: "run_runner_settle",
      plan: { prompt: "Compile the sweep." },
      provider: { provider_id: PROVIDER_ID, model: "fixture-model" },
      trigger_event: { event_type: "trigger.scheduled", event_id: "evt_trigger_1" },
    });
    expect(outcome).toMatchObject({ ok: true });

    // The runner ATTEMPTED the settle and honored its typed refusal.
    expect(state.settleAttempts).toBe(1);
    const usage = repo.listUsageForTask(WS, "run_runner_settle");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.charged_units).toBe(0);
    expect(usage[0]?.provider_origin).toBe("platform");
    // The account moved NOTHING (the refusal means no charge landed) and
    // the hold stands exactly as the refusal describes — the estimate hold
    // is the runner's own bounded estimate (derived from the ledger's
    // formula, NOT the 70-unit would-be charge of the metered usage).
    expect(repo.findAccount(WS)).toMatchObject({
      granted_units: 1000,
      charged_units: 0,
      reserved_units: CreditLedgerService.estimateUnits({
        prompt_chars: "Compile the sweep.".length,
        max_output_tokens: 256,
      }),
    });
  });
});
