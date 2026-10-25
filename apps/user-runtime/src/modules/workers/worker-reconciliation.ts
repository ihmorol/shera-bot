/**
 * Restart reconciliation for task workers (S16 chunk 3) — the boot-time pass
 * that closes the gap class the supervisor header names: the gateway died
 * while worker rows still said live. The task_workers rows are the DURABLE
 * truth about worker processes (D10); this pass reads them back after a
 * restart and reconciles them with observable reality.
 *
 * Semantics (the chunk-2 report's ask, deliberately narrow):
 *
 *  1. REAP: a live row (starting/running/stalled) whose pid is gone — the
 *     kill(pid, 0) probe; a row without a pid never got past spawn — is
 *     marked killed and a `worker.reaped` event is journaled on the run's
 *     stream (the aftermath-completion marker discipline: the row is terminal
 *     BEFORE the event is appended; a reaped event in the journal means the
 *     whole unit is done). EPERM on the probe means "exists, not ours" — a
 *     possibly-alive process is NEVER reaped. The probe is injectable so
 *     tests drive real dead pids.
 *  2. RE-QUEUE: runs the durable rows left in QUEUED (D8) re-enter the
 *     admission queue through supervisor.startWorker — the same gate, the
 *     same oldest-first dequeue a live refusal uses. A gate refusal queues
 *     the run durably again (report: queued: true); an admission starts a
 *     fresh worker (queued: false). A QUEUED run that still has a live row
 *     (someone's live work — conservative) is left alone.
 *  3. RECOVERY_REQUIRED runs stay AS-IS — the recovery policy (resume from
 *     the last safe checkpoint, or fail) is the recovery slice's decision,
 *     not reconciliation's; this pass only counts them.
 *
 * Runs in the other non-terminal states (RUNNING, PLANNED, RETRYING, …) whose
 * workers died with the gateway are NOT re-driven here: re-driving them is a
 * recovery-policy decision too. Their rows are reaped (row hygiene); the runs
 * themselves stay for the recovery slice.
 *
 * Every unit is contained: a failed row write or journal append is
 * fault-logged and the pass continues — a reconciliation gap is an honest
 * fault record, never a crashed boot.
 *
 * Governing records: D32, D10, D8, E1; the chunk-2 report's reconciliation ask.
 */
import { randomUUID } from "node:crypto";

import type { OperationRun } from "@shera-bot/contracts";

import type {
  TaskWorkerState,
  TaskWorkersRepository,
} from "../../adapters/sqlite/task-workers-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskWorkerSupervisor } from "./task-worker-supervisor.service.ts";

/** What the boot reconciliation did — the operator- and test-visible report. */
export interface WorkerReconciliationReport {
  /** Live rows whose pid was proven gone: row killed + worker.reaped event. */
  reaped: Array<{
    workspace_id: string;
    run_id: string;
    worker_id: string;
    pid: number | null;
    previous_state: TaskWorkerState;
  }>;
  /** Live rows whose pid answered the probe — possibly-alive, left alone. */
  kept: number;
  /** QUEUED runs re-entered through the supervisor (queued = gate refused). */
  requeued: Array<{ workspace_id: string; run_id: string; queued: boolean }>;
  /** RECOVERY_REQUIRED runs left for the recovery slice (count only). */
  leftForRecovery: number;
}

export interface WorkerReconciliationDeps {
  taskWorkers: TaskWorkersRepository;
  /** The ONLY journal seam (no second journal) — worker.reaped appends here. */
  events: EventsService;
  /** The run-row reads: the QUEUED scan and the per-run existence checks. */
  runs: Pick<OperationsRepository, "findRunOperation" | "getRun" | "listRunsByState">;
  /**
   * The supervisor QUEUED runs re-enter through. Null = no worker system is
   * configured (G4): rows are still reaped, but nothing re-drives runs.
   */
  supervisor: Pick<TaskWorkerSupervisor, "startWorker"> | null;
  /** Injected pid probe (tests drive real dead pids). Default: kill(pid, 0). */
  isPidAlive?: ((pid: number) => boolean) | undefined;
  /** Contained operator-fault sink. Default: discard. */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

/**
 * The default pid probe: kill(pid, 0) answers existence. EPERM means the
 * process exists but belongs to another user — a possibly-alive process is
 * never reaped, so EPERM counts as alive (fail-safe direction).
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The worker spec a re-driven run carries: the run row's provider snapshot. */
function specFromRun(run: OperationRun): { providerSnapshot: { provider_id: string; model: string } } | undefined {
  if (run.provider_snapshot === undefined) {
    return undefined;
  }
  return {
    providerSnapshot: {
      provider_id: run.provider_snapshot.provider_id,
      model: run.provider_snapshot.model,
    },
  };
}

export async function reconcileTaskWorkersAfterRestart(
  deps: WorkerReconciliationDeps,
): Promise<WorkerReconciliationReport> {
  const logFault = (event: string, fields: Record<string, unknown>): void => {
    try {
      deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break reconciliation.
    }
  };
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const report: WorkerReconciliationReport = {
    reaped: [],
    kept: 0,
    requeued: [],
    leftForRecovery: 0,
  };

  // ── 1. Reap live rows whose process is gone ───────────────────────────────
  for (const row of deps.taskWorkers.listLiveAll()) {
    const dead = row.pid === null || !isPidAlive(row.pid);
    if (!dead) {
      report.kept += 1;
      continue;
    }
    try {
      // Row first, then the event: the journal entry is the aftermath-
      // COMPLETION marker (the same discipline as worker.crashed) — when it
      // is visible, the row is already terminal.
      deps.taskWorkers.updateState(row.workspace_id, row.run_id, row.worker_id, "killed");
      // listLiveAll's query only returns the live states; the narrow type is
      // backed by that WHERE clause.
      const previousState = row.state as "starting" | "running" | "stalled";
      deps.events.appendEvent({
        event_id: randomUUID(),
        stream_id: row.run_id,
        type: "worker.reaped",
        payload: {
          worker_id: row.worker_id,
          workspace_id: row.workspace_id,
          run_id: row.run_id,
          pid: row.pid,
          previous_state: previousState,
          cause: "gateway_restart",
        },
        workspace_id: row.workspace_id,
        correlation_id: `task-worker-reconcile:${row.workspace_id}:${row.run_id}`,
      });
      report.reaped.push({
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        worker_id: row.worker_id,
        pid: row.pid,
        previous_state: previousState,
      });
    } catch (error) {
      logFault("task_worker_reconcile_reap_failed", {
        workspace_id: row.workspace_id,
        run_id: row.run_id,
        worker_id: row.worker_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 2. Re-drive QUEUED runs through the admission queue ───────────────────
  for (const run of deps.runs.listRunsByState("QUEUED")) {
    // A QUEUED run that still has a live worker row is someone's live work
    // (a direct start won the race) — never double-start it.
    const liveRow = deps.taskWorkers
      .listLive(run.workspace_id)
      .some((row) => row.run_id === run.run_id);
    if (liveRow) {
      continue;
    }
    if (deps.supervisor === null) {
      continue; // no worker system (G4): nothing re-drives runs
    }
    try {
      const result = await deps.supervisor.startWorker(
        run.workspace_id,
        run.run_id,
        specFromRun(run),
      );
      report.requeued.push({
        workspace_id: run.workspace_id,
        run_id: run.run_id,
        queued: result.state === "queued",
      });
    } catch (error) {
      logFault("task_worker_reconcile_requeue_failed", {
        workspace_id: run.workspace_id,
        run_id: run.run_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── 3. Count the runs the recovery slice owns ─────────────────────────────
  report.leftForRecovery = deps.runs.listRunsByState("RECOVERY_REQUIRED").length;
  return report;
}
