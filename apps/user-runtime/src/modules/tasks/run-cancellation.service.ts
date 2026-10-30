/**
 * RunCancellationService (S22 chunk 4; PRD §8, AC15, AC4, AC5, AC6, AC7, AC8,
 * AC9, D8, D9, D20, D27, D32, E13) — the USER cancel path for a run.
 *
 * The recorded D8 two-step cancellation, exactly like the approvals cascade
 * but entered from the run (not the approval card):
 *
 *   1. cancel_task (user/admin actor) → CANCELLING — journalled through the
 *      shared row-lifecycle applier, row advanced through the run-control
 *      seam (the composed applyRunState fires the worker stop from it);
 *   2. the TEARDOWN — every holding the run has, each step idempotent and
 *      contained: pending retry timers dropped, in-flight/withheld tool
 *      executions cancelled through the S21 executor seam, the worker stop
 *      awaited through the supervisor port (the process-group kill — D27/
 *      D32), non-terminal child runs cancelled in turn (they never start —
 *      the E1 dequeue drops terminal runs), write leases force-released
 *      (D6/S17), the S24 credit-reservation seam fired (the ledger is NOT
 *      built yet — the seam is the recorded call, never a fake ledger),
 *      pending approvals resolved CANCELLED with no grant (AC9, D9);
 *   3. cancel_complete (runtime actor) → CANCELLED — journalled, row
 *      advanced; the preserved logs/outputs are LISTED in the answer (AC6).
 *
 * Deterministic outcomes (AC7): a CANCELLED run answers `already_cancelled`
 * (a no-op, never an error); a run that settled first (SUCCEEDED/FAILED)
 * answers `already_settled` with its terminal state — the cancel lost the
 * race and nothing corrupts; an agent actor is refused (the table's cancel
 * rows allow user/admin — an Agent cannot cancel what it runs for someone
 * else; the G6 refusal shape).
 *
 * Governing records: PRD §8, §13; D8, D9, D20, D27, D32, E13; AC15 and the
 * slice's cancellation ACs.
 */
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { RunState } from "@shera-bot/contracts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import type { ApprovalsService } from "../approvals/approvals.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import { applyRowLifecycleTransition, type RowLifecycleDeps } from "./run-lifecycle.ts";
import { taskStreamId } from "./task-events.ts";

/** The run-scoped seams cancellation tears down. Every port is optional so
 * compositions (and tests) wire exactly what exists — an unwired port is an
 * honest no-op with the gap visible in the composed wiring, never a hidden
 * fake (G4). */
export interface RunCancellationDeps {
  tx: SqliteTransactions;
  /** Sequence allocation + the preserved-log reads (the journal IS the log). */
  journal: Pick<EventJournalRepository, "nextSequence" | "readFrom" | "findById">;
  events: Pick<EventsService, "appendEvent">;
  /** Run-row reads: operation resolution, chat binding, run rows, children. */
  operations: Pick<
    OperationsRepository,
    "findRunOperation" | "findChat" | "getRun" | "listRunsByParentTaskId"
  >;
  /** The run boundary (state reads + authoritative writes + flow hooks). */
  runControl: TaskRunOperationsSeam;
  /** The task-worker supervisor port (the process-group kill awaits here). */
  workers?:
    { stopWorker(workspaceId: string, runId: string, reason: string): Promise<void> } | undefined;
  /** The S21 executor seam (withheld drop + non-terminal row sweep). */
  executor?: { cancelForTask(workspaceId: string, taskId: string): string[] } | undefined;
  /** The S17 write-lease force-release (the runtime's only lease steal). */
  leases?: Pick<WriteLeasesRepository, "releaseLeasesForTask"> | undefined;
  /**
   * The S24 credit-reservation seam (D20): releases the reservations the run
   * holds. The credit ledger is slice S24 — this port is the HONEST seam it
   * will implement; the prototype records the call and nothing else.
   */
  reservations?: { releaseForRun(workspaceId: string, runId: string): void } | undefined;
  /** The S20 approval machinery (pending requests resolve CANCELLED, AC9). */
  approvals?: Pick<ApprovalsService, "cancelPendingForTask"> | undefined;
  /** The retry coordinator (pending backoff timers drop). */
  retryCoordinator?: { cancelPendingRetry(workspaceId: string, runId: string): void } | undefined;
  now?: (() => string) | undefined;
  publish?: ((event: EventEnvelope) => void) | undefined;
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export type RunCancellationOutcome =
  | {
      outcome: "cancelled";
      run_id: string;
      state: RunState;
      cancelled_child_run_ids: string[];
      cancelled_approval_ids: string[];
      cancelled_execution_ids: string[];
      released_lease_count: number;
      reservation_release_requested: boolean;
      preserved: {
        artifact_ids: string[];
        journal_event_count: number;
      };
    }
  | { outcome: "already_cancelled"; run_id: string }
  | { outcome: "already_settled"; run_id: string; state: RunState }
  | { outcome: "actor_refused"; run_id: string; reason: string }
  | { outcome: "not_found"; run_id: string };

/** The cancellation recursion bound (a parent → children → grandchildren
 * chain is the deepest real shape; deeper chains are a data error). */
const MAX_CHILD_DEPTH = 5;

export class RunCancellationService {
  constructor(private readonly deps: RunCancellationDeps) {}

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

  /**
   * Cancel one run (idempotent, deterministic on races). The two D8 steps
   * and the teardown are each independent: a teardown step's failure is
   * contained (fault log) and the cancellation still completes — a cancelled
   * run never stays half-torn-down because one port threw.
   */
  async cancelRun(input: {
    workspaceId: string;
    runId: string;
    actor: { type: string; id: string };
  }): Promise<RunCancellationOutcome> {
    const { workspaceId, runId, actor } = input;
    const currentState = this.deps.runControl.runState(workspaceId, runId);
    if (currentState === null) {
      return { outcome: "not_found", run_id: runId };
    }
    // Deterministic no-ops (AC7): replaying a finished cancellation, or a
    // cancel that lost the race against completion, never errors and never
    // corrupts. CANCELLING falls through: the steps are idempotent, so a
    // re-entrant cancel CONVERGES (it completes the teardown + step 2).
    if (currentState === "CANCELLED") {
      return { outcome: "already_cancelled", run_id: runId };
    }
    if (currentState === "SUCCEEDED" || currentState === "FAILED") {
      return { outcome: "already_settled", run_id: runId, state: currentState };
    }

    // Step 1: → CANCELLING (the actor must be user/admin — the table's rows;
    // an agent refusal is the typed outcome, never a throw).
    if (currentState !== "CANCELLING") {
      const cancelling = applyRowLifecycleTransition(this.lifecycleDeps(), {
        workspaceId,
        runId,
        command: "cancel_task",
        actor: actor.type === "admin" ? { type: "admin", id: actor.id } : actor,
      });
      if (!cancelling.ok) {
        if (cancelling.reason.startsWith("actor ")) {
          return { outcome: "actor_refused", run_id: runId, reason: cancelling.reason };
        }
        // A lost concurrent race (already CANCELLING/CANCELLED): re-read and
        // answer deterministically.
        const nowState = this.deps.runControl.runState(workspaceId, runId);
        if (nowState === "CANCELLED") return { outcome: "already_cancelled", run_id: runId };
        if (nowState === "SUCCEEDED" || nowState === "FAILED") {
          return { outcome: "already_settled", run_id: runId, state: nowState };
        }
        if (nowState === "CANCELLING") {
          // Fall through to the convergent teardown below.
        } else {
          return { outcome: "not_found", run_id: runId };
        }
      }
    }

    // The teardown — every step idempotent and contained. The child cascade
    // cancels with the ORIGINATING actor (the user's action ripples to the
    // children; the D8 table's cancel rows are user/admin).
    const cancelledChildRunIds = await this.teardown(
      workspaceId,
      runId,
      0,
      actor.type === "admin" ? { type: "admin", id: actor.id } : { type: "user", id: actor.id },
    );

    // Step 2: CANCELLING → CANCELLED (runtime actor), then the preserved
    // inventory (AC6) — read AFTER the terminal write so the answer is the
    // honest post-cancel state.
    const completed = applyRowLifecycleTransition(this.lifecycleDeps(), {
      workspaceId,
      runId,
      command: "cancel_complete",
      actor: { type: "runtime", id: "runtime-gateway" },
      audit: {
        decision: "cancelled",
        failureCode: "user_requested",
        reason: "cancellation_completed",
        attempt: null,
        delayMs: null,
      },
    });
    if (!completed.ok) {
      // The terminal step lost a race to another writer; re-read and answer
      // deterministically (never an error for the user).
      const nowState = this.deps.runControl.runState(workspaceId, runId);
      if (nowState === "CANCELLED") return { outcome: "already_cancelled", run_id: runId };
      if (nowState === "SUCCEEDED" || nowState === "FAILED") {
        return { outcome: "already_settled", run_id: runId, state: nowState };
      }
      return { outcome: "already_cancelled", run_id: runId };
    }

    const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
    const runRow =
      operationId !== null ? this.deps.operations.getRun(workspaceId, operationId, runId) : null;
    return {
      outcome: "cancelled",
      run_id: runId,
      state: "CANCELLED",
      cancelled_child_run_ids: cancelledChildRunIds,
      cancelled_approval_ids: this.cancelledApprovalIds.get(runId) ?? [],
      cancelled_execution_ids: this.cancelledExecutionIds.get(runId) ?? [],
      released_lease_count: this.releasedLeaseCount.get(runId) ?? 0,
      reservation_release_requested: this.reservationRequested.has(runId),
      preserved: {
        artifact_ids: runRow?.artifacts ?? [],
        journal_event_count: this.deps.journal.readFrom(workspaceId, taskStreamId(runId), 0, 10_000)
          .length,
      },
    };
  }

  // ── Teardown (per-run evidence bookkeeping) ────────────────────────────────

  private readonly cancelledApprovalIds = new Map<string, string[]>();
  private readonly cancelledExecutionIds = new Map<string, string[]>();
  private readonly releasedLeaseCount = new Map<string, number>();
  private readonly reservationRequested = new Set<string>();

  /** Tear down everything the run holds; cancel non-terminal children. */
  private async teardown(
    workspaceId: string,
    runId: string,
    depth: number,
    originActor: { type: "user" | "admin"; id: string },
  ): Promise<string[]> {
    const cancelledChildRunIds: string[] = [];

    // Pending retry timers: a cancelled run never starts a scheduled retry.
    try {
      this.deps.retryCoordinator?.cancelPendingRetry(workspaceId, runId);
    } catch (error) {
      this.faultLog("run_cancel_retry_timer_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // Tool work through the S21 executor seam (withheld drop + row sweep).
    try {
      const ids = this.deps.executor?.cancelForTask(workspaceId, runId) ?? [];
      this.cancelledExecutionIds.set(runId, ids);
    } catch (error) {
      this.faultLog("run_cancel_executor_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // The worker: the composed flow's stop hook fired on the CANCELLING row
    // write; the awaited port call is the deterministic "it is dead" point
    // (the process-group kill — D27/D32). Idempotent with the hook.
    try {
      await this.deps.workers?.stopWorker(workspaceId, runId, "requested");
    } catch (error) {
      this.faultLog("run_cancel_worker_stop_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // Write leases (D6/S17): the runtime force-releases at the terminal
    // state; a lease NEVER outlives its task.
    try {
      const released = this.deps.leases?.releaseLeasesForTask(runId) ?? 0;
      this.releasedLeaseCount.set(runId, released);
    } catch (error) {
      this.faultLog("run_cancel_lease_release_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // Credit reservations (D20): the S24 ledger implements this port; today
    // the composed seam records the call (never a fake ledger — G4).
    try {
      this.deps.reservations?.releaseForRun(workspaceId, runId);
      this.reservationRequested.add(runId);
    } catch (error) {
      this.faultLog("run_cancel_reservation_release_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // Pending approvals resolve CANCELLED, no grant (AC9, D9). The composed
    // approvals service is shared state — the evidence map is per-run.
    try {
      const ids = this.deps.approvals?.cancelPendingForTask(workspaceId, runId) ?? [];
      this.cancelledApprovalIds.set(runId, ids);
    } catch (error) {
      this.faultLog("run_cancel_approval_resolve_failed", {
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
      });
    }

    // Children (D34 delegated subruns): non-terminal children are cancelled
    // in turn — they never start (the E1 dequeue drops terminal runs), and
    // a running child's own worker stops through ITS cancellation. Already-
    // terminal children keep their outcome (never resurrected — G5).
    if (depth < MAX_CHILD_DEPTH) {
      let children: Array<{ run_id: string; state: RunState; operation_id: string }> = [];
      try {
        children = this.deps.operations.listRunsByParentTaskId(workspaceId, runId);
      } catch (error) {
        this.faultLog("run_cancel_children_read_failed", {
          run_id: runId,
          name: error instanceof Error ? error.name : "Error",
        });
      }
      for (const child of children) {
        if (
          child.state === "CANCELLED" ||
          child.state === "SUCCEEDED" ||
          child.state === "FAILED"
        ) {
          continue;
        }
        const childOutcome = await this.cancelRun({
          workspaceId,
          runId: child.run_id,
          actor: originActor,
        });
        if (childOutcome.outcome === "cancelled") {
          cancelledChildRunIds.push(child.run_id);
        }
      }
    }
    return cancelledChildRunIds;
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break the cancellation.
    }
  }
}
