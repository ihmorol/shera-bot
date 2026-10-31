/**
 * Runtime admin commands (S32, issue #33; D47, PRD §15) — the container-side
 * of the admin capabilities that must reach RUNTIME state. They ride the
 * RECORDED internal channel (the S06 authenticated per-container bearer
 * channel): the control plane's admin API calls them, this handle executes
 * them against the runtime's own machinery — never a second channel, never a
 * parallel cancellation or transition path.
 *
 * - cancelAllRuns: the emergency cancel-all for ONE user. It walks the
 *   workspace's non-terminal runs and drives EACH through the S22
 *   RunCancellationService (the recorded D8 two-step + full teardown:
 *   workers, executor work, children, leases, reservation seam, approvals).
 *   Terminal runs are skipped entirely (their outcome is theirs to keep).
 *   The actor is the admin identity the control plane attributes.
 * - applyCreditTopUp: the D48 unblocking path (chunk 6).
 * - listTaskFailures: the task-failure read for the admin failures view
 *   (chunk 7).
 *
 * Every method is tenant-scoped by construction: the caller passes the
 * workspace, and the internal API route verifies it against THIS runtime's
 * account binding before reaching the handle.
 */
import type { OperationRun } from "@shera-bot/contracts";
import type { RunCancellationService } from "../tasks/run-cancellation.service.ts";

export interface RuntimeAdminCancelAllResult {
  workspace_id: string;
  results: Array<{ run_id: string; outcome: string }>;
}

export interface RuntimeAdminCommandsHandle {
  cancelAllRuns(input: {
    workspaceId: string;
    actor: { type: "admin"; id: string };
  }): Promise<RuntimeAdminCancelAllResult>;
}

export interface RuntimeAdminCommandsDeps {
  /** The workspace's runs (all states). */
  listWorkspaceRuns: (workspaceId: string) => OperationRun[];
  /** The S22 cancellation machinery — the ONLY cancel path; it classifies
   * every outcome (cancelled / already_cancelled / already_settled) itself. */
  runCancellation: Pick<RunCancellationService, "cancelRun">;
}

export function buildRuntimeAdminCommandsHandle(
  deps: RuntimeAdminCommandsDeps,
): RuntimeAdminCommandsHandle {
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
  };
}
