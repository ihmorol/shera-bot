import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { routes } from "@/lib/routes";

/**
 * §2.4 not-found state: one-line explanation plus the single most likely
 * next action. Unknown Agent/Operation slugs reach this through notFound() —
 * the six pack Agents and the seeded Operations are the enumerable demo
 * roster (§3.1), so the only useful recovery is back to the conversations.
 */
export default function NotFoundPage() {
  return (
    <main className="flex h-dvh flex-col">
      <SurfaceFrame title="Page not found">
        <EmptyState
          explanation="This page does not exist in the demo build. Conversations and Operations live in the sidebar."
          action={
            <Link
              href={routes.app()}
              className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
            >
              Back to conversations
            </Link>
          }
        />
      </SurfaceFrame>
    </main>
  );
}
