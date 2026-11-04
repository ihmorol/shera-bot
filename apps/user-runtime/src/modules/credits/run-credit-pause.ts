/**
 * The D48 run-level credit pause (S24 chunk 1; D48, D20, E13, G5) — the ONE
 * writer the runtime uses when a run's reservation is refused. The pause
 * rides the SAME row-lifecycle applier and the SAME TASK_TRANSITIONS table
 * as every other D8 decision (the `pause_insufficient_credits` row: from
 * QUEUED or RUNNING into PAUSED, runtime actor, reason
 * `insufficient_credits`) — never a second state machine, never a QUEUED
 * capacity placement (the E1 resource queue is a different mechanism), and
 * never a silent stall: the typed `run.credit_paused` record journals the
 * refusal on the run's own stream (the user-visible notification the UI
 * renders), alongside the applier's audit record.
 *
 * The run resumes only after an administrator top-up (the recorded S32
 * `resume_task` path) or the user cancels (S22) — credits never authorize
 * anything else (D20).
 */
import type { RowLifecycleDeps } from "../tasks/run-lifecycle.ts";
import { applyRowLifecycleTransition } from "../tasks/run-lifecycle.ts";
import { taskStreamId } from "../tasks/task-events.ts";

export interface RunCreditPauseInput {
  workspaceId: string;
  runId: string;
  /** The estimate the account could not cover. */
  requestedUnits: number;
  /** The derived available balance at the refusal. */
  availableUnits: number;
}

export type RunCreditPauseResult = { ok: true; toState: "PAUSED" } | { ok: false; reason: string };

export function pauseRunForInsufficientCredits(
  deps: RowLifecycleDeps,
  input: RunCreditPauseInput,
): RunCreditPauseResult {
  const applied = applyRowLifecycleTransition(deps, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    command: "pause_insufficient_credits",
    actor: { type: "runtime", id: "credit-ledger" },
    audit: {
      decision: "pause",
      failureCode: "insufficient_credits",
      reason: "reservation_refused",
      attempt: null,
      delayMs: null,
    },
  });
  if (!applied.ok) {
    return { ok: false, reason: applied.reason };
  }

  // The typed notification record (bounded fields only — no provider
  // material, no secrets, G3). Contained: the pause IS the row state; the
  // record is its visible companion, so a record failure is fault-logged,
  // never rolled into silence and never allowed to un-pause anything.
  try {
    deps.events.appendEvent({
      event_id: `evt_run_credit_paused_${input.runId}_${applied.version}`,
      stream_id: taskStreamId(input.runId),
      type: "run.credit_paused",
      payload: {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        reason: "insufficient_credits",
        requested_units: input.requestedUnits,
        available_units: input.availableUnits,
      },
      workspace_id: input.workspaceId,
      correlation_id: `credit_pause_${input.runId}_v${applied.version}`,
    });
  } catch (error) {
    deps.logFault?.("run_credit_pause_record_failed", {
      workspace_id: input.workspaceId,
      run_id: input.runId,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ok: true, toState: "PAUSED" };
}
