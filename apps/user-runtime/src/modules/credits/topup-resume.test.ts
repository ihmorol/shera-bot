/**
 * S24 chunk 4 — the top-up resume path (AC2; D48, D47, E38, issue #33 AC9).
 * The recorded unblocking story, now backed by the REAL ledger:
 *
 * - BEFORE the top-up: the run stays VISIBLY paused with the explicit
 *   reason `insufficient_credits` and the typed run.credit_paused
 *   notification record on its stream — never a silent stall, never a
 *   QUEUED placement.
 * - The admin top-up (the S32 command over the recorded internal channel)
 *   applies the GRANT to the runtime ledger (the central topup id is the
   * related reference) and resumes every insufficient-credit-paused run
 *   through the recorded D8 `resume_task` row — and the resumed run
 *   COMPLETES: the re-drive re-walks it from QUEUED with the funded
 *   account (reserve → call → settle).
 * - The credit-paused trigger re-arms (the S28 resume-after-top-up seam).
 *
 * The model endpoint is the LOCAL fake — the proof is the request counter
 * and the ledger rows.
 */
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "../../transport/local-api/compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "../../transport/local-api/compose.ts";
import { CreditLedgerRepository } from "../../adapters/sqlite/credit-ledger-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
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
const ADMIN = { type: "admin", id: "admin-token:test" } as const;

const FIXTURE_COMPLETION = "Sweep compiled after the top-up.";
let completions = 0;
const server: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    completions += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-s24-topup",
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

let listening = false;
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const openConnections: SqliteConnection[] = [];

interface TopUpRuntime {
  runtime: RuntimeHandle;
  ledgerRepo: CreditLedgerRepository;
  origin: string;
  close(): Promise<void>;
}

async function composeTopUp(): Promise<TopUpRuntime> {
  if (!listening) {
    listening = true;
    server.listen(0, "127.0.0.1");
  }
  const dbPath = join(makeTempDir("shera-s24-topup-"), "runtime.db");
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    providerEnforcement: true,
  });
  trackConnection(runtime);
  const conn = openDatabase(dbPath);
  openConnections.push(conn);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    ledgerRepo: new CreditLedgerRepository(new SqliteTransactions(conn.db)),
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

const openRuntimes: TopUpRuntime[] = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    await runtime.close();
  }
  await cleanupTempResources();
});

describe("the top-up resume path (S24 AC2, D48)", () => {
  it("before the top-up the run stays visibly paused with a notification; after it, the run resumes and completes", async () => {
    const top = await composeTopUp();
    openRuntimes.push(top);
    const { runtime, ledgerRepo, origin } = top;

    // A TINY grant: the pre-flight consult (0) passes, the model leg's
    // bounded estimate does not — the run pauses for credits.
    runtime.credits.grant({ workspace_id: WS, amount_units: 1, related_id: null });

    const provider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Platform endpoint (top-up)",
      protocol: "openai-compatible",
      base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "platform",
    });

    const operation = await fetch(`${origin}/v1/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS,
        definition_ref: null,
        name: "Top-up operation",
        roster_agent_ids: ["agent_researcher"],
        coordinator_agent_id: "agent_general_assistant",
      }),
    });
    const operationId = ((await operation.json()) as { operation_id: string }).operation_id;
    const created = await fetch(`${origin}/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS,
        kind: "schedule",
        name: "top-up schedule",
        target_operation_id: operationId,
        config: {
          cron: "0 9 * * 1",
          plan: { prompt: "Compile the sweep." },
          provider: { provider_id: provider.id, model: "fixture-model" },
        },
        catch_up_policy: "skip",
        actor: USER,
      }),
    });
    const triggerId = ((await created.json()) as { trigger_id: string }).trigger_id;

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
    completions = 0;

    // BEFORE the top-up: VISIBLY paused (D48) with the notification record.
    const pausedRun = runtime.operations.getRun(WS, operationId, runId!);
    expect(pausedRun.state).toBe("PAUSED");
    const pausedStream = runtime.journal.readFrom(WS, `task:${runId!}`, 0, 100);
    const pauseRecord = pausedStream.find((row) => row.event_type === "run.credit_paused");
    expect(pauseRecord).toBeDefined();
    const pausePayload = JSON.parse(pauseRecord!.payload) as { reason?: string };
    expect(pausePayload.reason).toBe("insufficient_credits");
    expect(completions).toBe(0); // the model call never happened

    // THE TOP-UP: the recorded S32 command — grant + resume + re-drive.
    const applied = await runtime.adminCommands.applyCreditTopUp({
      workspaceId: WS,
      topupId: "topup_test_0001",
      amount: 100,
      actor: ADMIN,
    });
    expect(applied.resumed_run_ids).toEqual([runId]);

    // AFTER the top-up: the run COMPLETED (the re-drive re-walked it from
    // QUEUED with the funded account — reserve → call → settle).
    const resumedRun = runtime.operations.getRun(WS, operationId, runId!);
    expect(resumedRun.state).toBe("SUCCEEDED");
    expect(completions).toBe(1);

    // The GRANT is in the runtime ledger with the central topup reference.
    const grant = ledgerRepo
      .listTransactions(WS)
      .find((row) => row.entry_type === "grant" && row.related_id === "topup_test_0001");
    expect(grant).toBeDefined();
    expect(grant?.amount_units).toBe(100);
    const state = runtime.credits.accountState(WS);
    expect(state).toMatchObject({ granted_units: 101, charged_units: 70 });

    // The settlement: the actual usage charged against the reservation.
    expect(ledgerRepo.listSettlements(WS)).toHaveLength(1);
    expect(ledgerRepo.listSettlements(WS)[0]).toMatchObject({ actual_units: 70 });

    // The credit-paused trigger re-armed (the resume-after-top-up seam).
    const view = runtime.schedules.getTriggerView(WS, triggerId);
    expect(view?.state).toBe("active");
    expect(view?.pause_reason).toBeNull();
  });
});
