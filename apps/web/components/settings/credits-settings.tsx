"use client";

import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

import { ErrorState } from "@/components/shell/states";
import { useCreditsSummary, useRunCost } from "@/lib/credits-data";
import { useTriggers } from "@/lib/schedules-data";
import type { CreditsSummary, RunCostDrillDown } from "@/lib/credits-api";
import { useContainerResolution } from "@/lib/container-connection";
import { cn } from "@/lib/utils";

/**
 * The S9 "Model budgets / Credits" settings surface (UI_DESIGN §S9 row;
 * D20, D21, D48, AC8, S24). Every number is the runtime ledger's OWN record
 * (the summary and drill-down reads) — the UI computes nothing and falls
 * back to nothing (G4). The surface shows: remaining / reserved / used this
 * month, the custom-provider usage (which never consumed Shera credits,
 * D20), the per-run cost drill-down that sums exactly to the ledger, and
 * the exhausted-credit pause card naming its unblocking paths (D48).
 */

export type CreditsSurfaceState = "ready" | "loading" | "error";

function LoadingState() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading credits">
      {[0, 1].map((row) => (
        <div
          key={row}
          className="h-24 animate-pulse rounded-2xl border border-line bg-surface-elevated"
        />
      ))}
    </div>
  );
}

const MOVEMENT_LABELS: Record<string, string> = {
  grant: "Credits granted",
  reservation_hold: "Reserved for a model call",
  settlement_charge: "Charged after the call",
  reservation_release: "Released (unused)",
  // A run-scoped correction is always a charge refund: grants are
  // account-level (task_id null) and never appear in a run's drill-down,
  // so the label can honestly name the effect, not the mechanism.
  adjustment: "Correction (refunded)",
};

const RELEASE_LABELS: Record<string, string> = {
  provider_failure: "the provider call failed",
  task_cancelled: "the run was cancelled",
  unused_estimate: "the estimate exceeded the actual usage",
};

function units(n: number): string {
  return n.toLocaleString("en-GB");
}

/** One headline number: the value first, the label under it — no kicker, no
 * card grid; a single honest row of the ledger's own numbers. */
function HeadlineNumber({
  value,
  label,
  tone = "default",
  testId,
}: {
  value: number;
  label: string;
  tone?: "default" | "exhausted";
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <p
        data-testid={testId}
        className={cn(
          "font-mono text-3xl tabular-nums leading-none",
          tone === "exhausted" ? "text-approval" : "text-text",
        )}
      >
        {units(value)}
      </p>
      <p className="mt-1.5 text-xs text-muted">{label}</p>
    </div>
  );
}

/** The exhausted-credit pause card (D48): the distinct, user-visible state
 * with its unblocking paths named in the product's own words. */
function ExhaustedPauseCard({ pausedTriggerCount }: { pausedTriggerCount: number }) {
  return (
    <div
      data-testid="credits-exhausted-card"
      role="status"
      className="rounded-xl border border-approval/50 bg-approval/5 px-4 py-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-approval" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm text-text">Out of Shera credits</p>
          <p className="mt-1 text-sm text-muted">
            Model calls pause with “insufficient credits” until an administrator tops the account
            up. Paused runs resume automatically after the top-up — or you can cancel them from
            their Operation chat.
            {pausedTriggerCount > 0
              ? ` ${pausedTriggerCount} scheduled trigger${pausedTriggerCount === 1 ? " is" : "s are"} paused for credits right now.`
              : ""}
          </p>
          <p className="mt-2 text-xs text-muted">
            Credits never affect tools, files, or approvals — only model calls consume them.
          </p>
        </div>
      </div>
    </div>
  );
}

/** One run row of the drill-down picker (the ledger's own per-run net). */
function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: CreditsSummary["recent_runs"][number];
  selected: boolean;
  onSelect: (taskId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="credits-run-row"
        onClick={() => onSelect(run.task_id)}
        aria-expanded={selected}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
          selected
            ? "border-line-accent bg-surface-elevated"
            : "border-transparent hover:bg-surface-elevated",
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">{run.task_id}</span>
        {run.active_reserved_units > 0 ? (
          <span className="shrink-0 text-xs text-sky">
            <span className="font-mono tabular-nums">{units(run.active_reserved_units)}</span>{" "}
            reserved
          </span>
        ) : null}
        {run.released_units > 0 ? (
          <span className="shrink-0 text-xs text-muted">
            <span className="font-mono tabular-nums">{units(run.released_units)}</span> released
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-muted">
          <span className="font-mono tabular-nums text-text">{units(run.charged_units)}</span>{" "}
          charged
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
    </li>
  );
}

/** The one run's drill-down detail: the movement rows are the ledger's own
 * append-only rows — the detail sums to the run's charged number by
 * construction (AC8), and the copy says so. */
function RunDrillDown({ drillDown }: { drillDown: RunCostDrillDown }) {
  return (
    <div
      data-testid="credits-run-detail"
      className="rounded-xl border border-line bg-surface-elevated px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-text">{drillDown.task_id}</p>
        <p className="text-xs text-muted">
          <span className="font-mono tabular-nums text-text">{units(drillDown.charged_units)}</span>{" "}
          charged ·{" "}
          <span className="font-mono tabular-nums">{units(drillDown.released_units)}</span> released
          back
        </p>
      </div>
      <ul className="mt-3 space-y-1.5">
        {drillDown.movements.map((movement) => (
          <li
            key={movement.transaction_id}
            className="flex items-baseline justify-between gap-3 text-xs"
          >
            <span className="min-w-0 truncate text-muted">
              {MOVEMENT_LABELS[movement.entry_type] ?? movement.entry_type}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-text">
              {units(movement.amount_units)}
            </span>
          </li>
        ))}
      </ul>
      {drillDown.usage.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3">
          {drillDown.usage.map((usage) => (
            <div
              key={usage.usage_id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs"
            >
              <span className="text-muted">
                {usage.provider_origin === "user"
                  ? `${usage.provider_id} (custom — no Shera credits)`
                  : usage.provider_id}
              </span>
              <span className="font-mono tabular-nums text-muted">
                {usage.input_tokens === null && usage.output_tokens === null
                  ? "usage not reported"
                  : `${units(usage.input_tokens ?? 0)} in / ${units(usage.output_tokens ?? 0)} out`}
                {usage.latency_ms !== null ? ` · ${units(usage.latency_ms)} ms` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {drillDown.releases.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3">
          {drillDown.releases.map((release) => (
            <div
              key={release.release_id}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <span className="text-muted">
                Released because {RELEASE_LABELS[release.reason] ?? release.reason}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-text">
                {units(release.released_units)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CreditsSettingsView({
  summary,
  surfaceState,
  safeErrorMessage,
  onRetry,
  selectedRunId,
  onSelectRun,
  drillDown,
  drillDownState,
  pausedTriggerCount = 0,
}: {
  summary: CreditsSummary | null;
  surfaceState: CreditsSurfaceState;
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  selectedRunId: string | null;
  onSelectRun: (taskId: string) => void;
  drillDown: RunCostDrillDown | null;
  drillDownState: "idle" | "loading" | "ready" | "error";
  /** The schedules read's own count (the D48 trigger pause) — the card's
   * count line is truth, never a local guess. */
  pausedTriggerCount?: number;
}) {
  if (surfaceState === "loading") {
    return <LoadingState />;
  }
  if (surfaceState === "error") {
    return (
      <ErrorState
        safeMessage={safeErrorMessage ?? "The credit ledger could not be loaded."}
        onRetry={onRetry}
      />
    );
  }
  if (summary === null || summary.account === null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          No credit account exists in this workspace yet. It is provisioned when an administrator
          grants the first credits.
        </p>
      </div>
    );
  }
  const account = summary.account;
  const exhausted = account.exhausted;

  return (
    <div className="space-y-8">
      {/* The pause card leads when it applies (D48: a distinct, visible
          state with what to do next — never buried). */}
      {exhausted ? <ExhaustedPauseCard pausedTriggerCount={pausedTriggerCount} /> : null}

      {/* The ledger's own numbers — one row, tabular, no card grid. */}
      <div>
        <h2 className="text-base text-text">Shera credits</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          The account-level balance. Requests reserve a bounded estimate before a model call, settle
          against the actual usage, and release what they did not use — the numbers below are the
          ledger's own.
        </p>
        <div className="mt-5 flex flex-wrap gap-x-10 gap-y-4">
          <HeadlineNumber
            value={account.remaining_units}
            label="Remaining (not reserved)"
            tone={exhausted ? "exhausted" : "default"}
            testId="credits-remaining"
          />
          <HeadlineNumber
            value={account.reserved_units}
            label="Reserved for running tasks"
            testId="credits-reserved"
          />
          <HeadlineNumber
            value={account.used_this_month_units}
            label="Used this month"
            testId="credits-used-this-month"
          />
        </div>
        <p className="mt-3 text-xs text-muted">
          Granted {units(account.granted_units)} · charged {units(account.charged_units)} ·
          prototype accounting, not billing.
        </p>
      </div>

      {/* The per-run drill-down (AC8): the picker rows are the ledger's
          runs-with-movements; the detail lists the run's OWN movement rows. */}
      <div>
        <h2 className="text-base text-text">Per-run cost</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Select a run to see its reservation, settlement, and release rows. Every run's rows sum
          exactly to its charged number — and to the ledger.
        </p>
        {summary.recent_runs.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            No model call has consumed credits yet — the ledger has nothing to show, and nothing is
            estimated.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            <ul className="space-y-1">
              {summary.recent_runs.map((run) => (
                <RunRow
                  key={run.task_id}
                  run={run}
                  selected={run.task_id === selectedRunId}
                  onSelect={onSelectRun}
                />
              ))}
            </ul>
            {drillDownState === "loading" ? (
              <p className="flex items-center gap-2 px-1 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Loading the run's
                ledger rows…
              </p>
            ) : null}
            {drillDownState === "error" ? (
              <p className="px-1 text-xs text-approval">
                This run&apos;s ledger rows could not be loaded.
              </p>
            ) : null}
            {drillDownState === "ready" && drillDown !== null ? (
              <RunDrillDown drillDown={drillDown} />
            ) : null}
          </div>
        )}
      </div>

      {/* The custom-provider usage (D20): measured locally, zero credit
          movement — the zero is the point, and the copy says it. */}
      <div>
        <h2 className="text-base text-text">Custom-provider usage</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Requests through your own providers never consume Shera credits — they are measured
          locally instead.
        </p>
        {summary.custom_provider_usage.calls === 0 ? (
          <p className="mt-3 text-sm text-muted">No custom-provider calls this month.</p>
        ) : (
          <div className="mt-3 space-y-1 text-sm">
            <p className="text-text">
              <span className="font-mono tabular-nums">
                {units(summary.custom_provider_usage.calls)}
              </span>{" "}
              call{summary.custom_provider_usage.calls === 1 ? "" : "s"} this month ·{" "}
              <span className="font-mono tabular-nums">
                {units(summary.custom_provider_usage.input_tokens)}
              </span>{" "}
              tokens in ·{" "}
              <span className="font-mono tabular-nums">
                {units(summary.custom_provider_usage.output_tokens)}
              </span>{" "}
              tokens out · <span className="text-muted">0 Shera credits</span>
            </p>
            <p className="text-xs text-muted">
              Providers: {summary.custom_provider_usage.providers.join(", ")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** The composed surface: container resolution → the ledger hooks → the view. */
export function CreditsSettingsSurface() {
  const resolution = useContainerResolution();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  if (resolution.isPending || resolution.data === undefined) {
    if (resolution.isError) {
      return (
        <ErrorState
          safeMessage="The credit ledger reads its truth from the runtime; the runtime is not answering right now."
          onRetry={() => resolution.refetch()}
        />
      );
    }
    return <LoadingState />;
  }
  if (resolution.data?.kind !== "ready") {
    return (
      <ErrorState
        safeMessage="The credit ledger lives in the user container; it is still preparing."
        onRetry={() => resolution.refetch()}
      />
    );
  }
  return (
    <RuntimeCreditsSettings
      workspaceId={resolution.data.workspace_id}
      selectedRunId={selectedRunId}
      onSelectRun={setSelectedRunId}
    />
  );
}

function RuntimeCreditsSettings({
  workspaceId,
  selectedRunId,
  onSelectRun,
}: {
  workspaceId: string;
  selectedRunId: string | null;
  onSelectRun: (taskId: string) => void;
}) {
  const catalog = useCreditsSummary(workspaceId);
  const runCost = useRunCost(workspaceId, selectedRunId);
  // The D48 trigger pause count comes from the schedules read (the same
  // cached query the schedules surface uses — never a second source).
  const schedules = useTriggers(workspaceId);
  const pausedTriggerCount =
    schedules.state === "ready"
      ? schedules.triggers.filter(
          (trigger) =>
            trigger.state === "paused" && trigger.pause_reason === "insufficient_credits",
        ).length
      : 0;
  if (catalog.state === "loading") {
    return (
      <CreditsSettingsView
        summary={null}
        surfaceState="loading"
        safeErrorMessage={undefined}
        onRetry={catalog.refetch}
        selectedRunId={null}
        onSelectRun={onSelectRun}
        drillDown={null}
        drillDownState="idle"
      />
    );
  }
  if (catalog.state === "error") {
    return (
      <CreditsSettingsView
        summary={null}
        surfaceState="error"
        safeErrorMessage={catalog.safeErrorMessage}
        onRetry={catalog.refetch}
        selectedRunId={null}
        onSelectRun={onSelectRun}
        drillDown={null}
        drillDownState="idle"
      />
    );
  }
  return (
    <CreditsSettingsView
      summary={catalog.summary}
      surfaceState="ready"
      safeErrorMessage={undefined}
      onRetry={catalog.refetch}
      selectedRunId={selectedRunId}
      onSelectRun={onSelectRun}
      drillDown={runCost.drillDown}
      drillDownState={runCost.state}
      pausedTriggerCount={pausedTriggerCount}
    />
  );
}
