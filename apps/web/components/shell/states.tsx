import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * §2.4 state language shared by the data surfaces (sidebar, chat list,
 * thread): layout-matched loading skeletons (never spinners) and the error
 * state — a redacted `safe_message` only, with retry when the failure is
 * retryable (D23 rule 4: internal details never render).
 *
 * The fixture-backed demo has no async surface, so nothing renders these
 * during the demo; tests exercise them and the runtime-backed pass mounts
 * them unchanged.
 */

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded bg-surface-elevated", className)}
    />
  );
}

/** Sidebar skeleton mirroring §3.2: chrome row, Agents rows, Operations rows. */
export function SidebarSkeleton() {
  return (
    <div aria-hidden="true" data-testid="sidebar-skeleton" className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <SkeletonBlock className="h-5 w-28" />
        <SkeletonBlock className="size-4" />
      </div>
      <div className="h-px bg-line" />
      <div className="flex-1 px-2 py-4">
        <SkeletonBlock className="mx-3 mb-3 h-3 w-16" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={`agent-${index}`} className="flex items-center gap-3 px-3 py-2">
            <SkeletonBlock className="size-6 rounded-full" />
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-3 w-28" />
              <SkeletonBlock className="mt-1.5 h-2.5 w-40" />
            </div>
            <SkeletonBlock className="h-4 w-6 rounded-full" />
          </div>
        ))}
        <SkeletonBlock className="mx-3 mb-3 mt-5 h-3 w-20" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={`operation-${index}`} className="flex items-center gap-3 px-3 py-2">
            <SkeletonBlock className="size-4" />
            <SkeletonBlock className="h-3 w-36" />
          </div>
        ))}
      </div>
      <div className="h-px bg-line" />
      <div className="px-4 py-3">
        <SkeletonBlock className="h-3 w-24" />
      </div>
    </div>
  );
}

/** Chat-list skeleton (list rows with avatar, two lines, trailing pill). */
export function ChatListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-list-skeleton"
      className="flex flex-col gap-3 px-4 py-6 lg:px-6"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <SkeletonBlock className="size-8 rounded-full" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-3 w-32" />
            <SkeletonBlock className="mt-1.5 h-2.5 w-48" />
          </div>
          <SkeletonBlock className="h-4 w-6 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Error state: renders the redacted `safe_message` only — internal errors,
 * stack traces, and header dumps never reach the screen (§7, D23 rule 4).
 * Retry appears only when the caller marks the failure retryable.
 */
export function ErrorState({
  safeMessage,
  onRetry,
}: {
  safeMessage: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div
      role="alert"
      className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
    >
      <AlertTriangle className="size-5 text-failed" aria-hidden="true" />
      <p className="text-sm text-text">{safeMessage}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
