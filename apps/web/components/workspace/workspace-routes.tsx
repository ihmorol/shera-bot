"use client";

import { useRouter } from "next/navigation";
import { useCallback, useSyncExternalStore, type ReactElement } from "react";

import { ContainerGate } from "@/components/shell/container-gate";
import { BackToChatButton, WorkspacePanelHost } from "@/components/workspace/workspace-panel";
import type { WorkspaceTabId } from "@/components/workspace/panel-tabs";
import { useContainerResolution } from "@/lib/container-connection";
import { routes } from "@/lib/routes";
import { clearWorkspaceFullMarker, workspaceFullBackMarkerKey } from "@/lib/workspace-panel";

/**
 * The per-conversation workspace route surfaces (UI_DESIGN §3.1 S7): the
 * inline variant renders the panel body standalone (deep link), the full-page
 * variant adds the Back chrome and more width. Both mount only once the
 * container gate reports the workspace ready — the gate owns the honest
 * lifecycle states; a panel that reads a workspace it cannot resolve is a
 * guaranteed typed failure pretending to be app state (G4).
 */

/**
 * "Back to chat": history back when THIS SESSION navigated here (the chat-
 * header toggle marks it), the dashboard push for a fresh deep link — the
 * deep-link back would exit the app, so the affordance says what it does.
 * The panel state itself is persisted per conversation, so the chat restores
 * the prior width and membership either way.
 */
export function goBackToChat(router: ReturnType<typeof useRouter>, chatId: string): void {
  if (
    typeof window !== "undefined" &&
    window.sessionStorage.getItem(workspaceFullBackMarkerKey(chatId)) === "1"
  ) {
    clearWorkspaceFullMarker(chatId);
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

/**
 * Whether THIS SESSION opened the full page in-app (the chat-header toggle
 * marks the session; a fresh deep link carries no mark). Read through
 * useSyncExternalStore so SSR/hydration renders the deep-link default and the
 * client corrects once the session mark is readable — the first paint never
 * guesses, and no effect-driven cascade re-render.
 */
const noopSubscribe = () => () => undefined;

export function useWorkspaceFullOpenedInApp(chatId: string): boolean {
  const getSnapshot = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(workspaceFullBackMarkerKey(chatId)) === "1",
    [chatId],
  );
  return useSyncExternalStore(noopSubscribe, getSnapshot, () => false);
}

/** The full-page route: same tabs, more width, the state-aware Back chrome.
 * The active tab is deep-linkable (F3): the route validates ?tab= into
 * initialTab, and in-panel switches are reflected back into the URL with a
 * replace — no history spam, no scroll jump, and the URL always names the
 * tab you are looking at. */
export function WorkspaceFullSurface({
  chatId,
  initialTab,
}: {
  chatId: string;
  initialTab?: WorkspaceTabId;
}): ReactElement {
  const router = useRouter();
  const cameFromApp = useWorkspaceFullOpenedInApp(chatId);
  const onTabChange = useCallback(
    (tab: WorkspaceTabId) => {
      router.replace(`${routes.workspaceFull(chatId)}?tab=${tab}`, { scroll: false });
    },
    [router, chatId],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 lg:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            Workspace
          </h1>
          <p className="truncate font-mono text-xs text-muted">Conversation {chatId} · full page</p>
        </div>
        <BackToChatButton cameFromApp={cameFromApp} onBack={() => goBackToChat(router, chatId)} />
      </header>
      <ReadyWorkspace>
        {(workspaceId) => (
          <div className="min-h-0 flex-1">
            <WorkspacePanelHost
              chatId={chatId}
              workspaceId={workspaceId}
              presentation="page"
              initialTab={initialTab}
              onTabChange={onTabChange}
            />
          </div>
        )}
      </ReadyWorkspace>
    </div>
  );
}
