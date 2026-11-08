/**
 * Runtime admin commands (S32, issue #33; D47, PRD §15) — the container-side
 * of the admin capabilities that must reach RUNTIME state. They ride the
 * RECORDED internal channel (the S06 authenticated per-container bearer
 * channel): the control plane's admin API calls them, this handle executes
 * them against the runtime's own machinery — never a second channel, never a
 * parallel cancellation or transition path.
 *
 * - cancelAllRuns: the emergency cancel-all for ONE user. It walks the
 *   workspace's runs and drives EACH through the S22 RunCancellationService
 *   (the recorded D8 two-step + full teardown: workers, executor work,
 *   children, leases, reservation seam, approvals). The service classifies
 *   every outcome; terminal runs are typed no-ops (their outcome is theirs
 *   to keep). The actor is the admin identity the control plane attributes.
 * - applyCreditTopUp: the D48 unblocking path (issue #33 AC9). The control
 *   plane owns the durable grant record; the runtime applies the RESUME:
 *   every run PAUSED with reason `insufficient_credits` re-enters the queue
 *   through the recorded D8 `resume_task` row (PAUSED → QUEUED, admin
 *   actor). Runs paused for OTHER reasons are skipped with a typed reason —
 *   retry exhaustion is not a credit pause (E35's bound is not forgivable by
 *   a top-up). The S24 credit ledger is NOT built yet: this is the honest
 *   seam shape — a real central grant record + the real recorded resume
 *   path, never a fake balance (G4; pinned in E38).
 * - listTaskFailures: the task-failure read for the admin failures view
 *   (chunk 7).
 *
 * Every method is tenant-scoped by construction: the caller passes the
 * workspace, and the internal API route verifies it against THIS runtime's
 * account binding before reaching the handle.
 */
import {
  RuntimeAdminTaskFailureRecord,
  type OperationRun,
  type RuntimeAdminBackupRestoreResponse,
  type RuntimeAdminBackupTakeResponse,
} from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
import type { TakeSnapshotResult } from "../backups/backup-service.ts";
import type { RestoreService } from "../backups/restore-service.ts";
import {
  applyRowLifecycleTransition,
  type RowLifecycleAudit,
  type RowLifecycleDeps,
} from "../tasks/run-lifecycle.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import type { RunCancellationService } from "../tasks/run-cancellation.service.ts";

export interface RuntimeAdminCancelAllResult {
  workspace_id: string;
  results: Array<{ run_id: string; outcome: string }>;
}

export interface RuntimeAdminTopUpResult {
  workspace_id: string;
  topup_id: string;
  /** Review F2: TRUE when this topupId's grant was ALREADY applied (the
   * replayed command is the recorded no-op — one grant movement stands). */
  grant_deduplicated: boolean;
  resumed_run_ids: string[];
  skipped: Array<{
    run_id: string;
    reason: "pause_reason_not_insufficient_credits" | "resume_refused";
  }>;
}

export interface RuntimeAdminCommandsHandle {
  cancelAllRuns(input: {
    workspaceId: string;
    actor: { type: "admin"; id: string };
  }): Promise<RuntimeAdminCancelAllResult>;
  applyCreditTopUp(input: {
    workspaceId: string;
    topupId: string;
    amount: number;
    reason?: string | undefined;
    actor: { type: "admin"; id: string };
  }): Promise<RuntimeAdminTopUpResult>;
  listTaskFailures(input: {
    workspaceId: string;
    limit: number;
  }): Promise<{ workspace_id: string; failures: RuntimeAdminTaskFailureRecord[] }>;
  /** S33 (issue #34, D47): the admin-triggered snapshot — the control
   * plane's 1:1 ref IS the snapshot id (a replayed trigger is the typed
   * conflict, never a second snapshot). The mechanism's own typed result,
   * never a fabricated success (G4). */
  takeBackup(input: {
    workspaceId: string;
    snapshotRef: string;
    actor: { type: "admin"; id: string };
  }): Promise<RuntimeAdminBackupTakeResponse>;
  /** S33: the admin-triggered restore — the recorded walk through the
   * composition's stop/start ports. When the composition wires no ports
   * (the prototype default: the container-level stop is the OPERATOR
   * runbook's step), the typed RESTORE_PORTS_NOT_WIRED refusal is the
   * honest answer — never a fake restore. */
  restoreBackup(input: {
    workspaceId: string;
    snapshotId: string;
    actor: { type: "admin"; id: string };
  }): Promise<RuntimeAdminBackupRestoreResponse>;
}

export interface RuntimeAdminCommandsDeps {
  /** The workspace's runs (all states). */
  listWorkspaceRuns: (workspaceId: string) => OperationRun[];
  /** The S22 cancellation machinery — the ONLY cancel path; it classifies
   * every outcome (cancelled / already_cancelled / already_settled) itself. */
  runCancellation: Pick<RunCancellationService, "cancelRun">;
  /** The lifecycle applier's seams (the D48 resume walks the same machinery). */
  tx: SqliteTransactions;
  journal: Pick<EventJournalRepository, "findById" | "nextSequence" | "readFrom">;
  events: Pick<EventsService, "appendEvent">;
  runControl: TaskRunOperationsSeam;
  findRunOperation: (workspaceId: string, runId: string) => string | null;
  findChat: (workspaceId: string, operationId: string) => string | null;
  /**
   * S24 (AC2): the ledger grant the top-up APPLIES — the central
   * `control_credit_topups` row stays the authority; this is the
   * runtime-local movement (credit_transaction 'grant', related_id =
   * the central topup id). Applied BEFORE any resume, so the re-drive's
   * reservation consults a funded account. Idempotent on the topup id
   * (review F2): the answered `deduplicated` flag is the recorded no-op
   * the result carries.
   */
  applyGrant?:
    | ((workspaceId: string, topupId: string, amount: number) => { deduplicated: boolean })
    | undefined;
  /**
   * S24 (AC2): the re-drive for one resumed run — the composed scheduler's
   * resumeRunAfterTopUp (the run walks its plan legs from QUEUED with the
   * funded account). Awaited per resumed run.
   */
  resumeRun?: ((workspaceId: string, runId: string) => Promise<void>) | undefined;
  /**
   * S24: the workspace-level seam fired after the per-run walk — the
   * composed scheduler's resumeAfterTopUp (credit-paused TRIGGERS re-arm).
   */
  afterTopUp?: ((workspaceId: string) => void) | undefined;
  /**
   * S33 (issue #34, D47): the composed BackupService's takeSnapshot, bound
   * to THIS workspace (the composition's own). Absent: the typed refusal.
   */
  backupTake?:
    | ((input: { triggeredBy: "admin"; snapshotRef: string }) => Promise<TakeSnapshotResult>)
    | undefined;
  /**
   * S33: the composed RestoreService (the container-level stop/start ports
   * are the deployment's to supply). Absent: the typed RESTORE_PORTS_NOT_WIRED
   * refusal — the operator runbook is the recorded handoff, never a silent
   * no-op (G4).
   */
  restorePorts?: (Pick<RestoreService, "restoreSnapshot"> & { workspaceId: string }) | undefined;
  now?: (() => string) | undefined;
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export function buildRuntimeAdminCommandsHandle(
  deps: RuntimeAdminCommandsDeps,
): RuntimeAdminCommandsHandle {
  const lifecycleDeps = (): RowLifecycleDeps => ({
    tx: deps.tx,
    journal: deps.journal,
    events: deps.events,
    operations: {
      findRunOperation: deps.findRunOperation,
      findChat: deps.findChat,
    },
    runControl: deps.runControl,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.logFault ? { logFault: deps.logFault } : {}),
  });

  return {
    async cancelAllRuns(input) {
      const runs = deps.listWorkspaceRuns(input.workspaceId);
      const results: Array<{ run_id: string; outcome: string }> = [];
      for (const run of runs) {
        // One decision point: the S22 service classifies every outcome
        // (including the typed no-ops on terminal runs) — this handle never
        // re-derives cancellation semantics.
        const outcome = await deps.runCancellation.cancelRun({
          workspaceId: input.workspaceId,
          runId: run.run_id,
          actor: input.actor,
        });
        results.push({ run_id: run.run_id, outcome: outcome.outcome });
      }
      return { workspace_id: input.workspaceId, results };
    },

    async applyCreditTopUp(input) {
      // S24 (AC2): the GRANT lands first — the re-drive below consults a
      // funded account. Contained: a grant failure aborts the top-up with
      // the typed error (nothing resumed on an unapplied grant). The replay
      // is NOT a failure (review F2): a deduplicated application is the
      // recorded no-op the result reports.
      // No initializer: the catch rethrows, so the flag is definitely
      // assigned by the try's only assignment whenever control reaches the
      // result below (the lint no-useless-assignment pin).
      let grantDeduplicated: boolean;
      try {
        const applied = deps.applyGrant?.(input.workspaceId, input.topupId, input.amount);
        grantDeduplicated = applied?.deduplicated ?? false;
      } catch (error) {
        deps.logFault?.("admin_topup_grant_failed", {
          workspace_id: input.workspaceId,
          topup_id: input.topupId,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const runs = deps.listWorkspaceRuns(input.workspaceId);
      const resumedRunIds: string[] = [];
      const skipped: RuntimeAdminTopUpResult["skipped"] = [];
      for (const run of runs) {
        if (run.state !== "PAUSED") continue;
        const reason = latestPauseReason(deps.journal, input.workspaceId, run.run_id);
        if (reason !== "insufficient_credits") {
          skipped.push({ run_id: run.run_id, reason: "pause_reason_not_insufficient_credits" });
          continue;
        }
        const resumeAudit: RowLifecycleAudit = {
          decision: "pause",
          failureCode: "insufficient_credits",
          reason: `resumed_by_admin_topup:${input.topupId}`,
          attempt: null,
          delayMs: null,
        };
        const applied = applyRowLifecycleTransition(lifecycleDeps(), {
          workspaceId: input.workspaceId,
          runId: run.run_id,
          command: "resume_task",
          actor: input.actor,
          audit: resumeAudit,
        });
        if (applied.ok) {
          resumedRunIds.push(run.run_id);
          // S24 (AC2): the resumed run RE-DRIVES to completion (the composed
          // scheduler re-walks its plan legs from QUEUED). Awaited per run —
          // the walk's own outcomes are already recorded by the scheduler.
          try {
            await deps.resumeRun?.(input.workspaceId, run.run_id);
          } catch (error) {
            deps.logFault?.("admin_topup_redrive_failed", {
              run_id: run.run_id,
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          // A lost race (the run settled/resumed concurrently) is contained:
          // the run's own state is the truth, the grant stays recorded.
          skipped.push({ run_id: run.run_id, reason: "resume_refused" });
          deps.logFault?.("admin_topup_resume_refused", {
            run_id: run.run_id,
            reason: applied.reason,
          });
        }
      }
      // The workspace-level seam: credit-paused TRIGGERS re-arm (S28's
      // resumeAfterTopUp — the next occurrence fires through the same route
      // family).
      try {
        deps.afterTopUp?.(input.workspaceId);
      } catch (error) {
        deps.logFault?.("admin_topup_after_failed", {
          workspace_id: input.workspaceId,
          name: error instanceof Error ? error.name : "Error",
        });
      }
      return {
        workspace_id: input.workspaceId,
        topup_id: input.topupId,
        grant_deduplicated: grantDeduplicated,
        resumed_run_ids: resumedRunIds,
        skipped,
      };
    },

    async listTaskFailures(input) {
      const runs = deps.listWorkspaceRuns(input.workspaceId);
      const failing = runs
        .filter((run) => run.state === "FAILED" || run.state === "RECOVERY_REQUIRED")
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, input.limit);
      const failures: RuntimeAdminTaskFailureRecord[] = [];
      for (const run of failing) {
        const events = deps.journal.readFrom(
          input.workspaceId,
          taskStreamId(run.run_id),
          0,
          10_000,
        );
        const failureEvents = events
          .filter((row) => FAILURE_EVENT_TYPES.has(row.event_type))
          .map((row) => {
            let reason: string | null = null;
            try {
              const envelope = JSON.parse(row.payload) as { payload?: Record<string, unknown> };
              const candidate = envelope.payload?.["reason"] ?? envelope.payload?.["failure_code"];
              if (typeof candidate === "string") reason = candidate.slice(0, 300);
            } catch {
              // An unparseable payload is listed without a reason — never a
              // fabricated one.
            }
            return { type: row.event_type, occurred_at: row.occurred_at, reason };
          });
        failures.push({
          run_id: run.run_id,
          // The filter above narrows the state; the explicit union keeps the
          // record honest against the contract enum.
          state: run.state as "FAILED" | "RECOVERY_REQUIRED",
          occurred_at: run.updated_at,
          events: failureEvents,
        });
      }
      // Contract-checked at the boundary the same way every other response is.
      const parsed = failures.map((record) => RuntimeAdminTaskFailureRecord.parse(record));
      return { workspace_id: input.workspaceId, failures: parsed };
    },

    async takeBackup(input) {
      if (!deps.backupTake) {
        return {
          taken: false,
          workspace_id: input.workspaceId,
          snapshot_ref: input.snapshotRef,
          reason: "conflict",
          detail: "the backup mechanism is not wired in this composition",
        };
      }
      try {
        const result = await deps.backupTake({
          triggeredBy: "admin",
          snapshotRef: input.snapshotRef,
        });
        if (result.taken) {
          return {
            taken: true,
            workspace_id: input.workspaceId,
            snapshot_id: result.snapshot_id,
            taken_at: result.taken_at,
            db_bytes: result.db_bytes,
            retained_index: result.retained_index,
          };
        }
        return {
          taken: false,
          workspace_id: input.workspaceId,
          snapshot_ref: input.snapshotRef,
          reason: result.reason === "tick_failed" ? "export_failed" : result.reason,
          detail: result.detail.slice(0, 300),
        };
      } catch (error) {
        // The one throw the walk keeps is the replayed-ref conflict
        // (SNAPSHOT_DIR_CONFLICT) — the typed refusal, never a 500.
        const detail = error instanceof Error ? error.message : String(error);
        deps.logFault?.("admin_backup_take_refused", {
          workspace_id: input.workspaceId,
          snapshot_ref: input.snapshotRef,
          actor: input.actor.id,
          reason: detail.slice(0, 300),
        });
        return {
          taken: false,
          workspace_id: input.workspaceId,
          snapshot_ref: input.snapshotRef,
          reason: "conflict",
          detail: detail.slice(0, 300),
        };
      }
    },

    async restoreBackup(input) {
      if (!deps.restorePorts || deps.restorePorts.workspaceId !== input.workspaceId) {
        return {
          restored: false,
          workspace_id: input.workspaceId,
          snapshot_id: input.snapshotId,
          failed_stage: "policy",
          code: "RESTORE_PORTS_NOT_WIRED",
          detail:
            "this composition wires no container-level stop/start ports — the restore " +
            "is performed through the operator runbook (stop services, run the restore, restart)",
          replaced_before_failure: false,
        };
      }
      const result = await deps.restorePorts.restoreSnapshot({ snapshotId: input.snapshotId });
      if (result.restored) {
        return {
          restored: true,
          workspace_id: input.workspaceId,
          snapshot_id: result.snapshot_id,
          restored_at: result.restored_at,
          migrated_from: result.migrated_from,
          migrated_to: result.migrated_to,
          db_bytes: result.db_bytes,
          volume_entry_count: result.volume_entries.length,
        };
      }
      return {
        restored: false,
        workspace_id: input.workspaceId,
        snapshot_id: result.snapshot_id,
        failed_stage: result.failed_stage,
        code: result.code,
        detail: result.detail.slice(0, 300),
        replaced_before_failure: result.replaced_before_failure,
      };
    },
  };
}

/** The journal event types that ARE a failure narrative (PRD §15 view). */
const FAILURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.failed",
  "task.recovery_required",
  "run.failure_decided",
  "worker.crashed",
]);

/** The latest `task.paused` reason on the run's lifecycle stream, or null. */
function latestPauseReason(
  journal: Pick<EventJournalRepository, "findById" | "nextSequence" | "readFrom">,
  workspaceId: string,
  runId: string,
): string | null {
  const events = journal.readFrom(workspaceId, taskStreamId(runId), 0, 10_000);
  let reason: string | null = null;
  for (const row of events) {
    if (row.event_type !== "task.paused") continue;
    try {
      // The journal row payload is the full D26 envelope; the reason lives
      // in envelope.payload (the same read the retry coordinator makes).
      const envelope = JSON.parse(row.payload) as { payload?: { reason?: unknown } };
      const candidate = envelope.payload?.reason;
      if (typeof candidate === "string") reason = candidate;
    } catch {
      // An unparseable payload never fabricates a reason; the run stays
      // skipped (fail-closed — a top-up must not resume a pause it cannot
      // classify).
    }
  }
  return reason;
}
