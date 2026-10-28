"use client";

import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";

import { FilesTab } from "@/components/workspace/files-tab";
import {
  TabComingSoon,
  TabStrip,
  WORKSPACE_TABS,
  type WorkspaceTabId,
} from "@/components/workspace/panel-tabs";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  browserPanelStorage,
  initialPanelState,
  isMobileViewport,
  loadPanelPrefs,
  mobileViewportQuery,
  panelMaxWidth,
  panelReducer,
  prefsFromState,
  savePanelPrefs,
  type PanelState,
} from "@/lib/workspace-panel";

/**
 * The workspace panel host (UI_DESIGN §4 S7, §2.2 docked states; the resize/
 * collapse interaction model reimplemented from mockup/REFERENCE.md §8).
 *
 * Three presentations:
 * - "docked" — the per-conversation panel beside the chat: 0 → 360px → 50%
 *   inline states with a resizable, keyboard-operable divider; below 768px it
 *   renders as a bottom sheet instead (§2.2 mobile shell).
 * - "page" — the full-page route body (deep-linkable); same tabs, more width,
 *   no divider.
 *
 * Resize is single-owner (the reducer ignores keyboard actions while a pointer
 * drag holds the capture and vice versa); width + membership persist per
 * conversation (localStorage keyed by the chat id — the first client-persisted
 * preference in apps/web, seam owned by lib/workspace-panel.ts). The route
 * surfaces live in components/workspace/workspace-routes.tsx.
 */

export type PanelPresentation = "docked" | "page";

// ---------------------------------------------------------------------------
// Controller — the reducer + viewport probes + per-conversation persistence.
// The chat header toggle needs the SAME state the dock renders, so the hook
// is exported and both the toggle (in the chat surface) and the dock consume it.
// ---------------------------------------------------------------------------

export type PanelDispatch = (action: PanelAction) => void;

export type PanelAction =
  | { type: "open"; viewportWidth: number; preferredWidth?: number }
  | { type: "close" }
  | { type: "chatHeaderToggle"; viewportWidth: number; onOpenFullPage?: () => void }
  | { type: "showHalf"; viewportWidth: number }
  | { type: "reset"; viewportWidth: number }
  | { type: "dragStart"; pointerX: number; viewportWidth: number }
  | { type: "dragMove"; pointerX: number }
  | { type: "dragEnd" }
  | { type: "dragCancel" }
  | {
      type: "keyboardResize";
      direction: "widen" | "narrow";
      large?: boolean;
      viewportWidth: number;
    }
  | { type: "keyboardMin" }
  | { type: "keyboardMax"; viewportWidth: number }
  | { type: "keyboardReset" };

export interface WorkspacePanelController {
  state: PanelState;
  viewportWidth: number;
  mobile: boolean;
  isOpen: boolean;
  width: number;
  toggle: (onOpenFullPage?: () => void) => void;
  open: () => void;
  close: () => void;
  dispatch: PanelDispatch;
}

export function useWorkspacePanelController(
  chatId: string | null,
  options?: { enabled?: boolean },
): WorkspacePanelController {
  const enabled = options?.enabled ?? true;
  const [state, dispatch] = useReducer(panelReducer, undefined, initialPanelState);
  const [viewportWidth, setViewportWidth] = useState(1440);
  const [mobile, setMobile] = useState(false);
  const hydrated = useRef(false);

  // Viewport + mobile probes (a window resize cancels an active drag per the
  // dock — the reducer's clamp ceiling is resolved at dragStart).
  useEffect(() => {
    if (!enabled) return;
    const measure = () => setViewportWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    const query = mobileViewportQuery();
    const update = () => setMobile(query !== null && isMobileViewport(query));
    update();
    query?.addEventListener("change", update);
    return () => {
      window.removeEventListener("resize", measure);
      query?.removeEventListener("change", update);
    };
  }, [enabled]);

  // Hydrate this conversation's persisted width + membership ONCE (the SSR
  // default stays closed — the first paint never guesses, it reads).
  useEffect(() => {
    if (!enabled || chatId === null) return;
    const storage = browserPanelStorage();
    if (storage === null) return;
    const prefs = loadPanelPrefs(chatId, storage);
    if (prefs !== null) {
      dispatch({
        type: prefs.open ? "open" : "close",
        viewportWidth: window.innerWidth,
        ...(prefs.open ? { preferredWidth: prefs.width } : {}),
      });
    }
    hydrated.current = true;
  }, [chatId, enabled]);

  // Persist after hydration; never during an active drag (the committed width
  // lands on dragEnd / keyboard / toggle).
  useEffect(() => {
    if (!enabled || !hydrated.current || state.drag !== null || chatId === null) return;
    const storage = browserPanelStorage();
    if (storage !== null) {
      savePanelPrefs(chatId, prefsFromState(state), storage);
    }
  }, [chatId, enabled, state]);

  const chatHeaderToggle = useCallback(
    (onOpenFullPage?: () => void) => {
      dispatch({
        type: "chatHeaderToggle",
        viewportWidth: window.innerWidth,
        ...(onOpenFullPage !== undefined ? { onOpenFullPage } : {}),
      });
    },
    [dispatch],
  );

  return {
    state,
    viewportWidth,
    mobile,
    isOpen: state.widthState.kind === "inline",
    width: state.widthState.kind === "inline" ? state.widthState.width : PANEL_DEFAULT_WIDTH,
    toggle: chatHeaderToggle,
    open: () => dispatch({ type: "open", viewportWidth: window.innerWidth }),
    close: () => dispatch({ type: "close" }),
    dispatch,
  };
}

// ---------------------------------------------------------------------------
// Panel body — tab strip + active tab (shared by every presentation)
// ---------------------------------------------------------------------------

export function WorkspacePanelBody({
  workspaceId,
  onClose,
  onOpenFullPage,
  className,
}: {
  workspaceId: string;
  onClose?: (() => void) | undefined;
  onOpenFullPage?: (() => void) | undefined;
  className?: string | undefined;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>("files");
  const activeLabel = WORKSPACE_TABS.find((tab) => tab.id === activeTab)?.label ?? "Files";
  return (
    <section
      aria-label="Workspace panel"
      className={cn("flex h-full min-h-0 flex-col bg-surface", className)}
    >
      <div className="flex shrink-0 items-stretch border-b border-line">
        <TabStrip
          active={activeTab}
          onChange={setActiveTab}
          className="min-w-0 flex-1 border-b-0"
        />
        {onOpenFullPage ? (
          <button
            type="button"
            aria-label="Open workspace full page"
            title="Open full page"
            onClick={onOpenFullPage}
            className="shrink-0 border-l border-line px-2.5 text-muted transition-colors duration-150 hover:bg-surface-elevated hover:text-text"
          >
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          </button>
        ) : null}
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
        ) : (
          <TabComingSoon tabLabel={activeLabel} />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Docked presentations — desktop column with the divider, mobile bottom sheet
// ---------------------------------------------------------------------------

export function WorkspacePanelDock({
  controller,
  workspaceId,
}: {
  controller: WorkspacePanelController;
  workspaceId: string;
}): ReactElement | null {
  const { state, viewportWidth, mobile, isOpen, width } = controller;

  if (!isOpen) return null;

  if (mobile) {
    // §2.2 mobile shell: the panel becomes a bottom sheet with a grab handle;
    // resizing is unavailable (the dock rule) — open/close only.
    return (
      <div
        data-testid="workspace-panel-sheet"
        role="complementary"
        aria-label="Workspace panel"
        className="fixed inset-x-0 bottom-0 z-40 flex h-[70vh] flex-col rounded-t-2xl border-t border-line bg-surface shadow-[0_-16px_48px_rgba(0,0,0,0.5)]"
      >
        <div
          className="flex shrink-0 cursor-grab justify-center rounded-t-2xl py-2"
          aria-hidden="true"
        >
          <span className="h-1 w-10 rounded-full bg-line" />
        </div>
        <div className="min-h-0 flex-1">
          <WorkspacePanelBody workspaceId={workspaceId} onClose={controller.close} />
        </div>
      </div>
    );
  }

  return (
    <aside
      data-testid="workspace-panel-dock"
      style={{ width }}
      className="relative h-full min-h-0 shrink-0 border-l border-line bg-surface"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace panel"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={panelMaxWidth(viewportWidth)}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · arrow keys step · Enter resets"
        onKeyDown={(event) => onDividerKeyDown(event, controller.dispatch, viewportWidth)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          controller.dispatch({ type: "dragStart", pointerX: event.clientX, viewportWidth });
        }}
        onPointerMove={(event) => {
          if (state.drag !== null) {
            controller.dispatch({ type: "dragMove", pointerX: event.clientX });
          }
        }}
        onPointerUp={() => {
          if (state.drag !== null) {
            controller.dispatch({ type: "dragEnd" });
          }
        }}
        onLostPointerCapture={() => {
          if (state.drag !== null) {
            // Escape, pointercancel, or a stolen capture restores the start.
            controller.dispatch({ type: "dragCancel" });
          }
        }}
        onDoubleClick={() => controller.dispatch({ type: "reset", viewportWidth })}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors duration-150 hover:bg-line-accent/60"
      />
      <WorkspacePanelBody
        workspaceId={workspaceId}
        onClose={() => controller.dispatch({ type: "close" })}
      />
    </aside>
  );
}

/** The divider's keyboard map (mockup §8): arrows step, Shift doubles, Home/End limits, Enter resets, Escape cancels a drag. */
function onDividerKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  dispatch: PanelDispatch,
  viewportWidth: number,
): void {
  if (event.key === "Escape") {
    dispatch({ type: "dragCancel" });
    return;
  }
  const large = event.shiftKey;
  switch (event.key) {
    case "ArrowLeft":
      event.preventDefault();
      dispatch({ type: "keyboardResize", direction: "widen", large, viewportWidth });
      return;
    case "ArrowRight":
      event.preventDefault();
      dispatch({ type: "keyboardResize", direction: "narrow", large, viewportWidth });
      return;
    case "Home":
      event.preventDefault();
      dispatch({ type: "keyboardMin" });
      return;
    case "End":
      event.preventDefault();
      dispatch({ type: "keyboardMax", viewportWidth });
      return;
    case "Enter":
      event.preventDefault();
      dispatch({ type: "keyboardReset" });
      return;
  }
}

// ---------------------------------------------------------------------------
// The chat header toggle (S7 entry) + the standalone route host
// ---------------------------------------------------------------------------

/** The S7 entry: the chat header's workspace toggle (0 → 360 → 50% → full page). */
export function WorkspacePanelToggle({
  controller,
  chatId,
}: {
  controller: WorkspacePanelController;
  chatId: string;
}): ReactElement {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-pressed={controller.isOpen}
      aria-label={controller.isOpen ? "Close the workspace panel" : "Open the workspace panel"}
      title="Workspace"
      onClick={() => controller.toggle(() => router.push(routes.workspaceFull(chatId)))}
      className={cn(
        "shrink-0 rounded-lg p-2 transition-colors duration-150 hover:bg-surface-elevated",
        controller.isOpen ? "text-sky" : "text-muted hover:text-text",
      )}
    >
      {controller.isOpen ? (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/** The full-page header's Back-to-chat control (the behavior lives with the route surface). */
export function BackToChatButton({ onBack }: { onBack: () => void }): ReactElement {
  return (
    <button
      type="button"
      onClick={onBack}
      className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-text transition-colors duration-150 hover:border-line-accent hover:bg-surface-elevated"
    >
      Back to chat
    </button>
  );
}

/**
 * The standalone per-conversation panel host (the route surfaces render this):
 * "page" fills its container with the panel body; "docked" mounts the
 * resizable dock with its own controller (persistence keyed by chat id).
 */
export function WorkspacePanelHost({
  chatId,
  workspaceId,
  presentation,
}: {
  chatId: string;
  workspaceId: string;
  presentation: PanelPresentation;
}): ReactElement {
  const controller = useWorkspacePanelController(chatId, { enabled: presentation === "docked" });
  if (presentation === "page") {
    return (
      <div data-testid="workspace-panel-page" className="h-full min-h-0">
        <WorkspacePanelBody workspaceId={workspaceId} />
      </div>
    );
  }
  return <WorkspacePanelDock controller={controller} workspaceId={workspaceId} />;
}
