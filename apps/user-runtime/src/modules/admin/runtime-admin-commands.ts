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
import type { OperationRun } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { TaskRunOperationsSeam } from "../workers/task-worker-supervisor.service.ts";
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
      return {
        workspace_id: input.workspaceId,
        topup_id: input.topupId,
        resumed_run_ids: resumedRunIds,
        skipped,
      };
    },
  };
}

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
