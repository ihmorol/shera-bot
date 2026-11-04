"use client";

import { useQuery } from "@tanstack/react-query";

import { RecoveryBanner } from "@/components/shell/recovery-banner";
import { fetchSession } from "@/lib/control-plane-client";
import { routes } from "@/lib/routes";
import { useRecoveryStatus } from "@/lib/recovery-data";

/**
 * The recovery banner host (S31 chunk 4; UI_DESIGN S11) — the client bridge
 * between the composed runtime's recovery status read and the S11 strip the
 * app layout mounts top-of-app. A failed read renders NO banner: the §6.4
 * connection banner owns transport failure, and the surface never guesses a
 * recovery state it cannot read (G4).
 *
 * State precedence is the runtime's own answer (`workspace_state`): the
 * review link deep-links to the Operation holding the RECOVERY_REQUIRED run.
 */
export function RecoveryBannerHost() {
  const session = useQuery({
    queryKey: ["session", "recovery-banner"],
    queryFn: fetchSession,
    staleTime: 60_000,
    retry: false,
  });
  const workspaceId = session.data?.workspace_id;
  const status = useRecoveryStatus(workspaceId);

  if (!workspaceId || !status.data) return null;
  const data = status.data;

  if (data.workspace_state === "review_needed") {
    const first = data.review_needed[0];
    return (
      <RecoveryBanner
        state="review_needed"
        reviewCount={data.review_needed.length}
        reviewHref={first ? routes.operation(first.operation_id) : undefined}
      />
    );
  }
  if (data.workspace_state === "recovering") {
    return <RecoveryBanner state="recovering" />;
  }
  if (data.workspace_state === "resumed") {
    return <RecoveryBanner state="resumed" resumedCount={data.resumed.length} />;
  }
  return null;
}
