"use client";

import { AlertTriangle, DatabaseBackup } from "lucide-react";

import { ErrorState } from "@/components/shell/states";
import { useSessionIdentity } from "@/lib/container-connection";
import { useRecoveryStatus } from "@/lib/recovery-data";

/**
 * The S9 "Backups & recovery" settings surface (S30; PRD §12/§13,
 * UI_DESIGN §S9): the recorded snapshot posture (every six hours, the latest
 * seven retained, restore is admin-triggered) and the RUNTIME'S OWN current
 * recovery status (the S31 read — the same record the recovery banner
 * renders). Read-only BY RECORDED DECISION (restore is admin-triggered);
 * the honest user-side answer is information, never a fake restore button
 * (G4/G5).
 */

export interface BackupsSettingsViewProps {
  recoveryState: "recovering" | "resumed" | "review_needed" | "idle" | "unknown";
  reviewNeededCount: number;
  surfaceState: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
}

const RECOVERY_LABELS: Record<BackupsSettingsViewProps["recoveryState"], string> = {
  recovering: "Recovering — restoring your workspace",
  resumed: "Resumed — the last recovery completed",
  review_needed: "Review needed — a task is waiting for you",
  idle: "Idle",
  unknown: "Current status unavailable",
};

export function BackupsSettingsView({
  recoveryState,
  reviewNeededCount,
  surfaceState,
  safeErrorMessage,
}: BackupsSettingsViewProps) {
  if (surfaceState === "loading") {
    return (
      <div aria-busy="true" aria-hidden="true" className="space-y-3">
        <div className="h-16 animate-pulse rounded-xl bg-surface-elevated" />
        <div className="h-32 animate-pulse rounded-xl bg-surface-elevated" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {surfaceState === "error" ? (
        <div role="alert">
          <ErrorState
            safeMessage={safeErrorMessage ?? "The recovery status could not be loaded."}
          />
        </div>
      ) : null}

      <section
        aria-label="Recovery status"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Current recovery status
        </h3>
        <p
          className={`mt-2 flex items-center gap-2 text-sm ${
            recoveryState === "review_needed" ? "text-approval" : "text-text"
          }`}
        >
          {recoveryState === "review_needed" ? (
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          ) : null}
          {RECOVERY_LABELS[recoveryState]}
          {recoveryState === "review_needed" && reviewNeededCount > 0
            ? ` (${reviewNeededCount})`
            : null}
        </p>
        <p className="mt-1 text-xs text-muted">
          Rendered from the runtime&apos;s own recovery record — the same source the top-of-app
          banner uses (PRD §13).
        </p>
      </section>

      <section
        aria-label="Snapshot posture"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center gap-3">
          <DatabaseBackup className="size-4 text-sky" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Snapshots</h3>
        </div>
        <p className="mt-2 text-sm text-text">
          Your persistent volume is snapshotted every six hours, and the latest seven snapshots are
          retained (PRD §12).
        </p>
        <p className="mt-1 text-xs text-muted">
          Restoring a snapshot is administrator-triggered — read-only information on this surface by
          that recorded decision, never a self-service button.
        </p>
      </section>
    </div>
  );
}

export function BackupsSettingsSurface() {
  const session = useSessionIdentity();
  const workspaceId = session.data?.workspace_id;
  const recovery = useRecoveryStatus(workspaceId);
  const status = recovery.data;
  return (
    <div className="mx-auto max-w-xl">
      <BackupsSettingsView
        recoveryState={status ? status.workspace_state : "unknown"}
        reviewNeededCount={status?.review_needed.length ?? 0}
        surfaceState={
          recovery.isPending ? "loading" : recovery.isError ? "error" : status ? "ready" : "error"
        }
        safeErrorMessage={recovery.isError ? "The recovery status could not be loaded." : undefined}
      />
    </div>
  );
}
