import { ListChecks, Play, GitBranch, FlaskConical, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { GitRunLinkage } from "@/lib/projects-api";
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
 *
 * S19 (§S9, PRD §10, E6): a coding run's card is git-aware — when the
 * runtime's project ledger holds a worktree or a merge request for this
 * run's task, the card names the project and branch, the worktree state
 * (the G5 queue reason included), and the validation status. The linkage is
 * a join over REAL runtime reads keyed on id equality; a run without git
 * work renders no git line at all — never an invented branch.
 *
 * S22 (§S3/S4 stop control, S11 run states; PRD §8, AC15): an ACTIVE run
 * carries the stop control. The inline confirmation names exactly what will
 * stop — the worker process tree, in-flight tool executions, and any queued
 * child runs — and what survives (logs and partial outputs), so the
 * destructive moment is decided on truth, not on a bare "confirm". RETRYING
 * renders the TRUE attempt count from the run's journal (the runtime's own
 * task.retry_scheduled envelopes) — never a hardcoded total; a run whose
 * count cannot be read renders no number at all. CANCELLING is the honest
 * in-progress state (controls disabled, aria-busy). CANCELLED is "stopped",
 * never a failure: the muted state with what was kept.
 */

/** The D8 states where the run is live work a stop command can target. */
const ACTIVE_RUN_STATES: ReadonlySet<OperationRunType["state"]> = new Set([
  "QUEUED",
  "PLANNED",
  "CREATED",
  "RUNNING",
  "WAITING_FOR_AGENT",
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_RESOURCE",
  "RETRYING",
]);

/** The validation chip inside a git-aware run card (§2.1 status vocabulary). */
function RunValidationStatus({
  status,
}: {
  status: NonNullable<GitRunLinkage["validation_status"]>;
}) {
  const copy =
    status === "passed"
      ? "validation passed"
      : status === "failed"
        ? "validation failed"
        : "validation not run";
  return (
    <span
      data-testid="operation-run-validation"
      data-validation-status={status}
      className={cn(
        "flex items-center gap-1 font-mono",
        status === "passed" ? "text-live" : status === "failed" ? "text-failed" : "text-muted",
      )}
    >
      <FlaskConical className="size-3" aria-hidden="true" />
      {copy}
    </span>
  );
}

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

/**
 * The inline stop confirmation (the destructive moment): names what stops
 * (the worker tree, in-flight tool work, queued child runs) and what stays
 * (logs and partial outputs). Inline — not a modal — because the decision is
 * small, scoped to one card, and reversible in the sense that matters here
 * (cancelled work is preserved, never deleted). Focus lands on the
 * confirming button; Escape or "Keep running" returns without acting.
 */
function StopConfirmation({
  runId,
  childCount,
  pending,
  safeErrorMessage,
  onConfirm,
  onDismiss,
}: {
  runId: string;
  childCount: number;
  pending: boolean;
  safeErrorMessage: string | undefined;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  // Focus lands on the confirming action the moment the confirmation opens
  // (the same contract the approval modal records); Escape returns without
  // acting — the container listens for it explicitly (no Radix wrapper here).
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      data-testid="operation-run-stop-confirm"
      role="alertdialog"
      aria-label={`Stop run ${runId}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) onDismiss();
      }}
      className="mt-2 rounded-lg border border-line bg-surface px-3 py-2.5"
    >
      <p className="text-xs text-text">
        Stop this run? The run&apos;s worker process tree and in-flight tool work stop now
        {childCount > 0
          ? `, and ${childCount === 1 ? "1 queued child run" : `${childCount} queued child runs`} will never start`
          : ""}
        . Logs and partial outputs are kept.
      </p>
      {safeErrorMessage ? (
        <p className="mt-1 text-xs text-failed" role="alert">
          {safeErrorMessage}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-failed/40 text-failed hover:border-failed hover:bg-surface"
          disabled={pending}
          data-autofocus="true"
          onClick={onConfirm}
        >
          {pending ? "Stopping…" : "Stop run"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDismiss}>
          Keep running
        </Button>
      </div>
    </div>
  );
}

export function OperationRunsPanel({
  runs,
  state,
  safeErrorMessage,
  onRetry,
  onCreateRun,
  createPending,
  gitLinkage,
  retryAttempts,
  onCancelRun,
  cancelPendingRunId,
  cancelSafeError,
  className,
}: {
  runs: OperationRunType[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  onCreateRun: () => void;
  createPending: boolean;
  /** The task→git join from the workspace's project ledger (S19 chunk 2). */
  gitLinkage?: Record<string, GitRunLinkage>;
  /**
   * S22 (AC3): the TRUE retry attempt count per run, read from each run's
   * journal by the caller. Absent/null → no number renders (never a guess).
   */
  retryAttempts?: Record<string, number | null> | undefined;
  /** S22: the cancel command (absent → the stop control is not offered). */
  onCancelRun?: (runId: string) => void;
  cancelPendingRunId?: string | null;
  cancelSafeError?: string | undefined;
  className?: string;
}) {
  // The inline confirmation is panel-local state: one run confirms at a time.
  const [confirmingRunId, setConfirmingRunId] = useState<string | null>(null);
  const cancellingHere = confirmingRunId !== null && cancelPendingRunId === confirmingRunId;
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
          {runs.map((run) => {
            const linkage = gitLinkage?.[run.run_id];
            const isActive = ACTIVE_RUN_STATES.has(run.state);
            const attempts = retryAttempts?.[run.run_id];
            const cancelPending = cancelPendingRunId === run.run_id;
            const confirming = confirmingRunId === run.run_id;
            const childCount = runs.filter(
              (candidate) => candidate.parent_task_id === run.run_id && isActive,
            ).length;
            return (
              <li
                key={run.run_id}
                data-testid="operation-run"
                data-run-state={run.state}
                className={cn(
                  "rounded-lg border border-line bg-surface-elevated px-3 py-2",
                  confirming && "border-approval",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-mono text-xs text-text">{run.run_id}</p>
                  {isActive && onCancelRun !== undefined && run.state !== "CANCELLING" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-mr-1.5 -mt-1 h-7 gap-1 px-2 text-muted hover:text-text"
                      disabled={cancelPendingRunId !== undefined && cancelPendingRunId !== null}
                      aria-label={`Stop run ${run.run_id}`}
                      data-testid="operation-run-stop"
                      onClick={() => setConfirmingRunId(run.run_id)}
                    >
                      <Square className="size-3" aria-hidden="true" />
                      Stop
                    </Button>
                  ) : null}
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span
                    data-testid="operation-run-state"
                    className={cn("flex items-center gap-1.5 font-mono", runStateClass(run.state))}
                  >
                    {run.state === "WAITING_FOR_APPROVAL" ? (
                      <span className="size-1.5 rounded-full bg-approval" aria-hidden="true" />
                    ) : null}
                    {run.state === "CANCELLING" ? (
                      <span className="animate-pulse" aria-hidden="true">
                        ●
                      </span>
                    ) : null}
                    {run.state}
                    <span className="sr-only">
                      {run.state === "CANCELLING"
                        ? "— stopping now"
                        : run.state === "WAITING_FOR_APPROVAL"
                          ? "— paused for your approval"
                          : null}
                    </span>
                  </span>
                  <span>{run.events_seq_cursor} events</span>
                  <span>
                    {run.artifacts.length === 1
                      ? "1 artifact"
                      : `${run.artifacts.length} artifacts`}
                  </span>
                </p>
                {run.state === "RETRYING" ? (
                  // AC3: the TRUE attempt count from the journal — rendered
                  // only when it is actually known, never a hardcoded total.
                  <p
                    className="mt-0.5 text-xs text-sky"
                    data-testid="operation-run-retrying"
                    data-attempt={typeof attempts === "number" ? attempts : undefined}
                  >
                    {typeof attempts === "number"
                      ? `Retrying — attempt ${attempts} failed; the next attempt is scheduled.`
                      : "Retrying after a transient failure."}
                  </p>
                ) : null}
                {run.state === "CANCELLING" ? (
                  <p
                    className="mt-0.5 text-xs text-muted"
                    aria-busy="true"
                    data-testid="operation-run-cancelling"
                  >
                    Stopping the run now — the worker tree and queued work are being cancelled.
                  </p>
                ) : null}
                {run.state === "CANCELLED" ? (
                  <p className="mt-0.5 text-xs text-muted" data-testid="operation-run-cancelled">
                    Stopped — logs and partial outputs are kept.
                  </p>
                ) : null}
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
                {linkage ? <GitLinkageLine linkage={linkage} /> : null}
                {confirming && onCancelRun !== undefined ? (
                  <StopConfirmation
                    runId={run.run_id}
                    childCount={childCount}
                    pending={cancellingHere}
                    safeErrorMessage={cancellingHere ? cancelSafeError : undefined}
                    onConfirm={() => onCancelRun(run.run_id)}
                    onDismiss={() => setConfirmingRunId(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** One run's git work: project, branch, worktree state, validation (G5 honest). */
function GitLinkageLine({ linkage }: { linkage: GitRunLinkage }) {
  return (
    <div
      data-testid="operation-run-git"
      className="mt-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <GitBranch className="size-3 text-muted" aria-hidden="true" />
        <span className="text-muted">{linkage.project_name}</span>
        {linkage.branch_name !== null ? (
          <span className="font-mono text-text">{linkage.branch_name}</span>
        ) : null}
        {linkage.worktree_status !== null ? (
          <span
            className={cn(
              "font-mono",
              linkage.worktree_status === "active"
                ? "text-live"
                : linkage.worktree_status === "queued"
                  ? "text-approval"
                  : "text-muted",
            )}
          >
            {linkage.worktree_status}
          </span>
        ) : null}
        {linkage.validation_status !== null ? (
          <RunValidationStatus status={linkage.validation_status} />
        ) : null}
      </p>
      {linkage.queue_reason !== null && linkage.worktree_status === "queued" ? (
        <p className="mt-1 text-xs text-muted">{linkage.queue_reason}</p>
      ) : null}
    </div>
  );
}
