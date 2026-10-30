/**
 * RetryCoordinator (S22 chunk 2; PRD §8, AC14, AC2, AC3, AC10, D8, E13, D20,
 * G2) — the RUNTIME-OWNED retry clock and decision applier.
 *
 * The PURE policy (retry-policy.ts) classifies one failure and bounds the
 * attempts; THIS service applies the decision to a real run row through the
 * shared row-lifecycle applier (run-lifecycle.ts — the SAME TASK_TRANSITIONS
 * table, the same deterministic-id optimistic guard, the same journal-first
 * ordering, never a second state machine) and owns the backoff CLOCK:
 *
 *  - the injected `schedule` seam is the only timer source (deterministic
 *    tests; the runtime owns its own timers — BullMQ/Redis remains rejected,
 *    E27);
 *  - the attempt LEDGER is the journal: consumed retries are the
 *    task.retry_scheduled envelopes' attempt numbers on the run's task
 *    stream (task:<run_id>) — the same truth the UI renders (AC3), so a
 *    fresh coordinator instance (or a restarted gateway) reads the same
 *    bound without memory;
 *  - every decision carries the `run.failure_decided` audit record (what
 *    failed, what was decided, why) in the same transaction.
 *
 * Scope honesty (recorded in E35): the D32 layer-3 escalation classes that
 * are NOT classified worker failures — unexpected exits, hangs, protocol
 * violations, handshake timeouts — stay RECOVERY_REQUIRED exactly as E27
 * recorded; the coordinator consumes only worker-REPORTED failure classes
 * (the error frame) and typed tool-execution failure codes. The pause's
 * "notify" surface in this slice is the durable task.paused envelope plus
 * the post-commit live fanout; the notification center is S30's.
 *
 * Governing records: PRD §8, D8, E13, D20, G2; AC14/AC2/AC3/AC10.
 */
import { EVENT_ENVELOPES, type RunState } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import { taskStreamId } from "./task-events.ts";
import {
  applyRowLifecycleTransition,
  DEFAULT_MAX_RETRIES,
  type RowLifecycleDeps,
} from "./run-lifecycle.ts";
import { decideRetry, type RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry-policy.ts";

export interface RetryCoordinatorDeps {
  /** The ONLY journal seam (no second journal). */
  events: Pick<EventsService, "appendEvent">;
  /** Per-stream sequence allocation, duplicate detection, ledger reads. */
  journal: Pick<EventJournalRepository, "nextSequence" | "readFrom" | "findById">;
  /** The run-row reads (operation resolution, chat binding) — SQL only. */
  operations: Pick<OperationsRepository, "findRunOperation" | "findChat">;
  /** Shared short-transaction primitive (the journal + audit unit). */
  tx: SqliteTransactions;
  /** The run boundary (state reads + authoritative writes + flow hooks). */
  runControl: TaskRunOperationsSeam;
  /** The recorded PRD §8 policy by default. */
  policy?: RetryPolicy | undefined;
  /** Injectable ISO clock; default wall clock. */
  now?: (() => string) | undefined;
  /**
   * The backoff clock seam: schedule(delayMs, fn) returns a cancel function.
   * Default: an unref'd setTimeout (the runtime owns its own timers — E27).
   */
  schedule?: ((delayMs: number, fn: () => void) => () => void) | undefined;
  /** Post-commit live fanout (the WS gateway); optional. */
  publish?: ((event: EventEnvelope) => void) | undefined;
  /** Contained operator-fault sink; default discard. */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export type RetryFailureOutcome =
  | { outcome: "retry_scheduled"; attempt: number; delayMs: number; state: RunState }
  | { outcome: "paused"; reason: "retry_exhausted"; state: RunState }
  | { outcome: "failed"; code: string; state: RunState }
  | {
      outcome: "paused_for_review";
      reason: "ambiguous_external_effect";
      code: string;
      state: RunState;
    }
  | { outcome: "skipped"; reason: string; state: RunState | null };

export type RetryStartOutcome =
  { outcome: "retry_started"; attempt: number } | { outcome: "skipped"; reason: string };

/** One decision applied to one run (the test/composition surface). */
export interface RunFailureInput {
  workspaceId: string;
  runId: string;
  /** The typed failure code (worker failure_class or tool executor code). */
  failureCode: string;
  /** The journal event id of the recorded failure, when one exists. */
  failureEventId?: string | null;
}

export class RetryCoordinatorError extends Error {
  readonly code: "RUN_NOT_FOUND" | "OPERATION_NOT_FOUND";

  constructor(code: "RUN_NOT_FOUND" | "OPERATION_NOT_FOUND", message: string) {
    super(`${code}: ${message}`);
    this.name = "RetryCoordinatorError";
    this.code = code;
  }
}

export class RetryCoordinator {
  private readonly policy: RetryPolicy;
  private readonly pendingRetries = new Map<string, () => void>();

  constructor(private readonly deps: RetryCoordinatorDeps) {
    this.policy = deps.policy ?? DEFAULT_RETRY_POLICY;
  }

  private lifecycleDeps(): RowLifecycleDeps {
    return {
      tx: this.deps.tx,
      journal: this.deps.journal,
      events: this.deps.events,
      operations: this.deps.operations,
      runControl: this.deps.runControl,
      now: this.deps.now,
      publish: this.deps.publish,
      logFault: this.deps.logFault,
    };
  }

  /** The run's current D8 state through the seam (null when unknown). */
  runState(workspaceId: string, runId: string): RunState | null {
    return this.deps.runControl.runState(workspaceId, runId);
  }

  /**
   * Cancel a pending retry timer (the cancellation path calls this — a
   * cancelled run never starts a scheduled retry). Idempotent.
   */
  cancelPendingRetry(workspaceId: string, runId: string): void {
    const key = `${workspaceId}:${runId}`;
    const cancel = this.pendingRetries.get(key);
    if (cancel !== undefined) {
      cancel();
      this.pendingRetries.delete(key);
    }
  }

  /**
   * The failure entry point: classify the typed failure code, decide through
   * the bounded policy, journal the D8 transition + the audit record in one
   * transaction, advance the row through the seam, arm the backoff timer for
   * a retry. A terminal or unknown run is a typed skip — never a crash.
   */
  handleRunFailure(input: RunFailureInput): RetryFailureOutcome {
    const { workspaceId, runId } = input;
    const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
    if (operationId === null) {
      throw new RetryCoordinatorError(
        "RUN_NOT_FOUND",
        `run ${runId} not found in workspace ${workspaceId}`,
      );
    }
    const currentState = this.deps.runControl.runState(workspaceId, runId);
    if (currentState === null) {
      throw new RetryCoordinatorError(
        "RUN_NOT_FOUND",
        `run ${runId} not found in workspace ${workspaceId}`,
      );
    }

    const attemptsSoFar = this.consumedRetries(workspaceId, runId);
    const decision = decideRetry({
      failureCode: input.failureCode,
      attemptsSoFar,
      policy: this.policy,
    });

    if (decision.action === "retry") {
      const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
        workspaceId,
        runId,
        command: "schedule_retry",
        actor: { type: "runtime", id: "runtime-gateway" },
        attempt: decision.attempt,
        failureEventId: input.failureEventId ?? null,
        maxRetries: this.policy.maxAttempts ?? DEFAULT_MAX_RETRIES,
        audit: {
          decision: "retry",
          failureCode: input.failureCode,
          reason: "classified_transient",
          attempt: decision.attempt,
          delayMs: decision.delayMs,
        },
      });
      if (!applied.ok) {
        return { outcome: "skipped", reason: applied.reason, state: currentState };
      }
      this.armRetry(workspaceId, runId, decision.attempt, decision.delayMs);
      return {
        outcome: "retry_scheduled",
        attempt: decision.attempt,
        delayMs: decision.delayMs,
        state: "RETRYING",
      };
    }

    if (decision.action === "pause") {
      const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
        workspaceId,
        runId,
        command: "pause_retry_exhausted",
        actor: { type: "runtime", id: "runtime-gateway" },
        audit: {
          decision: "pause",
          failureCode: input.failureCode,
          reason: "retry_exhausted",
          attempt: null,
          delayMs: null,
        },
      });
      if (!applied.ok) {
        return { outcome: "skipped", reason: applied.reason, state: currentState };
      }
      return { outcome: "paused", reason: "retry_exhausted", state: "PAUSED" };
    }

    if (decision.action === "fail") {
      const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
        workspaceId,
        runId,
        command: "fail_task",
        actor: { type: "runtime", id: "runtime-gateway" },
        audit: {
          decision: "fail",
          failureCode: input.failureCode,
          reason: "classified_permanent",
          attempt: null,
          delayMs: null,
        },
      });
      if (!applied.ok) {
        return { outcome: "skipped", reason: applied.reason, state: currentState };
      }
      return { outcome: "failed", code: decision.code, state: "FAILED" };
    }

    // pause_for_review (AC10/E13): an ambiguous external effect is never
    // blindly retried — the run goes to RECOVERY_REQUIRED with the reason
    // recorded on the stream (the transition table's unprovable_external_
    // effect reason + the audit record's classification).
    const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
      workspaceId,
      runId,
      command: "recovery_required",
      actor: { type: "runtime", id: "runtime-gateway" },
      audit: {
        decision: "pause_for_review",
        failureCode: input.failureCode,
        reason: "ambiguous_external_effect",
        attempt: null,
        delayMs: null,
      },
    });
    if (!applied.ok) {
      return { outcome: "skipped", reason: applied.reason, state: currentState };
    }
    return {
      outcome: "paused_for_review",
      reason: "ambiguous_external_effect",
      code: decision.code,
      state: "RECOVERY_REQUIRED",
    };
  }

  /**
   * Fire one scheduled retry: RETRYING → RUNNING (the task.retry_started
   * envelope journals first, then the seam write — the composed flow starts
   * the run's worker from the RUNNING transition). A run that moved on while
   * the backoff elapsed (cancelled, paused, terminal) is a typed skip — the
   * stale timer never resurrects anything.
   */
  startRetryAttempt(input: {
    workspaceId: string;
    runId: string;
    attempt: number;
  }): RetryStartOutcome {
    const { workspaceId, runId } = input;
    this.pendingRetries.delete(`${workspaceId}:${runId}`);
    const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
    if (operationId === null) {
      return { outcome: "skipped", reason: "run_not_found" };
    }
    const currentState = this.deps.runControl.runState(workspaceId, runId);
    if (currentState !== "RETRYING") {
      return { outcome: "skipped", reason: `run is ${currentState ?? "unknown"}, not RETRYING` };
    }
    const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
      workspaceId,
      runId,
      command: "retry_attempt",
      actor: { type: "runtime", id: "runtime-gateway" },
      attempt: input.attempt,
      maxRetries: this.policy.maxAttempts ?? DEFAULT_MAX_RETRIES,
    });
    if (!applied.ok) {
      return { outcome: "skipped", reason: applied.reason };
    }
    return { outcome: "retry_started", attempt: input.attempt };
  }

  /** Drop every pending retry timer (composition shutdown). */
  dispose(): void {
    for (const cancel of this.pendingRetries.values()) cancel();
    this.pendingRetries.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private armRetry(workspaceId: string, runId: string, attempt: number, delayMs: number): void {
    const key = `${workspaceId}:${runId}`;
    this.cancelPendingRetry(workspaceId, runId);
    const schedule =
      this.deps.schedule ??
      ((ms: number, fn: () => void) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    const cancel = schedule(delayMs, () => {
      try {
        const outcome = this.startRetryAttempt({ workspaceId, runId, attempt });
        if (outcome.outcome === "skipped") {
          this.faultLog("retry_attempt_skipped", {
            workspace_id: workspaceId,
            run_id: runId,
            attempt,
            reason: outcome.reason,
          });
        }
      } catch (error) {
        // Contained: a failed retry start never crashes the runtime; the run
        // sits in RETRYING and the recovery slice's reconciliation owns it.
        this.faultLog("retry_attempt_failed", {
          workspace_id: workspaceId,
          run_id: runId,
          attempt,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.pendingRetries.set(key, cancel);
  }

  /** Attempts already consumed, read from the journal (the ledger IS the stream). */
  private consumedRetries(workspaceId: string, runId: string): number {
    const rows = this.deps.journal.readFrom(workspaceId, taskStreamId(runId), 0, 10_000);
    let max = 0;
    for (const row of rows) {
      if (row.event_type !== "task.retry_scheduled") continue;
      try {
        const verdict = EVENT_ENVELOPES["task.retry_scheduled"].safeParse(JSON.parse(row.payload));
        if (!verdict.success) continue;
        const payload = (verdict.data as { payload: { attempt?: number } }).payload;
        if (typeof payload.attempt === "number" && payload.attempt > max) max = payload.attempt;
      } catch {
        // A corrupt row never breaks the ledger read (bounded, skipped).
      }
    }
    return max;
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break the coordinator.
    }
  }
}
