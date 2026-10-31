/**
 * SchedulerService (S28 chunk 3; PRD §8, §13, E5, D11, D17, D20/D48, D23
 * rule 6, D34, G2, G3) — the RUNTIME-OWNED scheduler engine (D11: the
 * runtime owns its own clocks and queues; Redis/BullMQ remains rejected per
 * E27).
 *
 * The firing pipeline for ONE occurrence (at-least-once with de-duplication,
 * E5):
 *
 *   1. CLAIM — the firing ledger row (its primary key IS the idempotency
 *      key) is inserted first; a duplicate delivery/occurrence answers the
 *      ledger's recorded outcome and never runs twice (D23 rule 6).
 *   2. RESERVATION — the S24 credit seam is consulted BEFORE anything runs;
 *      a refusal pauses the trigger with the D48 reason
 *      (`insufficient_credits`), journals the decision on the trigger's
 *      stream, and NO run is created (nothing runs unfunded). The ledger is
 *      slice S24 — the composed port is the honest seam (the same posture
 *      as S22's release seam), recorded in E37.
 *   3. PROVIDER GATE — the D17 run-start custody check consults the
 *      configured provider pair BEFORE the run exists; a refusal is the
 *      typed configuration state on the trigger's stream (a configuration
 *      problem is not a credit pause; the trigger stays active).
 *   4. RUN — the typed D34 trigger event is journalled as the run stream's
 *      FIRST event (the G2 origin: the run exists because a typed trigger
 *      exists, never because prose classified into one), and the run row is
 *      created in the trigger's target Operation with its provider snapshot
 *      and parent linkage (AC6). The run id is DETERMINISTIC from the
 *      idempotency key — a replay can never fork a second run.
 *   5. WALK — the autonomous D8 walk (queue -> start -> the plan runner's
 *      legs -> complete) through the SHARED row-lifecycle applier (never a
 *      second state machine). A failing plan fails the run with its typed
 *      code; the occurrence is consumed (at-least-once, not unbounded
 *      retry — the S22 retry machinery owns transient-failure policy for
 *      worker runs).
 *   6. SETTLE — the ledger row records the outcome + run linkage; the
 *      trigger's bookkeeping (last firing, last occurrence, next
 *      occurrence) updates so the UI renders truth against the scheduler
 *      (AC9).
 *
 * The tick loop is the production convenience (the injected `schedule`
 * seam, unref'd); tests drive fireOccurrence/reconcile directly on the
 * injected clock. Governing records: PRD §8/§13, E5, D11, D17, D20, D48,
 * D23 rule 6, D34; AC2/AC3/AC6/AC8.
 */
import { createHash, randomUUID } from "node:crypto";

import type { TypedExecutionEvent } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { TriggerRecordRow, TriggersRepository } from "../../adapters/sqlite/triggers-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { OperationsService } from "../operations/operations.service.ts";
import {
  applyRowLifecycleTransition,
  type RowLifecycleDeps,
} from "../tasks/run-lifecycle.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { nextOccurrence } from "./schedule-clock.ts";
import type { TriggerPlan } from "./schedules.types.ts";

/** The S24 credit-seam port (the honest recorded seam — the ledger is slice
 * S24; the composed default records the consult and allows, the way S22's
 * release seam records its request). */
export interface ReservationPort {
  reserveForRun(input: {
    workspace_id: string;
    trigger_id: string;
    run_id: string;
    estimate_credits: number;
  }): { ok: true; reservation_id: string } | { ok: false; code: "insufficient_credits" };
}

/** The D17 run-start custody check (composed ONLY under enforcement). */
export interface SchedulerRunGate {
  checkRunStart(
    workspaceId: string,
    providerId: string,
  ): { ok: true } | { ok: false; code: string; safe_message: string };
}

/** The autonomous plan runner (the run's typed legs between start and
 * complete). The composition wires the real runner (model call + tool use +
 * artifact — chunk 5); tests and bare compositions get the honest no-op. */
export interface SchedulerPlanRunner {
  runPlan(input: {
    workspace_id: string;
    operation_id: string;
    conversation_id: string;
    run_id: string;
    plan: TriggerPlan;
  }): { ok: true; result_summary: string } | { ok: false; code: string };
}

export interface SchedulerDeps {
  /** E12: the container's workspace (the prototype has exactly one). */
  workspaceId: string;
  triggers: TriggersRepository;
  operations: OperationsRepository;
  /** The run-row creation + D8 row writes through the operations service. */
  ops: Pick<OperationsService, "createRun" | "applyRunState" | "getRun" | "listRuns">;
  journal: EventJournalRepository;
  events: Pick<EventsService, "appendEvent">;
  tx: SqliteTransactions;
  reservations: ReservationPort;
  /** D17 enforcement seam; absent outside enforcement (the mock posture). */
  runGate?: SchedulerRunGate | undefined;
  /** The autonomous plan legs; absent = the honest no-op walk (G4). */
  planRunner?: SchedulerPlanRunner | undefined;
  /** Injectable ISO clock; default wall clock. */
  now?: (() => string) | undefined;
  /**
   * The tick-clock seam: schedule(delayMs, fn) returns a cancel function.
   * Default: an unref'd setInterval-style timer (the runtime owns its own
   * timers — E27).
   */
  schedule?: ((delayMs: number, fn: () => void) => () => void) | undefined;
  /** Contained operator-fault sink; default discard. */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** Post-commit live fanout (the WS gateway); optional. */
  publish?: ((event: { stream_id: string; type: string }) => void) | undefined;
}

/** One occurrence to fire: the idempotency key is DATA (D23 rule 6). */
export interface TriggerOccurrence {
  idempotencyKey: string;
  /** The occurrence/delivery instant (the schedule occurrence for schedules). */
  dueAt: string;
  /** Per-kind firing context (due_at, change_type, parent run id, ...). */
  detail: Record<string, unknown>;
}

export type FireOutcome =
  | { outcome: "fired"; runId: string }
  | { outcome: "deduplicated" }
  | { outcome: "paused_credits" }
  | { outcome: "refused_provider"; code: string }
  | { outcome: "failed"; code: string };

export interface TriggerFiring {
  workspace_id: string;
  trigger_id: string;
  idempotency_key: string;
  run_id: string | null;
  outcome: string;
  detail_json: string | null;
  fired_at: string;
}

const DEFAULT_TICK_MS = 1_000;

export class SchedulerService {
  private tickTimer: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private lifecycleDeps(): RowLifecycleDeps {
    return {
      tx: this.deps.tx,
      journal: this.deps.journal,
      events: this.deps.events,
      operations: this.deps.operations,
      runControl: {
        runState: (workspaceId, runId) => {
          const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
          if (operationId === null) return null;
          try {
            return this.deps.ops.getRun(workspaceId, operationId, runId).state;
          } catch {
            return null;
          }
        },
        applyRunState: (workspaceId, runId, state) => {
          const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
          if (operationId === null) throw new Error(`run ${runId} not found`);
          this.deps.ops.applyRunState(workspaceId, operationId, runId, state);
        },
      },
      now: this.deps.now,
      publish: this.deps.publish as RowLifecycleDeps["publish"],
      logFault: this.deps.logFault,
    };
  }

  /**
   * Fire one occurrence. Step 1 is the CLAIM; everything else runs only for
   * the claim's winner. A duplicate answers the ledger (deduplicated) and
   * never touches a run.
   */
  fireOccurrence(
    workspaceId: string,
    triggerId: string,
    occurrence: TriggerOccurrence,
  ): FireOutcome {
    const trigger = this.deps.triggers.getTrigger(workspaceId, triggerId);
    if (trigger === null) {
      return { outcome: "failed", code: "TRIGGER_NOT_FOUND" };
    }
    const claim = this.deps.triggers.recordFiring({
      workspace_id: workspaceId,
      trigger_id: triggerId,
      idempotency_key: occurrence.idempotencyKey,
      run_id: null,
      outcome: "claimed",
      detail_json: JSON.stringify(occurrence.detail),
      fired_at: this.now(),
    });
    if (claim === "duplicate") {
      return { outcome: "deduplicated" };
    }
    return this.executeClaimedFiring(trigger, occurrence);
  }

  /**
   * Steps 2–6 for an ALREADY-CLAIMED firing (the fire pipeline after the
   * claim, and the boot re-drive's re-entry for a crash between the claim
   * and the run). Contained: a failure marks the firing 'failed' and never
   * throws past this boundary.
   */
  executeClaimedFiring(trigger: TriggerRecordRow, occurrence: TriggerOccurrence): FireOutcome {
    const { workspace_id: workspaceId, trigger_id: triggerId } = trigger;

    // Step 2: the reservation consult (D20/D48) — BEFORE anything runs.
    const runId = `run_${createHash("sha256").update(occurrence.idempotencyKey).digest("hex").slice(0, 24)}`;
    const reservation = this.deps.reservations.reserveForRun({
      workspace_id: workspaceId,
      trigger_id: triggerId,
      run_id: runId,
      estimate_credits: 0,
    });
    if (!reservation.ok) {
      this.deps.triggers.updateTriggerState(workspaceId, triggerId, {
        state: "paused",
        pause_reason: "insufficient_credits",
        updated_at: this.now(),
      });
      this.deps.triggers.updateFiring(workspaceId, triggerId, occurrence.idempotencyKey, {
        outcome: "paused_credits",
      });
      this.appendTriggerStreamEvent(workspaceId, triggerId, "trigger.credit_paused", {
        workspace_id: workspaceId,
        trigger_id: triggerId,
        reason: "insufficient_credits",
      });
      return { outcome: "paused_credits" };
    }

    // Step 3: the D17 provider-gate consult (before the run exists).
    const config = JSON.parse(trigger.config_json) as Record<string, unknown>;
    const provider = config["provider"] as { provider_id: string; model: string } | undefined;
    if (this.deps.runGate !== undefined) {
      const custody =
        provider === undefined
          ? {
              ok: false as const,
              code: "PROVIDER_NOT_CONFIGURED",
              safe_message: "The trigger declares no provider pair.",
            }
          : this.deps.runGate.checkRunStart(workspaceId, provider.provider_id);
      if (!custody.ok) {
        this.deps.triggers.updateFiring(workspaceId, triggerId, occurrence.idempotencyKey, {
          outcome: "refused_provider",
          detail_json: JSON.stringify({ code: custody.code }),
        });
        this.appendTriggerStreamEvent(workspaceId, triggerId, "provider.configuration_refused", {
          provider_id: provider?.provider_id ?? null,
          code: custody.code,
        });
        return { outcome: "refused_provider", code: custody.code };
      }
    }

    // Step 4: the typed trigger event (the run stream's FIRST event — the
    // G2 origin) + the run row, with the parent linkage for completion and
    // condition triggers (AC6).
    const operationId = trigger.target_operation_id;
    const conversationId =
      this.deps.operations.findChat(workspaceId, operationId) ?? operationId;
    const eventType = triggerEventForKind(trigger, occurrence);
    const triggerEventId = `evt_trigger_${trigger.kind}_${createHash("sha256")
      .update(occurrence.idempotencyKey)
      .digest("hex")
      .slice(0, 32)}`;
    const parentTaskId = resolveParentTaskId(trigger, occurrence);
    try {
      this.deps.tx.transaction((exec) => {
        const sequence = this.deps.journal.nextSequence(
          taskStreamId(runId),
          workspaceId,
          exec,
        );
        const envelope: TypedExecutionEvent = {
          event_id: triggerEventId,
          stream_id: taskStreamId(runId),
          sequence,
          event_version: 1,
          actor: { type: "system", id: "scheduler" },
          task_id: runId,
          conversation_id: conversationId,
          occurred_at: this.now(),
          redaction_class: "internal",
          ...eventType,
        } as TypedExecutionEvent;
        this.deps.events.appendEvent({
          event_id: envelope.event_id,
          stream_id: envelope.stream_id,
          type: envelope.event_type,
          payload: envelope,
          workspace_id: workspaceId,
          correlation_id: triggerEventId,
        });
      });
      this.deps.ops.createRun(workspaceId, operationId, {
        run_id: runId,
        ...(parentTaskId !== null ? { parent_task_id: parentTaskId } : {}),
        ...(provider !== undefined ? { provider_snapshot: provider } : {}),
      });
    } catch (error) {
      this.deps.triggers.updateFiring(workspaceId, triggerId, occurrence.idempotencyKey, {
        outcome: "failed",
        detail_json: JSON.stringify({
          code: "RUN_CREATION_FAILED",
          name: error instanceof Error ? error.name : "Error",
        }),
      });
      this.faultLog("trigger_run_creation_failed", {
        workspace_id: workspaceId,
        trigger_id: triggerId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "failed", code: "RUN_CREATION_FAILED" };
    }

    // Step 5: the autonomous D8 walk through the shared applier.
    const walk = this.walkPlan(trigger, occurrence, runId, conversationId, config);
    if (!walk.ok) {
      this.deps.triggers.updateFiring(workspaceId, triggerId, occurrence.idempotencyKey, {
        outcome: "failed",
        run_id: runId,
        detail_json: JSON.stringify({ code: walk.code }),
      });
      this.updateBookkeepingAfterFiring(trigger, occurrence);
      return { outcome: "failed", code: walk.code };
    }

    // Step 6: settle the ledger + the trigger's truthful bookkeeping (AC9).
    this.deps.triggers.updateFiring(workspaceId, triggerId, occurrence.idempotencyKey, {
      outcome: "fired",
      run_id: runId,
      detail_json: JSON.stringify(occurrence.detail),
    });
    this.updateBookkeepingAfterFiring(trigger, occurrence);
    return { outcome: "fired", runId };
  }

  /**
   * Resume every credit-paused trigger in the workspace (the operator
   * top-up seam — the admin top-up flow calls this; recorded in E37). The
   * tick's own re-attempts are the automatic path.
   */
  resumeAfterTopUp(workspaceId: string): { resumed: string[] } {
    const resumed: string[] = [];
    for (const trigger of this.deps.triggers.listTriggers(workspaceId)) {
      if (trigger.state === "paused" && trigger.pause_reason === "insufficient_credits") {
        this.deps.triggers.updateTriggerState(workspaceId, trigger.trigger_id, {
          state: "active",
          pause_reason: null,
          updated_at: this.now(),
        });
        this.appendTriggerStreamEvent(workspaceId, trigger.trigger_id, "trigger.credit_resumed", {
          workspace_id: workspaceId,
          trigger_id: trigger.trigger_id,
        });
        resumed.push(trigger.trigger_id);
      }
    }
    return { resumed };
  }

  // ── The tick loop (the production convenience) ──────────────────────────────

  start(tickIntervalMs = DEFAULT_TICK_MS): void {
    if (this.cancelTick !== null) return;
    const schedule =
      this.deps.schedule ??
      ((delayMs: number, fn: () => void) => {
        const timer = setInterval(fn, delayMs);
        timer.unref?.();
        return () => clearInterval(timer);
      });
    this.tickTimer = () => {
      try {
        this.tick();
      } catch (error) {
        this.faultLog("scheduler_tick_failed", {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.cancelTick = schedule(tickIntervalMs, this.tickTimer);
  }

  stop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.tickTimer = null;
  }

  /**
   * One scheduler tick: fire every due schedule occurrence, then evaluate
   * the event-driven kinds (the watcher/condition/completion sources —
   * chunk 4 wires them through the same fireOccurrence pipeline).
   */
  tick(): void {
    const now = this.now();
    for (const trigger of this.deps.triggers.listTriggersByKind(this.deps.workspaceId, "schedule")) {
      if (trigger.state !== "active") continue;
      const config = JSON.parse(trigger.config_json) as { cron: string };
      const due = trigger.next_occurrence_at;
      if (due === null || Date.parse(due) > Date.parse(now)) continue;
      // Fire every due occurrence (bounded; the boot reconciliation owns the
      // long-downtime catch-up decision — a live tick is at most a few
      // occurrences behind).
      let occurrenceAt: string | null = due;
      let guard = 0;
      while (occurrenceAt !== null && Date.parse(occurrenceAt) <= Date.parse(now) && guard < 10) {
        const outcome = this.fireOccurrence(this.deps.workspaceId, trigger.trigger_id, {
          idempotencyKey: `schedule:${trigger.trigger_id}:${occurrenceAt}`,
          dueAt: occurrenceAt,
          detail: { due_at: occurrenceAt },
        });
        if (outcome.outcome === "paused_credits" || outcome.outcome === "failed") {
          break; // The pause/failure consumed this attempt; the tick re-evaluates.
        }
        occurrenceAt = nextOccurrence(config.cron, new Date(Date.parse(occurrenceAt) + 1))?.toISOString() ?? null;
        guard += 1;
      }
    }
    this.evaluateWatchers();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Chunk 6 wires the event-driven kinds (file/git/condition/completion). */
  protected evaluateWatchers(): void {
    // Overridden by the composed watcher evaluation.
  }

  private walkPlan(
    trigger: TriggerRecordRow,
    occurrence: TriggerOccurrence,
    runId: string,
    conversationId: string,
    config: Record<string, unknown>,
  ): { ok: true } | { ok: false; code: string } {
    const deps = this.lifecycleDeps();
    const step = (command: Parameters<typeof applyRowLifecycleTransition>[1]["command"]): boolean => {
      const applied = applyRowLifecycleTransition(deps, {
        workspaceId: trigger.workspace_id,
        runId,
        command,
        actor: { type: "runtime", id: "scheduler" },
      });
      return applied.ok;
    };
    if (!step("queue_task")) return { ok: false, code: "WALK_QUEUED_REJECTED" };
    if (!step("start_task")) return { ok: false, code: "WALK_STARTED_REJECTED" };
    const plan = (config["plan"] as TriggerPlan | undefined) ?? { prompt: "" };
    const runner = this.deps.planRunner ?? {
      runPlan: () => ({
        ok: true as const,
        result_summary: "The autonomous plan walked with no plan runner composed (G4: nothing was executed).",
      }),
    };
    const legs = runner.runPlan({
      workspace_id: trigger.workspace_id,
      operation_id: trigger.target_operation_id,
      conversation_id: conversationId,
      run_id: runId,
      plan,
    });
    if (!legs.ok) {
      // A failing plan fails the run through the SAME applier (the typed
      // failure code is the run stream's reason — the occurrence is
      // consumed either way; at-least-once, not unbounded retry).
      applyRowLifecycleTransition(deps, {
        workspaceId: trigger.workspace_id,
        runId,
        command: "fail_task",
        actor: { type: "runtime", id: "scheduler" },
      });
      return { ok: false, code: legs.code };
    }
    if (!step("complete_task")) return { ok: false, code: "WALK_COMPLETE_REJECTED" };
    return { ok: true };
  }

  private updateBookkeepingAfterFiring(
    trigger: TriggerRecordRow,
    occurrence: TriggerOccurrence,
  ): void {
    const now = this.now();
    let nextOccurrenceAt: string | null = trigger.next_occurrence_at;
    if (trigger.kind === "schedule") {
      const config = JSON.parse(trigger.config_json) as { cron: string };
      // The next occurrence is strictly after the one just fired (and after
      // now — a fake clock can lag the occurrence instant in tests).
      const afterMs = Math.max(Date.parse(now), Date.parse(occurrence.dueAt));
      nextOccurrenceAt = nextOccurrence(config.cron, new Date(afterMs))?.toISOString() ?? null;
    }
    this.deps.triggers.updateTriggerFields(trigger.workspace_id, trigger.trigger_id, {
      last_fired_at: now,
      last_occurrence_at: trigger.kind === "schedule" ? occurrence.dueAt : now,
      next_occurrence_at: nextOccurrenceAt,
      updated_at: now,
    });
  }

  /** The trigger stream's decision record (the scheduler's own vocabulary). */
  private appendTriggerStreamEvent(
    workspaceId: string,
    triggerId: string,
    type:
      | "trigger.credit_paused"
      | "trigger.credit_resumed"
      | "trigger.catchup_decided"
      | "provider.configuration_refused",
    payload: Record<string, unknown>,
  ): void {
    try {
      // The registry validates the payload at append (G2); the local cast
      // only bridges the per-type payload narrowing this helper does not
      // re-derive (the typed call sites above build each payload).
      const envelope = this.deps.events.appendEvent({
        event_id: `evt_${type.replaceAll(".", "_")}_${triggerId}_${randomUUID()}`,
        stream_id: `trigger:${triggerId}`,
        type,
        payload,
        workspace_id: workspaceId,
        correlation_id: triggerId,
      } as Parameters<EventsService["appendEvent"]>[0]);
      this.deps.publish?.(envelope);
    } catch (error) {
      // Contained: a decision record's failure never breaks the decision
      // itself (the row state is the contract; the event is the companion).
      this.faultLog("trigger_stream_event_failed", {
        workspace_id: workspaceId,
        trigger_id: triggerId,
        type,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break the scheduler.
    }
  }
}

/** The typed D34 trigger event for one firing, per kind (G2: typed data). */
function triggerEventForKind(
  trigger: TriggerRecordRow,
  occurrence: TriggerOccurrence,
): { event_type: string; payload: Record<string, unknown> } {
  const config = JSON.parse(trigger.config_json) as Record<string, unknown>;
  const dueAt = occurrence.detail["due_at"] ?? occurrence.dueAt;
  switch (trigger.kind) {
    case "schedule":
      return {
        event_type: "trigger.scheduled",
        payload: {
          schedule_id: trigger.trigger_id,
          ...(trigger.target_operation_id ? { operation_id: trigger.target_operation_id } : {}),
          due_at: typeof dueAt === "string" ? dueAt : occurrence.dueAt,
        },
      };
    case "webhook":
      return {
        event_type: "trigger.webhook",
        payload: {
          webhook_id: trigger.trigger_id,
          source: String(config["source"] ?? "unknown"),
          body_summary: String(occurrence.detail["body_summary"] ?? "delivery"),
        },
      };
    case "file_watch":
      return {
        event_type: "trigger.file_event",
        payload: {
          watcher_id: trigger.trigger_id,
          path_uri: String(config["path_uri"] ?? "workspace://unknown"),
          change_type: String(occurrence.detail["change_type"] ?? "modified") as
            | "created"
            | "modified"
            | "deleted",
        },
      };
    case "git_watch":
      return {
        event_type: "trigger.git_event",
        payload: {
          watcher_id: trigger.trigger_id,
          project_id: String(config["project_id"] ?? "unknown"),
          branch: String(config["branch"] ?? "main"),
          commit_sha: String(occurrence.detail["commit_sha"] ?? ""),
        },
      };
    case "task_completion":
      return {
        event_type: "trigger.task_completed",
        payload: {
          trigger_id: trigger.trigger_id,
          parent_task_id: String(occurrence.detail["parent_task_id"] ?? "unknown"),
          outcome: String(occurrence.detail["outcome"] ?? "succeeded") as
            | "succeeded"
            | "failed"
            | "cancelled",
          completed_at: String(occurrence.detail["completed_at"] ?? occurrence.dueAt),
        },
      };
    case "condition": {
      const parent = config["parent_task_id"];
      return {
        event_type: "trigger.condition_met",
        payload: {
          trigger_id: trigger.trigger_id,
          ...(typeof parent === "string" && parent.length > 0 ? { parent_task_id: parent } : {}),
          evaluated_at: String(occurrence.detail["evaluated_at"] ?? occurrence.dueAt),
        },
      };
    }
    case "external_event":
      return {
        event_type: "trigger.external_event",
        payload: {
          trigger_id: trigger.trigger_id,
          source: String(config["source"] ?? "unknown"),
          delivery_digest: String(occurrence.detail["delivery_digest"] ?? ""),
          occurred_at: String(occurrence.detail["occurred_at"] ?? occurrence.dueAt),
        },
      };
    default:
      return {
        event_type: "trigger.scheduled",
        payload: { schedule_id: trigger.trigger_id, due_at: occurrence.dueAt },
      };
  }
}

/** The AC6 parent linkage: task-completion triggers link the completed run;
 * condition triggers link their declared parent when one exists. */
function resolveParentTaskId(
  trigger: TriggerRecordRow,
  occurrence: TriggerOccurrence,
): string | null {
  if (trigger.kind === "task_completion") {
    const parent = occurrence.detail["parent_task_id"];
    return typeof parent === "string" && parent.length > 0 ? parent : null;
  }
  if (trigger.kind === "condition") {
    const config = JSON.parse(trigger.config_json) as Record<string, unknown>;
    const parent = config["parent_task_id"];
    return typeof parent === "string" && parent.length > 0 ? parent : null;
  }
  return null;
}
