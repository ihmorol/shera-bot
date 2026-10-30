/**
 * RetryCoordinator tests (S22 chunk 2) — red-first suite for the runtime-owned
 * retry CLOCK and the D8 wiring (AC14, AC2, AC10, AC3's truth source).
 *
 * The coordinator applies the PURE policy (retry-policy.ts) to real run rows
 * through the D8 transition machinery — every decision journals exactly one
 * contract lifecycle envelope (task.retry_scheduled / task.retry_started /
 * task.paused / task.failed / task.recovery_required) on the run's task
 * stream (task:<run_id>) in ONE transaction, then advances the run row
 * through the injected run-control seam (the same seam the supervisor uses —
 * the composed applyRunState drives the worker lifecycle from it).
 *
 * The clock is injected: tests capture the scheduled retry callbacks and fire
 * them manually, so the backoff schedule is asserted exactly and the whole
 * AC14 walk is deterministic — no real waits.
 *
 * Governing records: PRD §8, D8, E13, D20, G2, AC14/AC2/AC10.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EVENT_ENVELOPES, type TaskLifecyclePayload } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository, type EventJournalRow } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { DEFAULT_RETRY_POLICY } from "./retry-policy.ts";
import { RetryCoordinator } from "./retry-coordinator.service.ts";
import { taskStreamId } from "./task-events.ts";

const WS = "ws-retry";
const AGENT = "agent_retry_test";

const PACK_CATALOG = {
  pack_id: "pack_retry_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Retry Test Agent",
      role_description: "fails on schedule",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 42, initial_glyph: "R" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_retry_test" : null),
  skills: [],
  connectors: [],
};

interface RetryHarness {
  coordinator: RetryCoordinator;
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  operationId: string;
  /** Scheduled retry callbacks in order, with their delays (the fake clock). */
  scheduled: Array<{ delayMs: number; fire: () => void; cancel: () => void }>;
  /** Run-state writes through the seam, in order. */
  seamWrites: Array<{ run_id: string; state: string }>;
  runSeq: { n: number };
  dir: string;
}

const openHarnesses: RetryHarness[] = [];

function makeHarness(): RetryHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s22-retry-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new OperationsService({
    operations: operationsRepo,
    tx,
    packCatalog: PACK_CATALOG,
  });

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Retry Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const scheduled: RetryHarness["scheduled"] = [];
  const seamWrites: RetryHarness["seamWrites"] = [];

  const coordinator = new RetryCoordinator({
    events,
    journal,
    operations: operationsRepo,
    runControl: {
      runState: (_workspaceId, runId) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) return null;
        try {
          return ops.getRun(WS, opId, runId).state;
        } catch {
          return null;
        }
      },
      applyRunState: (_workspaceId, runId, state) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) throw new Error(`run ${runId} not found`);
        seamWrites.push({ run_id: runId, state });
        ops.applyRunState(WS, opId, runId, state);
      },
    },
    schedule: (delayMs, fn) => {
      const entry = {
        delayMs,
        fire: (): void => fn(),
        cancel: (): void => {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
        },
      };
      scheduled.push(entry);
      return entry.cancel;
    },
  });

  const harness: RetryHarness = {
    coordinator,
    conn,
    journal,
    ops,
    operationsRepo,
    operationId,
    scheduled,
    seamWrites,
    runSeq: { n: 0 },
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of openHarnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

function createRun(harness: RetryHarness, state: "RUNNING" | "RETRYING" = "RUNNING"): string {
  harness.runSeq.n += 1;
  const runId = `run_retry_${harness.runSeq.n}`;
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  if (state !== "CREATED") {
    harness.ops.applyRunState(WS, harness.operationId, runId, state);
  }
  return runId;
}

function lifecycleEvents(
  harness: RetryHarness,
  runId: string,
): Array<{ type: string; payload: TaskLifecyclePayload }> {
  return harness.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .filter((row: EventJournalRow) => row.event_type.startsWith("task."))
    .map((row) => {
      const envelope = (
        EVENT_ENVELOPES as Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } } | undefined>
      )[row.event_type]!.safeParse(JSON.parse(row.payload));
      if (!envelope.success) throw new Error(`unparseable envelope for ${row.event_type}`);
      return {
        type: row.event_type,
        payload: (envelope.data as { payload: TaskLifecyclePayload }).payload,
      };
    });
}

describe("RetryCoordinator — transient retries are bounded and deterministic (AC14)", () => {
  it("schedules the first retry with the policy's first backoff delay", () => {
    const harness = makeHarness();
    const runId = createRun(harness);

    const outcome = harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });

    expect(outcome).toMatchObject({ outcome: "retry_scheduled", attempt: 1, delayMs: 1_000 });
    // The row is RETRYING through the seam (the composed flow sees it).
    expect(harness.seamWrites.at(-1)).toEqual({ run_id: runId, state: "RETRYING" });
    // The contract lifecycle event carries the attempt and the failure event.
    const scheduledEvents = lifecycleEvents(harness, runId).filter(
      (event) => event.type === "task.retry_scheduled",
    );
    expect(scheduledEvents).toHaveLength(1);
    expect(scheduledEvents[0]!.payload).toMatchObject({
      from_state: "RUNNING",
      to_state: "RETRYING",
      attempt: 1,
    });
    // One retry is armed at the bounded delay.
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]!.delayMs).toBe(DEFAULT_RETRY_POLICY.backoffScheduleMs[0]);
  });

  it("walks exactly three retries then pauses with the retry_exhausted reason", () => {
    const harness = makeHarness();
    const runId = createRun(harness);

    // Failure → retry 1 → attempt starts (RETRYING → RUNNING) → failure ...
    for (let attempt = 1; attempt <= DEFAULT_RETRY_POLICY.maxAttempts; attempt += 1) {
      const outcome = harness.coordinator.handleRunFailure({
        workspaceId: WS,
        runId,
        failureCode: "TOOL_EXECUTION_TIMEOUT",
      });
      expect(outcome).toMatchObject({ outcome: "retry_scheduled", attempt });
      // Fire the armed backoff timer: the retry attempt STARTS (RUNNING).
      expect(harness.scheduled).toHaveLength(1);
      harness.scheduled[0]!.fire();
      harness.scheduled.length = 0;
      expect(harness.coordinator.runState(WS, runId)).toBe("RUNNING");
    }

    // The fourth failure has no attempt left: the run PAUSES and notifies.
    const exhausted = harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });
    expect(exhausted).toMatchObject({ outcome: "paused", reason: "retry_exhausted" });
    expect(harness.coordinator.runState(WS, runId)).toBe("PAUSED");
    expect(harness.scheduled).toHaveLength(0);
    // The pause event records the PRD §8 reason.
    const pauses = lifecycleEvents(harness, runId).filter((event) => event.type === "task.paused");
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.payload.reason).toBe("retry_exhausted");
    // The true attempt ledger lives on the stream: three scheduled retries.
    expect(
      lifecycleEvents(harness, runId).filter((event) => event.type === "task.retry_scheduled"),
    ).toHaveLength(3);
  });

  it("the backoff delay is bounded, not exponential-unbounded", () => {
    const harness = makeHarness();
    const runId = createRun(harness);
    harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });
    harness.scheduled[0]!.fire();
    harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });
    expect(harness.scheduled[0]!.delayMs).toBe(2_000);
  });
});

describe("RetryCoordinator — non-transient failures never retry (AC2)", () => {
  it("fails immediately with the typed code and journals task.failed", () => {
    const harness = makeHarness();
    const runId = createRun(harness);

    const outcome = harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_ARGS_INVALID",
    });

    expect(outcome).toMatchObject({ outcome: "failed", code: "TOOL_ARGS_INVALID" });
    expect(harness.coordinator.runState(WS, runId)).toBe("FAILED");
    expect(harness.scheduled).toHaveLength(0);
    const failures = lifecycleEvents(harness, runId).filter((event) => event.type === "task.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload.from_state).toBe("RUNNING");
  });
});

describe("RetryCoordinator — ambiguous effects are never blindly retried (AC10, E13)", () => {
  it("pauses for review with the reason recorded on a scripted ambiguous response", () => {
    const harness = makeHarness();
    const runId = createRun(harness);

    const outcome = harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "PROVIDER_RESPONSE_AMBIGUOUS",
    });

    expect(outcome).toMatchObject({
      outcome: "paused_for_review",
      reason: "ambiguous_external_effect",
    });
    expect(harness.coordinator.runState(WS, runId)).toBe("RECOVERY_REQUIRED");
    expect(harness.scheduled).toHaveLength(0);
    const recoveries = lifecycleEvents(harness, runId).filter(
      (event) => event.type === "task.recovery_required",
    );
    expect(recoveries).toHaveLength(1);
    // The DECISION is recorded as data: what failed, why it paused.
    const decisions = harness.journal
      .readFrom(WS, taskStreamId(runId), 0, 1_000)
      .filter((row) => row.event_type === "run.failure_decided");
    expect(decisions).toHaveLength(1);
    const decision = JSON.parse(decisions[0]!.payload) as {
      payload: { decision: string; failure_code: string; reason: string };
    };
    expect(decision.payload).toMatchObject({
      decision: "pause_for_review",
      failure_code: "PROVIDER_RESPONSE_AMBIGUOUS",
      reason: "ambiguous_external_effect",
    });
  });
});

describe("RetryCoordinator — the attempt ledger is the journal (AC3's truth source)", () => {
  it("counts consumed attempts from the stream, not from memory", () => {
    const harness = makeHarness();
    const runId = createRun(harness);
    // Two consumed retries (journal carries them), the run is back at RUNNING.
    for (let i = 0; i < 2; i += 1) {
      harness.coordinator.handleRunFailure({
        workspaceId: WS,
        runId,
        failureCode: "TOOL_EXECUTION_TIMEOUT",
      });
      harness.scheduled[0]!.fire();
    }
    // A NEW coordinator instance (fresh memory, same journal) sees the truth.
    const fresh = new RetryCoordinator({
      events: harness.coordinator["deps"]["events"],
      journal: harness.journal,
      operations: harness.operationsRepo,
      runControl: harness.coordinator["deps"]["runControl"],
      schedule: (delayMs, fn) => {
        const entry = {
          delayMs,
          fire: (): void => fn(),
          cancel: (): void => {
            const index = harness.scheduled.indexOf(entry);
            if (index >= 0) harness.scheduled.splice(index, 1);
          },
        };
        harness.scheduled.push(entry);
        return entry.cancel;
      },
    });
    // The third decision is attempt 3 (1 + the two consumed retries).
    const outcome = fresh.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });
    expect(outcome).toMatchObject({ outcome: "retry_scheduled", attempt: 3 });
  });
});

describe("RetryCoordinator — stale timers and unknown runs are contained", () => {
  it("a retry timer that fires after the run moved on is a typed no-op", () => {
    const harness = makeHarness();
    const runId = createRun(harness);
    harness.coordinator.handleRunFailure({
      workspaceId: WS,
      runId,
      failureCode: "TOOL_EXECUTION_TIMEOUT",
    });
    // The run is cancelled while the backoff timer is pending.
    harness.ops.applyRunState(WS, harness.operationId, runId, "CANCELLING");
    harness.ops.applyRunState(WS, harness.operationId, runId, "CANCELLED");

    expect(() => harness.scheduled[0]!.fire()).not.toThrow();
    // The terminal state is never resurrected.
    expect(harness.coordinator.runState(WS, runId)).toBe("CANCELLED");
    expect(harness.seamWrites.at(-1)).toEqual({ run_id: runId, state: "CANCELLED" });
  });

  it("an unknown run is a typed refusal, not a crash", () => {
    const harness = makeHarness();
    expect(() =>
      harness.coordinator.handleRunFailure({
        workspaceId: WS,
        runId: "run_missing",
        failureCode: "TOOL_EXECUTION_TIMEOUT",
      }),
    ).toThrowError(/RUN_NOT_FOUND/);
  });
});
