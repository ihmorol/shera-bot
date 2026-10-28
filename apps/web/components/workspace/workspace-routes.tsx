"use client";

import { useRouter } from "next/navigation";
import type { ReactElement } from "react";

import { ContainerGate } from "@/components/shell/container-gate";
import { BackToChatButton, WorkspacePanelHost } from "@/components/workspace/workspace-panel";
import { useContainerResolution } from "@/lib/container-connection";
import { routes } from "@/lib/routes";

/**
 * The per-conversation workspace route surfaces (UI_DESIGN §3.1 S7): the
 * inline variant renders the panel body standalone (deep link), the full-page
 * variant adds the Back-to-chat chrome and more width. Both mount only once
 * the container gate reports the workspace ready — the gate owns the honest
 * lifecycle states; a panel that reads a workspace it cannot resolve is a
 * guaranteed typed failure pretending to be app state (G4).
 */

/**
 * "Back to chat": in-app history back when this session navigated here;
 * the dashboard is the honest fallback for a fresh deep link. The panel
 * state itself is persisted per conversation, so returning to the chat
 * restores the prior width and membership either way.
 */
export function goBackToChat(router: ReturnType<typeof useRouter>): void {
  if (typeof window !== "undefined" && window.history.length > 1) {
    router.back();
    return;
  }
  router.push(routes.app());
}

/** The ready-only wrapper shared by both route surfaces. */
function ReadyWorkspace({
  children,
}: {
  children: (workspaceId: string) => ReactElement;
}): ReactElement {
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  if (readyWorkspaceId === null) {
    return <ContainerGate>{null}</ContainerGate>;
  }
  return children(readyWorkspaceId);
}

/** The inline route: the per-conversation panel at full height of the surface. */
export function WorkspaceInlineSurface({ chatId }: { chatId: string }): ReactElement {
  return (
    <ReadyWorkspace>
      {(workspaceId) => (
        <div className="h-full min-h-0">
          <WorkspacePanelHost chatId={chatId} workspaceId={workspaceId} presentation="page" />
        </div>
      )}
    </ReadyWorkspace>
  );
}

/** The full-page route: same tabs, more width, Back-to-chat chrome. */
export function WorkspaceFullSurface({ chatId }: { chatId: string }): ReactElement {
  const router = useRouter();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 lg:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            Workspace
          </h1>
          <p className="truncate font-mono text-xs text-muted">Conversation {chatId} · full page</p>
        </div>
        <BackToChatButton onBack={() => goBackToChat(router)} />
      </header>
      <ReadyWorkspace>
        {(workspaceId) => (
          <div className="min-h-0 flex-1">
            <WorkspacePanelHost chatId={chatId} workspaceId={workspaceId} presentation="page" />
          </div>
        )}
      </ReadyWorkspace>
    </div>
  );
}
