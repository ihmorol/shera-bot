/**
 * RecoveryDriver (S31 chunk 2; PRD §13, D32, D33, E13, D8, G2) — the
 * runtime-owned decision layer for INTERRUPTED runs, the "recovery slice"
 * the S16 boot reconciliation explicitly leaves runs for: after a gateway
 * restart, runs the worker rows can no longer vouch for are decided HERE,
 * from recorded data, never from a guess.
 *
 * The decision input is the latest semantic checkpoint's pending action and
 * its DECLARED E13 recovery class (data on the record — the S31 chunk-1
 * writer stored it; the S22 retry policy consumed the same vocabulary at the
 * failure layer). The pure policy (decideRecovery) is fail-closed in every
 * direction E13 demands:
 *
 *  - `replayable`            → auto-resume; the effect re-executes from the
 *                              checkpoint (safe by declaration, even doubled).
 *  - `idempotent_retry`      → auto-resume ONLY with the recorded
 *                              idempotency key — the re-execution collapses
 *                              under the same key (no key = unprovable
 *                              dedupe = pause).
 *  - `needs_human`, an undeclared class, no pending action, or no checkpoint
 *                            → RECOVERY_REQUIRED (E13: a tool that declares
 *                              nothing is needs_human); the ambiguous effect
 *                              is NEVER replayed by the runtime.
 *
 * The resume walks the ONE D8 machinery (applyRowLifecycleTransition — never
 * a second state machine): an interrupted RECOVERY_REQUIRED run takes the
 * runtime-actor `recovery_auto_resume` transition (the row the 2026-09-19
 * review note reserved for this layer, guarded by the checkpoint's recorded
 * class — the authorization data lives in the CheckpointService's record,
 * not here); an interrupted RUNNING run re-drives directly (already RUNNING —
 * the state the worker works under). Every decision journals a
 * `recovery.decided` marker on the run's task stream — the run timeline's
 * resume marker and the honest "resumed from last safe step" basis (the
 * checkpoint version), never an exact-resume claim.
 *
 * The resume port is the re-drive seam (composed to the worker supervisor's
 * startWorker — the same seam the S16 reconciliation re-queues QUEUED runs
 * through). The driver runs AFTER boot reconciliation (the reaper owns the
 * worker rows first); each pass visits every recovery-owned run exactly once.
 *
 * Governing records: PRD §13, D8, D32, D33, E13, D23 rule 5; G2/G3.
 */
import type { RunState } from "@shera-bot/contracts";

import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import type { RecoveryDecidedPayload } from "../events/events.types.ts";
import type {
  TaskRunOperationsSeam,
  TaskWorkerSpec,
} from "../workers/task-worker-supervisor.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { applyRowLifecycleTransition, type RowLifecycleDeps } from "../tasks/run-lifecycle.ts";

/** The pending-action shape the checkpoint writer records (the E13 fields). */
export interface RecoveryPendingAction {
  kind?: unknown;
  summary?: unknown;
  tool_id?: unknown;
  /** The DECLARED E13 class — its absence is needs_human (fail-closed). */
  recovery_class?: unknown;
  /** The recorded idempotency token an idempotent_retry re-drive rides. */
  idempotency_key?: unknown;
  /**
   * The tool's RUNTIME-VERIFIED D9 risk class (recorded by the writer from
   * the resolved definition — never the tool's own claim). The cap reads it;
   * its absence is fail-closed (see decideRecovery).
   */
  risk_class?: unknown;
}

export type RecoveryDecision =
  | { action: "resume"; basis: "replayable"; idempotencyKey: null }
  | { action: "resume"; basis: "idempotent_retry"; idempotencyKey: string }
  | {
      action: "pause_for_review";
      reason: "recovery_class_needs_human" | "no_idempotency_key" | "risk_class_caps_recovery";
    };

/**
 * The pure E13 class decision, CAPPED by the tool's runtime-verified risk
 * class (the same purity discipline as the S22 retry policy: never throws,
 * never reads a clock, never mutates inputs). Every input the record does not
 * explicitly vouch for pauses — the runtime never guesses an effect safe to
 * replay.
 *
 * THE TRUST BOUNDARY (G6 — agents never self-approve, applied to recovery):
 * tools-inventory stores an agent-DECLARED recovery class verbatim, so the
 * declared class alone can never authorize a re-execution. Effective class =
 * the declared class ONLY when the record's risk_class is READ_ONLY; for
 * every other risk class (or a missing one — the record must PROVE
 * read-only) the effective class is needs_human regardless of declaration.
 * A malicious WRITE tool declaring `replayable` therefore pauses
 * RECOVERY_REQUIRED at every restart instead of blind-re-executing; only a
 * runtime-verified READ_ONLY tool's declaration may auto-resume, and a
 * non-read-only declaration awaits a recorded owner decision.
 */
export function decideRecovery(
  pending: RecoveryPendingAction | null | undefined,
): RecoveryDecision {
  const declared = pending?.recovery_class;
  if (declared === "replayable" || declared === "idempotent_retry") {
    if (pending?.risk_class !== "READ_ONLY") {
      return { action: "pause_for_review", reason: "risk_class_caps_recovery" };
    }
    if (declared === "replayable") {
      return { action: "resume", basis: "replayable", idempotencyKey: null };
    }
    const key = pending?.idempotency_key;
    if (typeof key === "string" && key.length >= 1 && key.length <= 200) {
      return { action: "resume", basis: "idempotent_retry", idempotencyKey: key };
    }
    return { action: "pause_for_review", reason: "no_idempotency_key" };
  }
  // needs_human, an undeclared class, or no pending action at all.
  return { action: "pause_for_review", reason: "recovery_class_needs_human" };
}

/**
 * The re-drive's worker spec (P2 threading): the recorded idempotency key
 * rides the worker configuration so the re-execution lands under the SAME
 * key the original consumed (the collapse's whole mechanism). An unkeyed
 * replayable re-drive carries no config.
 */
export function recoveryRedriveSpec(idempotencyKey: string | null): TaskWorkerSpec {
  return idempotencyKey === null ? {} : { config: { recovery_idempotency_key: idempotencyKey } };
}

/** What the driver decided for one run (the per-run surface and the scan row). */
export type RecoveryOutcome =
  | { outcome: "resumed"; basis: "replayable" | "idempotent_retry"; state: RunState }
  | { outcome: "paused_for_review"; reason: string; state: RunState }
  | { outcome: "resume_failed"; reason: string; state: RunState }
  | { outcome: "skipped"; reason: string; state: RunState | null };

export interface RecoveryScanReport {
  /** One decision per visited run (each recovery-owned run exactly once). */
  visited: Array<{ workspaceId: string; runId: string; outcome: RecoveryOutcome }>;
}

/** The checkpoint data the decision reads (composed from the chunk-1 rows). */
export interface LatestRecoveryBasis {
  pendingAction: RecoveryPendingAction | null;
  checkpointVersion: number;
}

export interface RecoveryDriverDeps {
  tx: SqliteTransactions;
  /** The ONLY journal seam (no second journal). */
  journal: Pick<EventJournalRepository, "nextSequence" | "readFrom" | "findById">;
  events: Pick<EventsService, "appendEvent">;
  /** The run-row reads (operation resolution, chat binding) — SQL only. */
  operations: Pick<OperationsRepository, "findRunOperation" | "findChat">;
  /** The run boundary (state reads + authoritative writes). */
  runControl: TaskRunOperationsSeam;
  /** The recovery-owned run scan (the boot pass over RUNNING + RECOVERY_REQUIRED). */
  runs: Pick<OperationsRepository, "listRunsByState">;
  /**
   * Whether a LIVE worker row still stands on this run (the S16 reaper keeps
   * live rows). A run with live work is NOT interrupted — the conservative
   * rule the S16 re-queue uses applies verbatim: never re-drive someone's
   * live worker.
   */
  hasLiveWorker: (workspaceId: string, runId: string) => boolean;
  /**
   * The latest checkpoint's recovery basis for one task (composed to the
   * RunCheckpointsRepository). Null = no checkpoint exists — nothing vouches
   * for a resume.
   */
  latestRecoveryBasis: (workspaceId: string, taskId: string) => LatestRecoveryBasis | null;
  /**
   * The re-drive seam: hand the run back to its worker (composed to the
   * supervisor's startWorker). The re-executed pending action rides the
   * recorded idempotency key when one exists (the class's whole point).
   */
  resume: (input: {
    workspaceId: string;
    runId: string;
    basis: "replayable" | "idempotent_retry";
    idempotencyKey: string | null;
    resumeFromCheckpointVersion: number | null;
  }) => void | Promise<void>;
  /** Injectable ISO clock; default wall clock. */
  now?: (() => string) | undefined;
  /** Post-commit live fanout (the WS gateway); optional. */
  publish?: ((event: EventEnvelope) => void) | undefined;
  /** Contained operator-fault sink; default discard. */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export class RecoveryDriver {
  /** The most recent full pass's report (the composed status surface reads it). */
  private lastScanReport: RecoveryScanReport | null = null;

  constructor(private readonly deps: RecoveryDriverDeps) {}

  /** The last boot scan's report; null before the first pass. */
  lastReport(): RecoveryScanReport | null {
    return this.lastScanReport;
  }

  private lifecycleDeps(): RowLifecycleDeps {
    return {
      tx: this.deps.tx,
      journal: this.deps.journal,
      events: this.deps.events,
      operations: this.deps.operations,
      runControl: this.deps.runControl,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.publish ? { publish: this.deps.publish } : {}),
      ...(this.deps.logFault ? { logFault: this.deps.logFault } : {}),
    };
  }

  /**
   * One interrupted run's recovery decision. The run must be in a state the
   * recovery slice owns (RUNNING interrupted after the boot reaper, or
   * RECOVERY_REQUIRED); everything else is a typed skip (QUEUED is the S16
   * reconciliation's re-drive, RETRYING is the S22 coordinator's clock,
   * PAUSED is a human/credits decision, terminals are closed).
   */
  async recoverRun(workspaceId: string, runId: string): Promise<RecoveryOutcome> {
    const operationId = this.deps.operations.findRunOperation(workspaceId, runId);
    if (operationId === null) {
      return { outcome: "skipped", reason: "run_not_found", state: null };
    }
    const currentState = this.deps.runControl.runState(workspaceId, runId);
    if (currentState === null) {
      return { outcome: "skipped", reason: "run_not_found", state: null };
    }
    if (currentState !== "RUNNING" && currentState !== "RECOVERY_REQUIRED") {
      return {
        outcome: "skipped",
        reason: `run is ${currentState}, not recovery-owned`,
        state: currentState,
      };
    }
    if (this.deps.hasLiveWorker(workspaceId, runId)) {
      // Live work stands on this run — the reaper kept its row; nothing is
      // interrupted here (the S16 conservative rule, verbatim).
      return {
        outcome: "skipped",
        reason: "a live worker row is on this run",
        state: currentState,
      };
    }

    const basis = this.deps.latestRecoveryBasis(workspaceId, runId);
    const decision = decideRecovery(basis?.pendingAction ?? null);

    if (decision.action === "pause_for_review") {
      // An interrupted RUNNING run walks RUNNING → RECOVERY_REQUIRED (the
      // D8 row, runtime actor). A run already RECOVERY_REQUIRED stays — the
      // pause is already on the record; the driver adds nothing.
      if (currentState === "RUNNING") {
        const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
          workspaceId,
          runId,
          command: "recovery_required",
          actor: { type: "runtime", id: "runtime-gateway" },
        });
        if (!applied.ok) {
          return { outcome: "skipped", reason: applied.reason, state: currentState };
        }
        this.appendDecided(workspaceId, runId, {
          workspace_id: workspaceId,
          run_id: runId,
          basis: null,
          reason: decision.reason,
          idempotency_key: null,
          resume_from_checkpoint_version: basis?.checkpointVersion ?? null,
          replayed: false,
        });
        return {
          outcome: "paused_for_review",
          reason: decision.reason,
          state: "RECOVERY_REQUIRED",
        };
      }
      return {
        outcome: "paused_for_review",
        reason: decision.reason,
        state: currentState,
      };
    }

    // Resume leg. A RECOVERY_REQUIRED run first walks the runtime-actor
    // auto-resume (guarded by the recorded class — see the transition row);
    // the guard rejection means someone else moved the run meanwhile — a
    // typed skip, never a force.
    if (currentState === "RECOVERY_REQUIRED") {
      const applied = applyRowLifecycleTransition(this.lifecycleDeps(), {
        workspaceId,
        runId,
        command: "recovery_auto_resume",
        actor: { type: "runtime", id: "runtime-gateway" },
      });
      if (!applied.ok) {
        return { outcome: "skipped", reason: applied.reason, state: currentState };
      }
    }

    const checkpointVersion = basis?.checkpointVersion ?? null;
    try {
      await this.deps.resume({
        workspaceId,
        runId,
        basis: decision.basis,
        idempotencyKey: decision.idempotencyKey,
        resumeFromCheckpointVersion: checkpointVersion,
      });
    } catch (error) {
      // Contained: the re-drive failed after the (legal) transition. The run
      // reads RUNNING with no worker — exactly the interrupted state — and
      // the next boot's reconciliation + driver own it again. The marker
      // records the honest no-replay outcome (B4), and the OUTCOME says
      // resume_failed — the run did NOT get its re-drive.
      this.faultLog("recovery_resume_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        basis: decision.basis,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      this.appendDecided(workspaceId, runId, {
        workspace_id: workspaceId,
        run_id: runId,
        basis: decision.basis,
        reason: "recovery_class_permits",
        idempotency_key: decision.idempotencyKey,
        resume_from_checkpoint_version: checkpointVersion,
        replayed: false,
      });
      return { outcome: "resume_failed", reason: "resume_port_failed", state: "RUNNING" };
    }

    this.appendDecided(workspaceId, runId, {
      workspace_id: workspaceId,
      run_id: runId,
      basis: decision.basis,
      reason: "recovery_class_permits",
      idempotency_key: decision.idempotencyKey,
      resume_from_checkpoint_version: checkpointVersion,
      replayed: true,
    });
    return { outcome: "resumed", basis: decision.basis, state: "RUNNING" };
  }

  /**
   * One boot pass over every recovery-owned run (RUNNING interrupted +
   * RECOVERY_REQUIRED), each visited exactly once. Runs AFTER the S16
   * worker reconciliation (the reaper closes the worker-row truth first).
   */
  async recoverInterruptedRuns(): Promise<RecoveryScanReport> {
    const seen = new Set<string>();
    const visited: RecoveryScanReport["visited"] = [];
    for (const state of ["RUNNING", "RECOVERY_REQUIRED"] as const) {
      for (const run of this.deps.runs.listRunsByState(state)) {
        const key = `${run.workspace_id}:${run.run_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const outcome = await this.recoverRun(run.workspace_id, run.run_id);
        visited.push({ workspaceId: run.workspace_id, runId: run.run_id, outcome });
      }
    }
    this.lastScanReport = { visited };
    return { visited };
  }

  /**
   * The journal marker (the run timeline's resume/pause record). ONE append,
   * deterministic event id (`evt_recovery_decided_<run>_<n>` — a replayed
   * pass deduplicates at the journal, the winner's row is the contract, D23
   * rule 6); contained — a failed marker is a fault record, never a crashed
   * driver.
   */
  private appendDecided(workspaceId: string, runId: string, payload: RecoveryDecidedPayload): void {
    try {
      const priorCount = this.deps.journal
        .readFrom(workspaceId, taskStreamId(runId), 0, 10_000)
        .filter((row) => row.event_type === "recovery.decided").length;
      this.deps.events.appendEvent({
        event_id: `evt_recovery_decided_${runId}_v${priorCount + 1}`,
        stream_id: taskStreamId(runId),
        type: "recovery.decided",
        payload,
        workspace_id: workspaceId,
        correlation_id: `recovery:${runId}`,
      });
    } catch (error) {
      this.faultLog("recovery_decided_append_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break the driver.
    }
  }
}
