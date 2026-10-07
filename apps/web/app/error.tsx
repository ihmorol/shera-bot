"use client";

import { ErrorState } from "@/components/shell/states";

/**
 * Route error boundary (§2.4, D23 rule 4): a redacted safe message with a
 * retry action. The framework error object — message, stack, digest — never
 * renders; internal details stay out of the UI. `reset` re-renders the
 * failed segment. Next.js replaces the segment content inside the root
 * layout, so the §2.1 token layer still carries the surface.
 */
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex h-dvh items-center justify-center px-4 py-8">
      <ErrorState
        safeMessage="Something went wrong loading this surface. You can retry."
        onRetry={reset}
      />
    </main>
  );
}
