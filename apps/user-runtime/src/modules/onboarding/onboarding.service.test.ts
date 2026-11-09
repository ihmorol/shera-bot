/**
 * S30 fix round — the onboarding service backstops an HTTP caller cannot
 * reach (the memory.service.test.ts idiom: real SQLite repositories, the
 * cross-module dependency stubbed at the seam):
 *
 *   - the memory briefing's recorded effect rides the SHARED settings
 *     command surface (D16: memory.set_auto_memory) and is AWAITED — a
 *     faulted memory command fails the step honestly: the onboarding command
 *     is refused, the receipt never claims accepted, the answer is not
 *     recorded, and the interview stays at the memory step (the review
 *     round's F3: the fire-and-forget `void ... .catch(() => {})` inside the
 *     receipted transaction committed `{accepted: true}` even when the
 *     effect faulted);
 *   - a resolved memory command records the answer with the deterministic
 *     derived idempotency key (a replayed onboarding key re-derives the same
 *     memory key, whose receipt answers first);
 *   - free_text is refused on steps declaring `accepts_free_text: false`
 *     (G2: answers are data the runtime validates — the review round's P3)
 *     and accepted where the step declares it, with NO side effect on a
 *     refusal.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { OnboardingRepository } from "../../adapters/sqlite/onboarding-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { MemoryService } from "../memory/memory.service.ts";
import { ProviderService } from "../providers/provider-service.ts";
import { OnboardingService, OnboardingServiceError } from "./onboarding.service.ts";

const WORKSPACE = "ws-local-default";

type MemoryStub = {
  applyCommand: ReturnType<typeof vi.fn>;
  userView: () => { auto_memory: { global_enabled: boolean } };
};

interface Suite {
  service: OnboardingService;
  onboarding: OnboardingRepository;
  receipts: CommandReceiptsRepository;
  memory: MemoryStub;
  conn: SqliteConnection;
  close(): void;
}

const suites: Suite[] = [];

function makeSuite(applyCommand: MemoryStub["applyCommand"]): Suite {
  const dir = mkdtempSync(join(tmpdir(), "shera-s30-onboarding-service-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const onboarding = new OnboardingRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const memory: MemoryStub = {
    applyCommand,
    userView: () => ({ auto_memory: { global_enabled: true } }),
  };
  const service = new OnboardingService({
    onboarding,
    memory: memory as unknown as MemoryService,
    providers: { listProviders: () => [] } as unknown as ProviderService,
    receipts,
    tx,
    workspaceId: WORKSPACE,
  });
  const suite: Suite = { service, onboarding, receipts, memory, conn, close: () => conn.close() };
  suites.push(suite);
  return suite;
}

/** The answers that put the interview at the memory briefing step. */
const PROGRESS_ANSWERS = {
  welcome: { option_id: "research", free_text: null, answered_at: "2026-11-08T10:00:00.000Z" },
  provider_check: {
    option_id: "keep_default",
    free_text: null,
    answered_at: "2026-11-08T10:01:00.000Z",
  },
  approvals_briefing: {
    option_id: "got_it",
    free_text: null,
    answered_at: "2026-11-08T10:02:00.000Z",
  },
};

function seedToMemoryStep(suite: Suite): void {
  suite.onboarding.put(
    WORKSPACE,
    {
      status: "pending",
      current_step: "memory_briefing",
      answers_json: JSON.stringify(PROGRESS_ANSWERS),
    },
    "2026-11-08T10:03:00.000Z",
  );
}

function answerCommand(extra: Record<string, unknown> = {}) {
  return {
    command_id: "cmd_test_1",
    idempotency_key: "idem_test_1",
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-08T10:04:00.000Z",
    type: "onboarding.answer",
    step: "memory_briefing",
    option_id: "memory_auto_off",
    free_text: null,
    ...extra,
  };
}

function recordedAnswers(suite: Suite): Record<string, { option_id: string | null }> {
  return JSON.parse(suite.onboarding.get(WORKSPACE)?.answers_json ?? "{}") as Record<
    string,
    { option_id: string | null }
  >;
}

afterEach(() => {
  for (const suite of suites.splice(0)) {
    suite.close();
  }
  vi.restoreAllMocks();
});

describe("onboarding service backstops (S30 fix round)", () => {
  it("a FAULTED memory command fails the step honestly — refused, no receipt, no answer, the step stays current", async () => {
    const applyCommand = vi.fn().mockRejectedValue(new Error("memory stack fault"));
    const suite = makeSuite(applyCommand);
    seedToMemoryStep(suite);

    await expect(suite.service.submitCommand(WORKSPACE, answerCommand())).rejects.toThrow(
      "memory stack fault",
    );

    // The receipt never claims accepted for a command whose effect faulted.
    expect(suite.receipts.findById(WORKSPACE, "idem_test_1")).toBeNull();
    // The answer is not recorded and the interview stays at the memory step
    // (resumable — the user can retry).
    expect(recordedAnswers(suite)["memory_briefing"]).toBeUndefined();
    expect(suite.onboarding.get(WORKSPACE)?.current_step).toBe("memory_briefing");
    // The shared command surface WAS attempted (D16 — the same path, await).
    expect(applyCommand).toHaveBeenCalledTimes(1);
  });

  it("a settled memory choice applies through the SAME shared command (D16) and the receipt commits only after the effect", async () => {
    const applyCommand = vi.fn().mockResolvedValue({ accepted: true });
    const suite = makeSuite(applyCommand);
    seedToMemoryStep(suite);

    const result = await suite.service.submitCommand(WORKSPACE, answerCommand());

    expect(result).toEqual({ accepted: true });
    expect(applyCommand).toHaveBeenCalledTimes(1);
    const command = applyCommand.mock.calls[0]![0] as Record<string, unknown>;
    expect(command["type"]).toBe("memory.set_auto_memory");
    expect(command["enabled"]).toBe(false); // option memory_auto_off
    // The derived key stays deterministic: a replayed onboarding key
    // re-derives the same memory key, whose receipt answers first.
    expect(command["idempotency_key"]).toBe("idem_test_1-memory");
    expect(command["actor"]).toEqual({ type: "user", id: "user_emon" });
    expect(command["workspace_id"]).toBe(WORKSPACE);
    expect(suite.receipts.findById(WORKSPACE, "idem_test_1")).not.toBeNull();
    expect(recordedAnswers(suite)["memory_briefing"]).toMatchObject({
      option_id: "memory_auto_off",
    });
  });

  it("free_text is REFUSED on a step declaring accepts_free_text:false — no answer, no receipt, no memory effect", async () => {
    const applyCommand = vi.fn().mockResolvedValue({ accepted: true });
    const suite = makeSuite(applyCommand);
    seedToMemoryStep(suite);

    const refusal = suite.service.submitCommand(
      WORKSPACE,
      answerCommand({ option_id: "memory_auto_on", free_text: "a crafted free-text answer" }),
    );

    await expect(refusal).rejects.toBeInstanceOf(OnboardingServiceError);
    await expect(refusal).rejects.toMatchObject({
      code: "ONBOARDING_FREE_TEXT_NOT_ACCEPTED",
      status: 400,
    });
    // The refusal carries no side effect: the memory command was never
    // attempted and nothing committed.
    expect(applyCommand).not.toHaveBeenCalled();
    expect(suite.receipts.findById(WORKSPACE, "idem_test_1")).toBeNull();
    expect(recordedAnswers(suite)["memory_briefing"]).toBeUndefined();
  });

  it("free_text is accepted where the step declares it (the welcome interview's own words)", async () => {
    const applyCommand = vi.fn().mockResolvedValue({ accepted: true });
    const suite = makeSuite(applyCommand);
    // A fresh account: the current step is welcome (accepts_free_text: true).

    const result = await suite.service.submitCommand(WORKSPACE, {
      command_id: "cmd_welcome_1",
      idempotency_key: "idem_welcome_1",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-08T10:04:00.000Z",
      type: "onboarding.answer",
      step: "welcome",
      option_id: "something_else",
      free_text: "In my own words: research and coding.",
    });

    expect(result).toEqual({ accepted: true });
    expect(recordedAnswers(suite)["welcome"]).toMatchObject({ option_id: "something_else" });
    const row = suite.onboarding.get(WORKSPACE);
    expect(JSON.parse(row?.answers_json ?? "{}")).toMatchObject({
      welcome: { free_text: "In my own words: research and coding." },
    });
  });
});
