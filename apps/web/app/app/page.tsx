import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { Button } from "@/components/ui/button";
import { PACK_AGENTS } from "@/lib/navigation";
import { routes } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * S2 dashboard. UI_DESIGN §3.1: "redirects to last chat or Agent empty state".
 * The last-conversation redirect needs conversation fixtures (UI_DESIGN §9) —
 * until that chunk lands, this renders the empty Agent state honestly.
 */
export default function DashboardPage() {
  const firstAgent = PACK_AGENTS[0];
  if (!firstAgent) {
    // Unreachable: the pack seed is asserted to contain six Agents.
    throw new Error("Pack seed is empty");
  }

  return (
    <SurfaceFrame title="Pick a conversation">
      <EmptyState
        explanation="Pick an Agent to start a conversation, or launch a pack-defined Operation from the sidebar."
        action={
          <Button asChild>
            <Link href={routes.agent(firstAgent.slug)}>Chat with {firstAgent.name}</Link>
          </Button>
        }
      />
    </SurfaceFrame>
  );
}
