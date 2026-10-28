"use client";

import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";

import { FilesTab } from "@/components/workspace/files-tab";
import { EditorTab } from "@/components/workspace/editor-tab";
import { ArtifactsTab } from "@/components/workspace/artifacts-tab";
import { BrowserTab } from "@/components/workspace/browser-tab";
import { PrivateFilesTab } from "@/components/workspace/private-files-tab";
import { TerminalTab } from "@/components/workspace/terminal-tab";
import { TabStrip, type WorkspaceTabId } from "@/components/workspace/panel-tabs";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  browserPanelStorage,
  initialPanelState,
  isMobileViewport,
  loadPanelPrefs,
  markWorkspaceFullOpened,
  mobileViewportQuery,
  panelReducer,
  prefsFromState,
  savePanelPrefs,
  type PanelState,
} from "@/lib/workspace-panel";

/**
 * The workspace panel host (UI_DESIGN §4 S7, §2.2 docked states). The docked
 * panel mounts INTO the app shell's reserved workspace region (the S08
 * react-resizable-panels group): the library owns the physical resize (one
 * separator handle — pointer drag AND the built-in ARIA splitter keyboard —
 * so conflicting simultaneous control is impossible by construction), this
 * host owns the semantic states (0 → 360px → 50% via the chat-header toggle,
 * full-page as a route) and the per-conversation persistence (localStorage
 * keyed by the chat id — the first client-persisted preference in apps/web).
 *
 * Below 768px the docked panel renders as a bottom sheet instead (§2.2
 * mobile shell); the full-page route renders the same body standalone
 * (components/workspace/workspace-routes.tsx).
 */

export type PanelPresentation = "docked" | "page";

// ---------------------------------------------------------------------------
// Provider — the single controller behind the shell region, the chat-header
// toggle, and the mobile sheet. Conversations register (chat id + workspace
// id) while mounted; the panel shows the registered conversation's body.
// ---------------------------------------------------------------------------

interface PanelRegistration {
  chatId: string;
  workspaceId: string;
  /**
   * The conversation's Agent (S18): the terminal live view is PER-AGENT —
   * the journal streams and the terminal API are agent-scoped. Direct chats
   * always bind one; a null keeps the terminal tab honest (it shows that no
   * Agent is bound instead of guessing one, G4).
   */
  agentId: string | null;
}

interface WorkspacePanelContextValue {
  registration: PanelRegistration | null;
  register: (registration: PanelRegistration | null) => void;
  state: PanelState;
  mobile: boolean;
  isOpen: boolean;
  /** Wire the shell's Panel to the controller (imperative handle + resize reports). */
  panelRef: (handle: PanelImperativeHandle | null) => void;
  handlePanelResize: (size: PanelSize) => void;
  /** The chat-header toggle cycle: closed → 360px → 50% → full-page request. */
  chatHeaderToggle: (onOpenFullPage?: () => void) => void;
  close: () => void;
}

const WorkspacePanelContext = createContext<WorkspacePanelContextValue | null>(null);

export function WorkspacePanelHostProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, dispatch] = useReducer(panelReducer, undefined, initialPanelState);
  const [registration, setRegistration] = useState<PanelRegistration | null>(null);
  const [mobile, setMobile] = useState(false);
  const panelHandle = useRef<PanelImperativeHandle | null>(null);
  /** The last width the library reported — commands skip when already applied. */
  const reportedWidth = useRef<number | null>(null);
  const hydratedChatId = useRef<string | null>(null);

  // Viewport + mobile probes.
  useEffect(() => {
    const query = mobileViewportQuery();
    const update = () => setMobile(query !== null && isMobileViewport(query));
    update();
    query?.addEventListener("change", update);
    return () => {
      query?.removeEventListener("change", update);
    };
  }, []);

  // Hydrate the registered conversation's persisted width + membership once
  // per chat (the SSR default stays closed — the first paint never guesses).
  useEffect(() => {
    if (registration === null || registration.chatId === hydratedChatId.current) return;
    hydratedChatId.current = registration.chatId;
    reportedWidth.current = null;
    const storage = browserPanelStorage();
    const prefs = storage === null ? null : loadPanelPrefs(registration.chatId, storage);
    dispatch({
      type: prefs?.open ? "open" : "close",
      viewportWidth: window.innerWidth,
      ...(prefs?.open ? { preferredWidth: prefs.width } : {}),
    });
  }, [registration]);

  // Geometry follows the semantic state — unless the library already applied
  // exactly that width (its own drag reports land here as no-ops, so the
  // handle and the commands can never fight over the geometry).
  useEffect(() => {
    const handle = panelHandle.current;
    if (handle === null || mobile) return;
    if (state.widthState.kind === "closed") {
      handle.collapse();
      return;
    }
    if (state.widthState.width === reportedWidth.current) return;
    handle.resize(`${state.widthState.width}px`);
  }, [state, mobile]);

  // Persist after hydration. setWidth arrives from the library's resize
  // reports (committed sizes); a drag's frames are cheap localStorage writes
  // on a panel-scoped key.
  useEffect(() => {
    if (registration === null || registration.chatId !== hydratedChatId.current) return;
    const storage = browserPanelStorage();
    if (storage !== null) {
      savePanelPrefs(registration.chatId, prefsFromState(state), storage);
    }
  }, [registration, state]);

  // Leaving a conversation (or landing on a non-chat route) releases the
  // panel — no conversation owns it, so it closes.
  useEffect(() => {
    if (registration === null) {
      hydratedChatId.current = null;
      reportedWidth.current = null;
      dispatch({ type: "close" });
    }
  }, [registration]);

  const handlePanelResize = useCallback((size: PanelSize) => {
    const width = Math.round(size.inPixels);
    reportedWidth.current = width;
    // When the panel is collapsed (0px) the reducer ignores the sub-floor
    // width — the closed state is semantic, not a width.
    dispatch({ type: "setWidth", width });
  }, []);

  const chatHeaderToggle = useCallback((onOpenFullPage?: () => void) => {
    dispatch({
      type: "chatHeaderToggle",
      viewportWidth: window.innerWidth,
      ...(onOpenFullPage !== undefined ? { onOpenFullPage } : {}),
    });
  }, []);

  return (
    <WorkspacePanelContext.Provider
      value={{
        registration,
        register: setRegistration,
        state,
        mobile,
        isOpen: state.widthState.kind === "inline",
        panelRef: (handle) => {
          panelHandle.current = handle;
        },
        handlePanelResize,
        chatHeaderToggle,
        close: () => dispatch({ type: "close" }),
      }}
    >
      {children}
      {mobile && registration !== null && state.widthState.kind === "inline" ? (
        <WorkspaceBottomSheet
          workspaceId={registration.workspaceId}
          agentId={registration.agentId}
        />
      ) : null}
    </WorkspacePanelContext.Provider>
  );
}

function useWorkspacePanelHost(): WorkspacePanelContextValue {
  const value = useContext(WorkspacePanelContext);
  if (value === null) {
    throw new Error("Workspace panel surfaces must render inside WorkspacePanelHostProvider.");
  }
  return value;
}

/**
 * The shell's Panel wiring: pass `panelRef` and `onResize` straight through
 * to the reserved workspace Panel so the controller drives (and learns from)
 * the library's geometry.
 */
export function useWorkspacePanelRegionWiring(): {
  panelRef: (handle: PanelImperativeHandle | null) => void;
  handlePanelResize: (size: PanelSize) => void;
} {
  const host = useWorkspacePanelHost();
  return { panelRef: host.panelRef, handlePanelResize: host.handlePanelResize };
}

/**
 * The conversation-side registration hook: mounts/unmounts the chat's panel
 * membership. Call with the conversation id (and the conversation's Agent,
 * S18) once the direct-chat binding resolves; while it is null the panel is
 * released (never a half-registered control).
 */
export function useWorkspacePanelRegistration(
  chatId: string | null,
  workspaceId: string | null,
  agentId: string | null = null,
): void {
  const register = useWorkspacePanelHost().register;
  const key =
    chatId !== null && workspaceId !== null
      ? `${chatId}\u0000${workspaceId}\u0000${agentId}`
      : null;
  useEffect(() => {
    if (key === null || chatId === null || workspaceId === null) {
      register(null);
      return;
    }
    register({ chatId, workspaceId, agentId });
    return () => {
      register(null);
    };
  }, [key, chatId, workspaceId, agentId, register]);
}

/** The shell's reserved workspace region renders this inside its Panel. */
export function WorkspacePanelSlot(): ReactElement {
  const { registration, state, mobile, close } = useWorkspacePanelHost();
  if (mobile || registration === null || state.widthState.kind !== "inline") {
    // The region stays an honest reserved slot — nothing pretends to be open.
    return <div aria-hidden="true" />;
  }
  return (
    <WorkspacePanelBody
      workspaceId={registration.workspaceId}
      agentId={registration.agentId}
      onClose={close}
    />
  );
}

/** The §2.2 mobile shell: the panel becomes a fixed bottom sheet with a grab handle. */
function WorkspaceBottomSheet({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string | null;
}): ReactElement {
  const { close } = useWorkspacePanelHost();
  return (
    <div
      data-testid="workspace-panel-sheet"
      role="complementary"
      aria-label="Workspace panel"
      className="animate-sheet-up fixed inset-x-0 bottom-0 z-40 flex h-[70vh] flex-col rounded-t-2xl border-t border-line bg-surface shadow-[0_-16px_48px_rgba(0,0,0,0.5)]"
    >
      <div
        className="flex shrink-0 cursor-grab justify-center rounded-t-2xl py-2"
        aria-hidden="true"
      >
        <span className="h-1 w-10 rounded-full bg-line" />
      </div>
      <div className="min-h-0 flex-1">
        <WorkspacePanelBody workspaceId={workspaceId} agentId={agentId} onClose={close} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel body — tab strip + active tab (shared by every presentation)
// ---------------------------------------------------------------------------

export function WorkspacePanelBody({
  workspaceId,
  agentId = null,
  onClose,
  className,
  initialTab,
  onTabChange,
}: {
  workspaceId: string;
  /**
   * The conversation's Agent binding (S18) — the Terminal tab's stream scope.
   * Defaults to null: a surface that cannot bind an Agent gets the honest
   * unbound terminal state, never a guessed stream.
   */
  agentId?: string | null | undefined;
  onClose?: (() => void) | undefined;
  className?: string | undefined;
  /** The deep-linked initial tab (F3): the full-page route validates ?tab= and passes it down; absent → Files. */
  initialTab?: WorkspaceTabId | undefined;
  /** Optional URL sync hook (F3): the full-page surface reflects switches via router.replace; the docked panel has none. */
  onTabChange?: ((tab: WorkspaceTabId) => void) | undefined;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>(initialTab ?? "files");
  const changeTab = (id: WorkspaceTabId) => {
    setActiveTab(id);
    onTabChange?.(id);
  };
  return (
    <section
      aria-label="Workspace panel"
      className={cn("flex h-full min-h-0 flex-col bg-surface", className)}
    >
      <div className="flex shrink-0 items-stretch border-b border-line">
        <TabStrip active={activeTab} onChange={changeTab} className="min-w-0 flex-1 border-b-0" />
        {onClose ? (
          <button
            type="button"
            aria-label="Close workspace panel"
            title="Close workspace panel"
            onClick={onClose}
            className="shrink-0 border-l border-line px-2.5 text-muted transition-colors duration-150 hover:bg-surface-elevated hover:text-text"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {activeTab === "files" ? (
          <FilesTab workspaceId={workspaceId} />
        ) : activeTab === "editor" ? (
          <EditorTab workspaceId={workspaceId} />
        ) : activeTab === "terminal" ? (
          <TerminalTab workspaceId={workspaceId} agentId={agentId} />
        ) : activeTab === "browser" ? (
          <BrowserTab workspaceId={workspaceId} />
        ) : activeTab === "private" ? (
          <PrivateFilesTab workspaceId={workspaceId} />
        ) : (
          <ArtifactsTab workspaceId={workspaceId} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The chat header toggle (S7 entry) + the standalone route host
// ---------------------------------------------------------------------------

/** The S7 entry: the chat header's workspace toggle (0 → 360 → 50% → full page). */
export function WorkspacePanelToggle({ chatId }: { chatId: string }): ReactElement {
  const host = useWorkspacePanelHost();
  const router = useRouter();
  const { mobile, isOpen } = host;
  return (
    <button
      type="button"
      aria-pressed={isOpen}
      aria-label={isOpen ? "Close the workspace panel" : "Open the workspace panel"}
      title="Workspace"
      onClick={() => {
        if (mobile) {
          // The sheet has no width states — open/close only.
          if (isOpen) host.close();
          else host.chatHeaderToggle();
          return;
        }
        host.chatHeaderToggle(() => {
          markWorkspaceFullOpened(chatId);
          router.push(routes.workspaceFull(chatId));
        });
      }}
      className={cn(
        "shrink-0 rounded-lg p-2 transition-colors duration-150 hover:bg-surface-elevated",
        isOpen ? "text-sky" : "text-muted hover:text-text",
      )}
    >
      {isOpen ? (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * The full-page header's Back control. The copy is state-aware (chunk 5 craft
 * fix): the in-app open path marks the session, so an in-app arrival says
 * "Back to chat" and goes back; a fresh deep link says "Go to dashboard" and
 * MEANS it (history back there would exit the app).
 */
export function BackToChatButton({
  cameFromApp,
  onBack,
}: {
  cameFromApp: boolean;
  onBack: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onBack}
      className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-text transition-colors duration-150 hover:border-line-accent hover:bg-surface-elevated"
    >
      {cameFromApp ? "Back to chat" : "Go to dashboard"}
    </button>
  );
}

/**
 * The standalone per-conversation panel body host (the deep-linkable route
 * surfaces render this — same tabs, full width, no dock chrome). The
 * full-page surface passes the deep-linked initial tab (F3) and owns the URL
 * sync for in-panel switches; the inline route renders the default Files tab.
 */
export function WorkspacePanelHost({
  workspaceId,
  agentId = null,
  initialTab,
  onTabChange,
}: {
  chatId: string;
  workspaceId: string;
  presentation: PanelPresentation;
  /** The S18 Agent binding for the Terminal tab (absent on deep links → the honest unbound state). */
  agentId?: string | null | undefined;
  initialTab?: WorkspaceTabId | undefined;
  onTabChange?: ((tab: WorkspaceTabId) => void) | undefined;
}): ReactElement {
  return (
    <div data-testid="workspace-panel-page" className="h-full min-h-0">
      <WorkspacePanelBody
        workspaceId={workspaceId}
        agentId={agentId}
        initialTab={initialTab}
        onTabChange={onTabChange}
      />
    </div>
  );
}
