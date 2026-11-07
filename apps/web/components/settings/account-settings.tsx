"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useSessionIdentity } from "@/lib/container-connection";
import { useOnboardingCommands } from "@/lib/onboarding-data";
import type { OnboardingStatus } from "@shera-bot/contracts";

/**
 * The S9 "Account" settings surface (S30; D16, UI_DESIGN §S9): the Google
 * identity and tier from the session, the HONEST storage statement (no
 * fabricated usage number — G4), and the reopen-onboarding control (D16:
 * the interview is reopenable; the command is the typed onboarding.reopen,
 * the SAME onboarding surface the chat cards use — no separate schema).
 */

export interface AccountSettingsViewProps {
  displayName: string;
  email: string;
  tier: string;
  onboardingStatus: OnboardingStatus | "unknown";
  surfaceState: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
  commandPending: boolean;
  commandSafeError?: string | undefined;
  pendingReopen: boolean;
  onReopenClick: () => void;
  onReopenConfirm: () => void;
  onReopenCancel: () => void;
}

/** The storage line: honest about what is and is not measured (G4). */
export function storageUsageLine(bytesUsed: number | null): string {
  if (bytesUsed === null) {
    return "Storage usage is not measured in this prototype yet — nothing here is a guess.";
  }
  return `${bytesUsed} bytes used`;
}

const TIER_LABELS: Record<string, string> = {
  light: "Light",
  balanced: "Balanced",
  heavy: "Heavy",
};

export function AccountSettingsView(props: AccountSettingsViewProps) {
  if (props.surfaceState === "loading") {
    return (
      <div aria-busy="true" aria-hidden="true" className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-surface-elevated" />
        <div className="h-40 animate-pulse rounded-xl bg-surface-elevated" />
      </div>
    );
  }
  if (props.surfaceState === "error") {
    return (
      <div role="alert" className="rounded-xl border border-line bg-surface p-6">
        <p className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {props.safeErrorMessage ?? "The account settings could not be loaded."}
        </p>
      </div>
    );
  }

  const tierLabel = TIER_LABELS[props.tier] ?? props.tier;

  return (
    <div className="space-y-4">
      <section aria-label="Google identity" className="rounded-xl border border-line bg-surface p-4">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Signed in</h3>
        <p className="mt-2 text-sm font-medium text-text">{props.displayName}</p>
        <p className="text-sm text-muted">{props.email}</p>
        <p className="mt-2 text-xs text-muted">
          Tier (display only): <span className="font-mono text-sky">{tierLabel}</span>
        </p>
      </section>

      <section aria-label="Storage" className="rounded-xl border border-line bg-surface p-4">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Storage</h3>
        <p className="mt-2 text-sm text-text">{storageUsageLine(null)}</p>
        <p className="mt-1 text-xs text-muted">
          Your data lives inside your workspace container (D2, local-first); files are never
          automatically deleted (PRD §12).
        </p>
      </section>

      {props.commandPending ? (
        <p role="status" className="text-sm text-sky">
          Saving…
        </p>
      ) : null}
      {props.commandSafeError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {props.commandSafeError}
        </p>
      ) : null}

      <section aria-label="Welcome interview" className="rounded-xl border border-line bg-surface p-4">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Welcome interview
        </h3>
        <p className="mt-2 text-sm text-text">
          {props.onboardingStatus === "completed"
            ? "Completed — the interview stays available whenever you want it back."
            : props.onboardingStatus === "dismissed"
              ? "Skipped — reopen it anytime; your earlier answers are kept."
              : props.onboardingStatus === "pending"
                ? "Open — the interview card is running in your workspace."
                : "The interview state could not be read."}
        </p>
        {props.pendingReopen ? (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={props.onReopenConfirm}>
              Confirm reopen
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onReopenCancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="account-reopen-onboarding"
            onClick={props.onReopenClick}
          >
            <RotateCcw aria-hidden="true" />
            Reopen the welcome interview
          </Button>
        )}
        <p className="mt-2 text-xs text-muted">
          The interview never blocks you and never asks for credentials — reopening only brings the
          cards back.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------

export function AccountSettingsSurface() {
  const session = useSessionIdentity();
  const workspaceId = session.data?.workspace_id ?? null;
  const commands = useOnboardingCommands(workspaceId);
  const [pendingReopen, setPendingReopen] = useState(false);

  if (session.isPending) {
    return (
      <div aria-busy="true" aria-hidden="true" className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-surface-elevated" />
        <div className="h-40 animate-pulse rounded-xl bg-surface-elevated" />
      </div>
    );
  }
  if (session.isError || !session.data) {
    return (
      <div role="status" className="mx-auto my-8 max-w-md rounded-xl border border-line bg-surface p-6 text-center text-sm text-text">
        Account settings read your signed-in session. Start your workspace and come back.
      </div>
    );
  }

  const reopen = () => {
    commands.submitReopen();
    setPendingReopen(false);
  };

  return (
    <div className="mx-auto max-w-xl">
      <AccountSettingsView
        displayName={session.data.display_name}
        email={session.data.email}
        tier={session.data.tier}
        onboardingStatus={commands.snapshot?.status ?? "unknown"}
        surfaceState={commands.state}
        safeErrorMessage={commands.safeError}
        commandPending={commands.pending}
        commandSafeError={commands.safeError}
        pendingReopen={pendingReopen}
        onReopenClick={() => setPendingReopen(true)}
        onReopenConfirm={reopen}
        onReopenCancel={() => setPendingReopen(false)}
      />
    </div>
  );
}
