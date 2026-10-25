/**
 * Task-run flow (S16 chunk 3) — the composed run boundary that wires run-state
 * transitions to the worker lifecycle. Chunk 1's supervisor deliberately spoke
 * only the injected TaskRunOperationsSeam; THIS module is the chunk-3 wiring
 * half: the composed OperationsService whose applyRunState ALSO drives the
 * TaskWorkerSupervisor.
 *
 * Transition policy (the D8 vocabulary — never a second state machine):
 *
 *  - RUNNING starts the run's worker (on demand, D32): the start is
 *    fire-and-forget — the transition MUST NOT wait on a spawn; the run's
 *    worker lifecycle is observable on the run stream (worker.started /
 *    worker.queued). A gate refusal leaves the run durably QUEUED (E1).
 *  - CANCELLING stops the worker through the chunk-1 escalation (shutdown
 *    frame → SIGTERM → SIGKILL). The terminal states (CANCELLED, FAILED,
 *    SUCCEEDED) stop it too, defensively: a run that reaches a terminal state
 *    by another path never leaves an orphaned worker behind. Stopping a run
 *    without a live worker is a typed no-op (idempotent).
 *  - Every OTHER state — including RECOVERY_REQUIRED (the recovery slice
 *    owns it) and PAUSED (the pause slice) — changes nothing here.
 *
 * The supervisor's OWN run-state writes (SUCCEEDED on done, RECOVERY_REQUIRED
 * on crash, QUEUED on refusal) go through the OperationsRunSeam holding the
 * SAME service instance — but they are hook-neutral states or no-op stops
 * (a done worker's record is already detached), so the flow never fights the
 * supervisor's lifecycle.
 *
 * Containment: the run-state write commits FIRST (super.applyRunState), and a
 * flow-hook failure is fault-logged — a supervision gap must never fail an
 * already-committed, D8-validated transition (the B4 post-commit discipline).
 *
 * Governing records: D32, D8, E1, D10; AC25.
 */
import {
  OperationsService,
  type OperationsServiceDeps,
} from "../operations/operations.service.ts";
import type { RunState } from "@shera-bot/contracts";

/** The states that START a run's worker (the run is actively executing). */
const WORKER_START_STATES: readonly RunState[] = ["RUNNING"];

/** The states that STOP the run's worker (cancellation, or a terminal state
 * reached by another path — defensively idempotent). */
const WORKER_STOP_STATES: readonly RunState[] = [
  "CANCELLING",
  "CANCELLED",
  "FAILED",
  "SUCCEEDED",
];

export function isWorkerStartState(state: RunState): boolean {
  return WORKER_START_STATES.includes(state);
}

export function isWorkerStopState(state: RunState): boolean {
  return WORKER_STOP_STATES.includes(state);
}

/** What the flow asks the supervisor to do, per transition. */
export interface TaskRunFlowHooks {
  startRunWorker(workspaceId: string, runId: string): void;
  stopRunWorker(workspaceId: string, runId: string, state: RunState): void;
  /** The contained fault sink (the composition's redacted logger). */
  logFault(event: string, fields: Record<string, unknown>): void;
}

/**
 * The composed OperationsService: every applyRunState write stays EXACTLY the
 * gateway-validated persistence write (super), and the committed transition
 * additionally drives the worker lifecycle through the late-bound hooks. The
 * hooks bind AFTER construction (the supervisor is built later in the same
 * wire()); until then transitions behave worker-free.
 */
export class RunFlowOperationsService extends OperationsService {
  /** Late-bound by the composition once the supervisor exists. */
  runFlow: TaskRunFlowHooks | null = null;

  constructor(deps: OperationsServiceDeps) {
    super(deps);
  }

  applyRunState(
    workspaceId: string,
    operationId: string,
    runId: string,
    state: string,
  ): ReturnType<OperationsService["applyRunState"]> {
    // The transition commits FIRST (the D8-validated write); the flow reacts
    // to the COMMITTED state, never speculatively.
    const run = super.applyRunState(workspaceId, operationId, runId, state);
    const flow = this.runFlow;
    if (flow === null) {
      return run;
    }
    try {
      if (isWorkerStartState(run.state)) {
        flow.startRunWorker(workspaceId, runId);
      } else if (isWorkerStopState(run.state)) {
        flow.stopRunWorker(workspaceId, runId, run.state);
      }
    } catch (error) {
      flow.logFault("task_run_flow_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        state: run.state,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return run;
  }
}
