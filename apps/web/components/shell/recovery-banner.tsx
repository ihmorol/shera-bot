import { ClipboardCheck, CircleCheck, RefreshCw } from "lucide-react";
import Link from "next/link";

import { RECOVERY_BANNER_COPY, RESUMED_BANNER_COPY } from "@/lib/recovery-copy";

/**
 * Recovery banner (S31 chunk 4; UI_DESIGN S11, PRD §13) — the top-of-app
 * strip the global chrome renders while the workspace is recovering or a
 * task needs review. Three states from D32:
 *
 *  - `recovering` — "Restoring your workspace…" (polite status; the boot
 *    recovery pass is in flight);
 *  - `resumed` — the transient confirmation naming the last-safe-step basis;
 *  - `review_needed` — "A task needs your review" with the deep link to the
 *    Operation holding the RECOVERY_REQUIRED run.
 *
 * §2.3: color never the only signal — each state pairs its icon with its
 * text; the review state announces politely (a banner is a status, the
 * review page is the action). Idle renders NOTHING (no chrome without
 * content). A strip, never a modal — reading stays possible through
 * recovery, the same posture as the §6.4 connection banner.
 */
export function RecoveryBanner({
  state,
  reviewCount,
  resumedCount,
  reviewHref,
}: {
  state: "recovering" | "resumed" | "review_needed" | "idle";
  /** How many runs are RECOVERY_REQUIRED (the review state's count). */
  reviewCount?: number | undefined;
  /** How many runs the last boot resumed (the resumed state's count). */
  resumedCount?: number | undefined;
  /** The deep link to the review surface (the review state's action). */
  reviewHref?: string | undefined;
}) {
  if (state === "idle") return null;

  if (state === "review_needed") {
    return (
      <div
        role="status"
        data-recovery-banner="review_needed"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-approval lg:px-6"
      >
        <ClipboardCheck className="size-4 shrink-0" aria-hidden="true" />
        <p>
          {RECOVERY_BANNER_COPY.review}
          {typeof reviewCount === "number" && reviewCount > 1 ? ` (${reviewCount} tasks)` : ""}
          {" — a paused step could not be proven safe to replay."}
        </p>
        {reviewHref ? (
          // The global :focus-visible rule is the single focus treatment
          // (§2.3 — the a11y suite pins it); this link declares none of its own.
          <Link
            href={reviewHref}
            data-testid="recovery-banner-review-link"
            className="rounded-md border border-approval/40 px-2 py-0.5 text-xs text-approval hover:border-approval hover:bg-surface-elevated"
          >
            Review the task
          </Link>
        ) : null}
      </div>
    );
  }

  if (state === "recovering") {
    return (
      <div
        role="status"
        data-recovery-banner="recovering"
        aria-busy="true"
        className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-sky lg:px-6"
      >
        <RefreshCw className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        <p aria-live="polite">{RECOVERY_BANNER_COPY.recovering}</p>
      </div>
    );
  }

  const count =
    typeof resumedCount === "number" && resumedCount > 0 ? ` (${resumedCount} resumed)` : "";
  return (
    <div
      role="status"
      data-recovery-banner="resumed"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-live lg:px-6"
    >
      <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
      <p aria-live="polite">
        {RESUMED_BANNER_COPY}
        {count}
      </p>
    </div>
  );
}
