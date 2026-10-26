"use client";

import { Cpu } from "lucide-react";

import { ErrorState } from "@/components/shell/states";
import { useContainerResolution } from "@/lib/container-connection";
import { cn } from "@/lib/utils";
import { useWorkerAdmission } from "@/lib/worker-data";
import type {
  WorkerAdmissionLimits,
  WorkerAdmissionReadout as WorkerAdmissionReadoutData,
} from "@/lib/worker-api";

/**
 * The Task workers admission readout (S16 chunk 3; UI_DESIGN S11 resource
 * states, E1): a compact, honest view of the runtime's worker supervision —
 * the configured limits, the live worker count, and the runs waiting in the
 * admission queue with their reason VERBATIM (the machine-readable code plus
 * the gate's own human text; G3 — the gate copy is fixed safe text, never a
 * harness surface).
 *
 * Honesty rules (G4): a runtime without a configured worker harness renders
 * "not configured" — never a limits table of zeros dressed up as policy; an
 * absent or failed read renders the §2.4 error state, never a fabricated
 * state. `live_workers` is the RUNTIME-WIDE live count (the E1 admission
 * basis counts durable live rows across workspaces) while `queued_runs` is
 * THIS workspace's slice — the labels say exactly that, never more.
 *
 * The presentational component is props-driven so the node suites render it
 * directly; `WorkersSettingsSurface` is the hook-wired client surface the
 * settings route mounts.
 */

/** Whole-GiB ceilings render without decimals; fractional values keep one. */
export function formatMemoryCeiling(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gib) ? gib.toString() : gib.toFixed(1)} GiB`;
}

function formatDiskFloor(bytes: number): string {
  return bytes === 0 ? "none" : formatMemoryCeiling(bytes);
}

function LimitRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-elevated px-3 py-2">
      <span className="text-xs text-muted">{label}</span>
      <span data-testid={testId} className="font-mono text-xs text-text">
        {value}
      </span>
    </div>
  );
}

function LimitsTable({
  limits,
  liveWorkers,
}: {
  limits: WorkerAdmissionLimits;
  liveWorkers: number;
}) {
  return (
    <div data-testid="workers-limits" className="flex flex-col gap-2">
      <LimitRow
        label="Live workers (runtime)"
        value={`${liveWorkers} of ${limits.maxConcurrentWorkers}`}
        testId="workers-live-count"
      />
      <LimitRow
        label="Per-provider concurrency"
        value={String(limits.maxConcurrentRunsPerProvider)}
        testId="workers-limit-provider"
      />
      <LimitRow
        label="Per-worker memory ceiling"
        value={formatMemoryCeiling(limits.maxWorkerMemoryBytes)}
        testId="workers-limit-memory"
      />
      <LimitRow
        label="Total memory budget"
        value={formatMemoryCeiling(limits.maxTotalWorkersMemoryBytes)}
        testId="workers-limit-total-memory"
      />
      <LimitRow
        label="Per-worker process cap"
        value={String(limits.maxWorkerProcesses)}
        testId="workers-limit-processes"
      />
      <LimitRow
        label="Disk floor"
        value={formatDiskFloor(limits.minFreeDiskBytes)}
        testId="workers-limit-disk"
      />
    </div>
  );
}

export function WorkerAdmissionReadout({
  state,
  readout,
  safeErrorMessage,
  onRetry,
  className,
}: {
  state: "loading" | "ready" | "error";
  readout: WorkerAdmissionReadoutData | null;
  safeErrorMessage?: string | undefined;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <section
      data-testid="workers-readout"
      aria-label="Task workers"
      className={cn("flex flex-col gap-4", className)}
    >
      <h2 className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.16em] text-muted">
        <Cpu className="size-3.5" aria-hidden="true" />
        Task workers
      </h2>

      {state === "loading" ? (
        <div
          aria-busy="true"
          data-testid="workers-readout-skeleton"
          className="flex flex-col gap-2"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-lg bg-surface-elevated" />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState
          safeMessage={safeErrorMessage ?? "The worker readout could not be loaded."}
          onRetry={onRetry}
        />
      ) : readout === null ? (
        <ErrorState safeMessage="The worker readout could not be loaded." onRetry={onRetry} />
      ) : readout.configured && readout.limits !== null ? (
        <>
          <p
            data-testid="workers-configured-state"
            data-configured="true"
            className="text-sm text-muted"
          >
            Worker supervision is configured on this runtime. Runs queue — never die — when a limit
            is reached, and re-admit oldest-first as capacity frees.
          </p>
          <LimitsTable limits={readout.limits} liveWorkers={readout.live_workers} />
          <div className="flex flex-col gap-2">
            <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
              Waiting for capacity (this workspace)
            </h3>
            {readout.queued_runs.length === 0 ? (
              <p data-testid="workers-queue-empty" className="text-sm text-muted">
                No runs waiting.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {readout.queued_runs.map((queued) => (
                  <li
                    key={queued.run_id}
                    data-testid="workers-queued-run"
                    data-reason-code={queued.reason.code}
                    className="rounded-lg border border-line bg-surface-elevated px-3 py-2"
                  >
                    <p className="truncate font-mono text-xs text-text">{queued.run_id}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted">{queued.reason.code}</p>
                    {queued.message ? (
                      <p className="mt-0.5 text-xs text-muted">{queued.message}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <p
          data-testid="workers-configured-state"
          data-configured="false"
          className="text-sm text-muted"
        >
          Task workers are not configured on this runtime. Operations runs proceed without dedicated
          worker processes.
        </p>
      )}
    </section>
  );
}

/** The hook-wired surface the settings route mounts (the S9 "Workers" section). */
export function WorkersSettingsSurface() {
  const resolution = useContainerResolution();
  const workspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  const { state, readout, safeErrorMessage, refetch } = useWorkerAdmission(workspaceId);
  return (
    <WorkerAdmissionReadout
      state={workspaceId === null ? "loading" : state}
      readout={readout}
      safeErrorMessage={safeErrorMessage}
      onRetry={refetch}
    />
  );
}
