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
 * S2 dashboard, behind the S09 container gate. UI_DESIGN §3.1: "redirects to
 * last chat or Agent empty state". The gate resolves the signed-in user's
 * workspace → container first (S05 session + S06 provisioning) and surfaces
 * the lifecycle honestly — the one-time "prepare your workspace" step is an
 * explicit action here, never part of sign-in (owner-call disclosure, S09
 * PR). Owner direction (2026-11-20): the ready state stays minimal — one
 * primary action (start an Operation) and at most one secondary (a direct
 * chat); the conversation list lives in the sidebar.
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
        explanation="Pick up a chat from the sidebar, or start a pack-defined Operation."
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href={routes.operationNew()}>New Operation</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={routes.agent(firstAgent.slug)}>Chat with {firstAgent.name}</Link>
            </Button>
          </div>
        }
      />
    </SurfaceFrame>
  );
}
