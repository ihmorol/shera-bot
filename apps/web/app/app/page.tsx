import type { Metadata } from "next";
import Link from "next/link";

import { ContainerGate } from "@/components/shell/container-gate";
import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { Button } from "@/components/ui/button";
import { PACK_AGENTS } from "@/lib/navigation";
import { routes } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * S2 dashboard, behind the S09 container gate. UI_DESIGN §3.1: "redirects to
 * last chat or Agent empty state". The gate resolves the signed-in user's
 * workspace → container first (S05 session + S06 provisioning) and surfaces
 * the lifecycle honestly — the one-time "prepare your workspace" step is an
 * explicit action here, never part of sign-in (owner-call disclosure, S09
 * PR). A ready workspace renders the dashboard, which for now is the empty
 * Agent state; the last-conversation redirect needs the real conversation
 * index (later chunk).
 */
export default function DashboardPage() {
  const firstAgent = PACK_AGENTS[0];
  if (!firstAgent) {
    // Unreachable: the pack seed is asserted to contain six Agents.
    throw new Error("Pack seed is empty");
  }

  return (
    <ContainerGate>
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
    </ContainerGate>
  );
}
