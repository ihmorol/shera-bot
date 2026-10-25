/**
 * OperationsRunSeam (S16 chunk 3) — the REAL TaskRunOperationsSeam adapter
 * over the OperationsService, closing the interface-only seam chunk 1 left
 * open. The supervisor speaks (workspace, run); the operations domain speaks
 * (workspace, operation, run) — THIS adapter resolves the run's operation
 * from the run row (OperationsService.findRunOperation → the operations
 * repository's workspace-scoped run lookup, E12) and forwards every state
 * write through OperationsService.applyRunState, the D8-validated write the
 * runtime gateway owns. No second state machine, no direct SQL here.
 *
 * Unreachable runs answer honestly: runState → null (the supervisor treats
 * that as "unknown run"), applyRunState → the typed WORKER_NOT_FOUND refusal
 * (a cross-workspace run id is a different, unreachable row — E12 — and a
 * write against it must never silently succeed or silently no-op).
 *
 * Governing records: D8, D31, E12, D32; the chunk-1 seam contract.
 */
import type { RunState } from "@shera-bot/contracts";

import {
  TaskWorkerError,
  type TaskRunOperationsSeam,
} from "./task-worker-supervisor.service.ts";
import type { OperationsService } from "../operations/operations.service.ts";

export class OperationsRunSeam implements TaskRunOperationsSeam {
  constructor(private readonly operations: OperationsService) {}

  /** The run's current D8 state; null when the run is unknown in THIS workspace. */
  runState(workspaceId: string, runId: string): RunState | null {
    const operationId = this.operations.findRunOperation(workspaceId, runId);
    if (operationId === null) {
      return null;
    }
    return this.operations.getRun(workspaceId, operationId, runId).state;
  }

  /**
   * The authoritative run-state write through the gateway's validation path.
   * An unknown (or cross-workspace) run is a typed refusal — the run boundary
   * never invents a target to write against.
   */
  applyRunState(workspaceId: string, runId: string, state: RunState): void {
    const operationId = this.operations.findRunOperation(workspaceId, runId);
    if (operationId === null) {
      throw new TaskWorkerError(
        "WORKER_NOT_FOUND",
        `run ${runId} not found in workspace ${workspaceId}`,
      );
    }
    this.operations.applyRunState(workspaceId, operationId, runId, state);
  }
}
