/**
 * RetryCoordinator (S22 chunk 2; PRD §8, AC14, AC2, AC3, AC10, D8, E13, D20,
 * G2) — the RUNTIME-OWNED retry clock and decision applier.
 *
 * The PURE policy (retry-policy.ts) classifies one failure and bounds the
 * attempts; THIS service applies the decision to a real run row through the
 * D8 machinery — never a second state machine:
 *
 *  - transition legality is checked against the SAME TASK_TRANSITIONS table
 *    the pure transition function serves (the table as data, D23 rule 5);
 *    row-based runs (created through the operations seam) have no
 *    journal-rebuildable TaskRun projection, so the coordinator validates
 *    (from-state, command) against the table directly and journals the
 *    contract lifecycle envelope through buildTaskTransitionEvent — the same
 *    builder the approvals path journals through;
 *  - the optimistic version is 1 + the journalled lifecycle count on the
 *    run's task stream (task:<run_id>) — the exact rebuild discipline the
 *    approvals read model uses, so a concurrent decision is a typed
 *    version conflict, never a double-apply;
 *  - every decision journals the contract lifecycle envelope AND the
 *    `run.failure_decided` audit record in ONE transaction (D10), then
 *    advances the run row through the injected run-control seam (the SAME
 *    seam the supervisor uses — the composed applyRunState drives the worker
 *    lifecycle from it, journal-first, the E27 aftermath ordering);
 *  - the backoff clock is the injected `schedule` seam (deterministic tests;
 *    the runtime owns its own timers — BullMQ/Redis remains rejected, E27).
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
import { EVENT_ENVELOPES, TASK_LIFECYCLE_EVENT_TYPES, type RunState } from "@shera-bot/contracts";

import type { EventJournalRepository, EventJournalRow } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import { buildTaskTransitionEvent, taskStreamId } from "./task-events.ts";
import { TASK_TRANSITIONS, type TaskTransitionRow } from "./task-transitions.ts";
import { decideRetry, type RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry-policy.ts";

/** The lifecycle command types this coordinator applies (closed set). */
type LifecycleCommand =
  | "schedule_retry"
  | "retry_attempt"
  | "pause_retry_exhausted"
  | "fail_task"
  | "recovery_required";

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
  | { outcome: "paused_for_review"; reason: "ambiguous_external_effect"; code: string; state: RunState }
  | { outcome: "skipped"; reason: string; state: RunState | null };

export type RetryStartOutcome =
  | { outcome: "retry_started"; attempt: number }
  | { outcome: "skipped"; reason: string };

/** One decision applied to one run (the test/composition surface). */
export interface RunFailureInput {
  workspaceId: string;
  runId: string;
  /** The typed failure code (worker failure_class or tool executor code). */
  failureCode: string;
  /** The journal event id of the recorded failure, when one exists. */
  failureEventId?: string | null;
}

/** The lifecycle event types that ARE transitions (task.created is not — it
 * is the version-1 creation the count starts from; the same exclusion the
 * approvals rebuild records). Row-based runs have no task.created on their
 * stream, so version = 1 + this count. */
const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  TASK_LIFECYCLE_EVENT_TYPES.filter((type) => type !== "task.created"),
);

export class RetryCoordinatorError extends Error {
  readonly code: "RUN_NOT_FOUND" | "OPERATION_NOT_FOUND";

  constructor(code: "RUN_NOT_FOUND" | "OPERATION_NOT_FOUND", message: string) {
    super(`${code}: ${message}`);
    this.name = "RetryCoordinatorError";
    this.code = code;
  }
}

/** Internal: the deterministic event id already exists (a concurrent
 * duplicate decision lost the race) — the winner's row is the contract. */
class TransitionDuplicateError extends Error {
  constructor() {
    super("transition already applied");
    this.name = "TransitionDuplicateError";
  }
}

export class RetryCoordinator {
  private readonly policy: RetryPolicy;
  private readonly pendingRetries = new Map<string, () => void>();

  constructor(private readonly deps: RetryCoordinatorDeps) {
    this.policy = deps.policy ?? DEFAULT_RETRY_POLICY;
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
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
      const applied = this.applyTransition({
        workspaceId,
        runId,
        operationId,
        command: "schedule_retry",
        attempt: decision.attempt,
        failureEventId: input.failureEventId ?? null,
        failureCode: input.failureCode,
        decision: {
          decision: "retry",
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
      const applied = this.applyTransition({
        workspaceId,
        runId,
        operationId,
        command: "pause_retry_exhausted",
        attempt: null,
        failureEventId: input.failureEventId ?? null,
        failureCode: input.failureCode,
        decision: { decision: "pause", reason: "retry_exhausted", attempt: null, delayMs: null },
      });
      if (!applied.ok) {
        return { outcome: "skipped", reason: applied.reason, state: currentState };
      }
      return { outcome: "paused", reason: "retry_exhausted", state: "PAUSED" };
    }

    if (decision.action === "fail") {
      const applied = this.applyTransition({
        workspaceId,
        runId,
        operationId,
        command: "fail_task",
        attempt: null,
        failureEventId: input.failureEventId ?? null,
        failureCode: input.failureCode,
        decision: { decision: "fail", reason: "classified_permanent", attempt: null, delayMs: null },
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
    const applied = this.applyTransition({
      workspaceId,
      runId,
      operationId,
      command: "recovery_required",
      attempt: null,
      failureEventId: input.failureEventId ?? null,
      failureCode: input.failureCode,
      decision: {
        decision: "pause_for_review",
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
  startRetryAttempt(input: { workspaceId: string; runId: string; attempt: number }): RetryStartOutcome {
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
    const applied = this.applyTransition({
      workspaceId,
      runId,
      operationId,
      command: "retry_attempt",
      attempt: input.attempt,
      failureEventId: null,
      failureCode: "",
      decision: null,
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
    const schedule = this.deps.schedule ?? ((ms: number, fn: () => void) => {
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

  /**
   * Apply ONE D8 transition to a row-based run: legality against the recorded
   * TASK_TRANSITIONS table, optimistic version = 1 + the journalled lifecycle
   * count, the contract envelope + the audit record in ONE transaction, then
   * the row write through the run-control seam (flow hooks fire from it).
   * Journal-first: a seam-write failure leaves the evidence committed and is
   * contained (the E27 aftermath ordering), never rolled into silence.
   */
  private applyTransition(args: {
    workspaceId: string;
    runId: string;
    operationId: string;
    command: LifecycleCommand;
    attempt: number | null;
    failureEventId: string | null;
    failureCode: string;
    decision: {
      decision: "retry" | "pause" | "fail" | "pause_for_review";
      reason: string;
      attempt: number | null;
      delayMs: number | null;
    } | null;
  }): { ok: true } | { ok: false; reason: string } {
    const { workspaceId, runId, operationId, command } = args;
    const currentState = this.deps.runControl.runState(workspaceId, runId);
    if (currentState === null) {
      return { ok: false, reason: "run_not_found" };
    }
    const row: TaskTransitionRow | undefined = TASK_TRANSITIONS.find(
      (candidate) => candidate.from === currentState && candidate.command === command,
    );
    if (row === undefined) {
      return { ok: false, reason: `illegal transition ${currentState} --${command}--> ?` };
    }

    const streamId = taskStreamId(runId);
    const conversationId =
      this.deps.operations.findChat(workspaceId, operationId) ?? operationId;
    const now = this.now();
    const publishedEvents: EventEnvelope[] = [];

    try {
      this.deps.tx.transaction((exec) => {
        // Optimistic version: 1 + every journalled lifecycle transition on
        // this stream (the approvals rebuild discipline). The version is
        // baked into the DETERMINISTIC event id, so a lost concurrent race
        // (two decisions computed against the same version) deduplicates at
        // the journal append — the winner's row is the contract, the loser
        // skips (the same idempotency shape as the collaboration appends).
        const version =
          1 +
          this.deps.journal
            .readFrom(workspaceId, streamId, 0, 10_000, exec)
            .filter((candidate: EventJournalRow) => LIFECYCLE_EVENT_TYPES.has(candidate.event_type))
            .length;
        const commandId = `cmd_${command}_${runId}_v${version}`;
        if (this.deps.journal.findById(workspaceId, `evt_${commandId}`, exec) !== null) {
          throw new TransitionDuplicateError();
        }
        const sequence = this.deps.journal.nextSequence(streamId, workspaceId, exec);
        const envelope = buildTaskTransitionEvent({
          run: { task_id: runId, conversation_id: conversationId },
          command: { command_id: commandId, actor: { type: "runtime", id: "runtime-gateway" } },
          eventType: row.event,
          payload: {
            from_state: row.from,
            to_state: row.to,
            reason: row.reason,
            correlation_id: commandId,
            ...(args.attempt !== null ? { attempt: args.attempt } : {}),
            ...(args.failureEventId !== null ? { failure_event_id: args.failureEventId } : {}),
          },
          clock: { now, next_sequence: sequence },
        });
        this.deps.events.appendEvent({
          event_id: envelope.event_id,
          stream_id: envelope.stream_id,
          type: envelope.event_type,
          payload: envelope,
          workspace_id: workspaceId,
          correlation_id: commandId,
        });
        if (args.decision !== null) {
          const decisionEnvelope = this.deps.events.appendEvent({
            event_id: `evt_failure_decision_v${version}_${runId}`,
            stream_id: streamId,
            type: "run.failure_decided",
            payload: {
              workspace_id: workspaceId,
              run_id: runId,
              decision: args.decision.decision,
              failure_code: args.failureCode,
              reason: args.decision.reason,
              attempt: args.decision.attempt,
              delay_ms: args.decision.delayMs,
            },
            workspace_id: workspaceId,
            correlation_id: commandId,
          });
          publishedEvents.push(decisionEnvelope);
        }
      });
    } catch (error) {
      if (error instanceof TransitionDuplicateError) {
        return { ok: false, reason: "already_applied" };
      }
      this.faultLog("retry_transition_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        command,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: "transition_failed" };
    }

    // Post-commit: the row write through the seam (flow hooks — the composed
    // applyRunState drives the worker lifecycle from it) and the live fanout.
    // Journal-first: a seam-write failure leaves the evidence committed and
    // is contained (the E27 aftermath ordering), never rolled into silence.
    try {
      this.deps.runControl.applyRunState(workspaceId, runId, row.to);
    } catch (error) {
      this.faultLog("retry_row_state_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        target: row.to,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (publishedEvents.length > 0 && this.deps.publish) {
      for (const event of publishedEvents) {
        try {
          this.deps.publish(event);
        } catch (error) {
          this.faultLog("retry_publish_failed", {
            workspace_id: workspaceId,
            run_id: runId,
            name: error instanceof Error ? error.name : "Error",
          });
        }
      }
    }
    return { ok: true };
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break the coordinator.
    }
  }
}
