"use client";

import Link from "next/link";
import { useId } from "react";

import type { CreditsSummary } from "@/lib/credits-api";
import { routes } from "@/lib/routes";
import { useCreditsSummary } from "@/lib/credits-data";
import { cn } from "@/lib/utils";

/**
 * The sidebar credits pill (UI_DESIGN §3.3 footer; D21, D20, S24): Shera
 * credits remaining, the reserved amount on hover — and on KEYBOARD FOCUS,
 * never hover-only (the reserved number is information, not decoration).
 * The numbers are the runtime ledger's own record (the summary read); the
 * pill computes nothing and fabricates nothing (G4): before the container
 * is ready it renders nothing, and a ledger error is the pill's honest
 * quiet state (the settings surface owns the loud error).
 *
 * An exhausted account reads amber with the unblocking path named in words
 * ("an administrator top-up resumes paused runs") — color is never the only
 * signal (§2.1), and the exhausted state is a distinct, user-visible state
 * (D48), not a generic warning.
 */

export type CreditsAccountView = NonNullable<CreditsSummary["account"]>;

/** The presentational pill (the hook-free branch the tests render). */
export function CreditsPillView({ account }: { account: CreditsAccountView }) {
  const detailId = useId();
  const exhausted = account.exhausted;
  const reserved = account.reserved_units;

  return (
    <Link
      href={routes.settings("credits")}
      data-testid="credits-pill"
      aria-describedby={detailId}
      className={cn(
        "group relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
        exhausted
          ? "border-approval/60 text-approval hover:border-approval"
          : "border-line text-text hover:border-line-accent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          exhausted ? "bg-approval" : reserved > 0 ? "bg-sky" : "bg-muted",
        )}
      />
      <span className="font-mono tabular-nums">
        {account.remaining_units.toLocaleString("en-GB")}
      </span>
      <span className="text-muted">credits left</span>

      {/* The reserved reveal: hover AND keyboard focus — group-focus-within
          keeps the keyboard path equal to the pointer path (§2.1). */}
      {reserved > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-max max-w-56 rounded-lg border border-line bg-surface-elevated px-3 py-1.5 text-xs text-muted shadow-lg shadow-black/40",
            "group-hover:block group-focus-within:block",
          )}
        >
          <span className="font-mono tabular-nums text-text">
            {reserved.toLocaleString("en-GB")}
          </span>{" "}
          reserved for running tasks
        </span>
      ) : null}

      {/* The screen-reader text always carries both numbers (color and
          hover are never the only signals). */}
      <span id={detailId} className="sr-only">
        {exhausted
          ? "No Shera credits remaining. An administrator top-up resumes paused runs."
          : reserved > 0
            ? `${account.remaining_units} Shera credits remaining, ${reserved} reserved for running tasks.`
            : `${account.remaining_units} Shera credits remaining.`}
      </span>
    </Link>
  );
}

/** The composed pill: the container's readiness gates it (nothing renders —
 * never a fabricated balance, G4); the ledger summary feeds the view. */
export function CreditsPill({ workspaceId }: { workspaceId: string | null }) {
  const catalog = useCreditsSummary(workspaceId ?? "");
  if (workspaceId === null) return null;
  if (catalog.state !== "ready" || catalog.summary === null) return null;
  const account = catalog.summary.account;
  if (account === null) return null; // Not provisioned yet — the settings surface explains.
  return <CreditsPillView account={account} />;
}
