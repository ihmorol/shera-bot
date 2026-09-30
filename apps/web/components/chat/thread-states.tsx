import { EmptyState } from "@/components/shell/surface-frame";

/**
 * §2.4 state language for the chat thread: a loading skeleton that matches
 * the final layout (never a spinner), the empty state (one-line explanation
 * + the most likely next action), and an error state carrying a redacted
 * `safe_message` with retry when retryable (D23 rule 4).
 *
 * The fixture-backed demo has no async surface, so these render under the
 * explicit `surfaceState` prop of AgentChatView (tests exercise them; the
 * runtime-backed pass reuses them unchanged).
 */

function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-surface-elevated ${className ?? ""}`} />;
}

function SkeletonAgentRow({ width }: { width: string }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <SkeletonBlock className="size-6 rounded-full" />
        <SkeletonBlock className="h-3 w-24" />
      </div>
      <SkeletonBlock className={`h-10 ${width} rounded-2xl rounded-tl-sm`} />
    </div>
  );
}

function SkeletonUserRow({ width }: { width: string }) {
  return (
    <div className="flex flex-col items-end gap-2">
      <SkeletonBlock className={`h-10 ${width} rounded-2xl rounded-br-sm`} />
      <SkeletonBlock className="h-3 w-16" />
    </div>
  );
}

/** Layout-matched thread skeleton: bubbles, a card row, and the composer. */
export function ThreadSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-6 lg:px-6">
      <SkeletonUserRow width="w-2/3" />
      <SkeletonAgentRow width="w-3/4" />
      <SkeletonAgentRow width="w-1/2" />
      <div className="w-full max-w-xl rounded-xl border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <SkeletonBlock className="size-4" />
          <SkeletonBlock className="h-3 w-32" />
        </div>
        <SkeletonBlock className="mt-2 h-3 w-full" />
      </div>
      <SkeletonUserRow width="w-1/2" />
    </div>
  );
}

/** §S3 empty thread: "Say hello — {Agent} is ready." */
export function EmptyThread({ agentName }: { agentName: string }) {
  return (
    <div className="min-h-0 flex-1">
      <EmptyState explanation={`Say hello — ${agentName} is ready.`} />
    </div>
  );
}
