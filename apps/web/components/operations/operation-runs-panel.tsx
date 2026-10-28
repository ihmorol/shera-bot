import { Play, ListChecks } from "lucide-react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { OperationRun as OperationRunType } from "@shera-bot/contracts";
import { cn } from "@/lib/utils";

/**
 * Operation runs panel (UI_DESIGN §S4, D31/D34/D8): every run with its D8
 * state, event-sequence cursor, and artifact count. Runs are never merged
 * (AC24): a delegated subrun is labeled by its parent task id (D34/D46) rather
 * than folded into the top-level run. The chat remains after tasks complete
 * for follow-ups, so "New run" is a first-class affordance (PRD §4.2).
 *
 * S20 (§S8): WAITING_FOR_APPROVAL renders in the §2.1 status vocabulary —
 * the amber approval accent, the dot paired with text (§2.3: color never the
 * only signal), and the honest pause line. The pause is the approval flow:
 * the deciding card lives in the thread.
 */

/** The run state chip's §2.1 status vocabulary — shared with cards.tsx. */
function runStateClass(state: OperationRunType["state"]): string {
  switch (state) {
    case "RUNNING":
    case "RETRYING":
      return "text-sky";
    case "WAITING_FOR_APPROVAL":
      return "text-approval";
    case "FAILED":
    case "PAUSED":
    case "RECOVERY_REQUIRED":
      return "text-failed";
    default:
      return "text-muted";
  }
}
export function OperationRunsPanel({
  runs,
  state,
  safeErrorMessage,
  onRetry,
  onCreateRun,
  createPending,
  className,
}: {
  runs: OperationRunType[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  onCreateRun: () => void;
  createPending: boolean;
  className?: string;
}) {
  return (
    <section
      data-testid="operation-runs-panel"
      aria-label="Operation runs"
      className={cn("flex flex-col gap-3 px-4 py-4 lg:px-5", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.16em] text-muted">
          <ListChecks className="size-3.5" aria-hidden="true" />
          Runs
        </h2>
        <Button size="sm" variant="outline" disabled={createPending} onClick={onCreateRun}>
          New run
        </Button>
      </div>

      {state === "loading" ? (
        <div aria-busy="true" data-testid="operation-runs-skeleton" className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="animate-pulse rounded-lg bg-surface-elevated h-12" />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState
          safeMessage={safeErrorMessage ?? "The runs list could not be loaded."}
          onRetry={onRetry}
        />
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted">
          No runs yet. Start the Operation&apos;s first run when you&apos;re ready — the chat stays
          open around it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map((run) => (
            <li
              key={run.run_id}
              data-testid="operation-run"
              data-run-state={run.state}
              className="rounded-lg border border-line bg-surface-elevated px-3 py-2"
            >
              <p className="truncate font-mono text-xs text-text">{run.run_id}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <span
                  data-testid="operation-run-state"
                  className={cn("flex items-center gap-1.5 font-mono", runStateClass(run.state))}
                >
                  {run.state === "WAITING_FOR_APPROVAL" ? (
                    <span className="size-1.5 rounded-full bg-approval" aria-hidden="true" />
                  ) : null}
                  {run.state}
                  {run.state === "WAITING_FOR_APPROVAL" ? (
                    <span className="sr-only">— paused for your approval</span>
                  ) : null}
                </span>
                <span>{run.events_seq_cursor} events</span>
                <span>
                  {run.artifacts.length === 1 ? "1 artifact" : `${run.artifacts.length} artifacts`}
                </span>
              </p>
              {run.state === "WAITING_FOR_APPROVAL" ? (
                <p className="mt-0.5 text-xs text-approval" data-testid="operation-run-waiting">
                  Paused for your approval — decide from the card in the thread.
                </p>
              ) : null}
              {run.parent_task_id ? (
                // D34/D46: a delegated subrun stays its own independently
                // tracked run, labeled by the delegating task.
                <p
                  data-testid="operation-run-parent"
                  className="mt-0.5 flex items-center gap-1 text-xs text-muted"
                >
                  <Play className="size-3" aria-hidden="true" />
                  Delegated subrun of {run.parent_task_id}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
