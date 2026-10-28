/**
 * S17 chunk 4 — the workspace panel host's pure state machine and its
 * per-conversation persistence (UI_DESIGN §2.2 docked states, §4 S7 entry).
 *
 * The docked panel has THREE semantic width states and one route state:
 *
 *   closed (0) → inline at 360px → inline at 50% → FULL PAGE (a route,
 *   /app/chat/[chatId]/workspace/full — deep-linkable, never a width).
 *
 * DIVISION OF OWNERSHIP (conflicting simultaneous control is impossible by
 * construction): the physical resize — pointer drag AND keyboard on the
 * divider — belongs to the react-resizable-panels separator the S08 app
 * shell already mounts (one handle, one library state, built-in ARIA
 * splitter keyboard). This reducer owns the SEMANTIC states: the chat-header
 * toggle cycle, the half/reset presets, and the committed width the library
 * reports back through onResize. The two never fight: the library is the
 * only writer of geometry during an interaction, and the reducer is the
 * only writer during commanded transitions.
 *
 * Clamps: the panel never goes below PANEL_MIN_WIDTH and never takes the
 * chat below CHAT_MIN_WIDTH — enforced by the two Panels' minSize props in
 * the shell group (chat panel minSize 320px bounds the workspace panel's
 * maxSize structurally) and repeated here for the commanded widths.
 */

export const PANEL_DEFAULT_WIDTH = 360;
export const PANEL_MIN_WIDTH = 320;
export const CHAT_MIN_WIDTH = 320;

/** Mobile breakpoint (§2.2: md 768px) — below it the docked panel is a bottom sheet. */
export const MOBILE_MAX_WIDTH = 767;

export type PanelWidthState = { kind: "closed" } | { kind: "inline"; width: number };

export interface PanelState {
  widthState: PanelWidthState;
}

export function initialPanelState(): PanelState {
  return { widthState: { kind: "closed" } };
}

export type PanelAction =
  | { type: "open"; viewportWidth: number; preferredWidth?: number }
  | { type: "close" }
  | {
      type: "chatHeaderToggle";
      viewportWidth: number;
      /** Called when the cycle reaches the full-page state — the host navigates. */
      onOpenFullPage?: () => void;
    }
  | { type: "showHalf"; viewportWidth: number }
  | { type: "reset"; viewportWidth: number }
  | {
      type: "setWidth";
      /** The committed pixel width the resize handle reported. */
      width: number;
    };

/** Widest the panel may grow at this viewport while the chat keeps its minimum. */
export function panelMaxWidth(viewportWidth: number): number {
  return Math.max(PANEL_MIN_WIDTH, viewportWidth - CHAT_MIN_WIDTH);
}

export function clampPanelWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(width, PANEL_MIN_WIDTH), Math.max(PANEL_MIN_WIDTH, maxWidth));
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open": {
      if (state.widthState.kind === "inline") return state;
      const preferred = action.preferredWidth ?? PANEL_DEFAULT_WIDTH;
      return {
        ...state,
        widthState: {
          kind: "inline",
          width: clampPanelWidth(preferred, panelMaxWidth(action.viewportWidth)),
        },
      };
    }
    case "close":
      // The width rides along (prefsFromState keeps it) so the next open restores it.
      return { ...state, widthState: { kind: "closed" } };
    case "chatHeaderToggle": {
      if (state.widthState.kind === "closed") {
        return {
          ...state,
          widthState: {
            kind: "inline",
            width: clampPanelWidth(PANEL_DEFAULT_WIDTH, panelMaxWidth(action.viewportWidth)),
          },
        };
      }
      const current = state.widthState.width;
      if (current < Math.floor(action.viewportWidth / 2)) {
        return {
          ...state,
          widthState: {
            kind: "inline",
            width: clampPanelWidth(
              Math.floor(action.viewportWidth / 2),
              panelMaxWidth(action.viewportWidth),
            ),
          },
        };
      }
      // Already at half: the next stop is the full-page route. The inline
      // width is untouched — returning from the route restores it.
      action.onOpenFullPage?.();
      return state;
    }
    case "showHalf":
      return {
        ...state,
        widthState: {
          kind: "inline",
          width: clampPanelWidth(
            Math.floor(action.viewportWidth / 2),
            panelMaxWidth(action.viewportWidth),
          ),
        },
      };
    case "reset":
      return {
        ...state,
        widthState: {
          kind: "inline",
          width: clampPanelWidth(PANEL_DEFAULT_WIDTH, panelMaxWidth(action.viewportWidth)),
        },
      };
    case "setWidth": {
      // The resize handle's committed width (the library has already applied
      // its own min/max constraints; this clamp keeps the semantic state
      // inside the panel's own floor).
      if (action.width < PANEL_MIN_WIDTH) return state;
      return { ...state, widthState: { kind: "inline", width: action.width } };
    }
  }
}

// ---------------------------------------------------------------------------
// Per-conversation persistence (width + membership), localStorage-keyed by
// the chat id — the first client-persisted panel preference in apps/web, so
// this module owns the seam (injectable Storage; SSR-guarded accessor).
// ---------------------------------------------------------------------------

export interface PanelPrefs {
  open: boolean;
  width: number;
}

export function panelPrefsStorageKey(chatId: string): string {
  return `shera.workspace-panel.${chatId}`;
}

/** The persisted projection of a panel state (open = inline width state). */
export function prefsFromState(state: PanelState): PanelPrefs {
  return {
    open: state.widthState.kind === "inline",
    width: state.widthState.kind === "inline" ? state.widthState.width : PANEL_DEFAULT_WIDTH,
  };
}

export function loadPanelPrefs(chatId: string, storage: Storage): PanelPrefs | null {
  const raw = storage.getItem(panelPrefsStorageKey(chatId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["open"] !== "boolean" ||
      typeof (parsed as Record<string, unknown>)["width"] !== "number"
    ) {
      return null;
    }
    const prefs = parsed as { open: boolean; width: number };
    if (!Number.isFinite(prefs.width) || prefs.width <= 0) return null;
    return prefs;
  } catch {
    return null;
  }
}

export function savePanelPrefs(chatId: string, prefs: PanelPrefs, storage: Storage): void {
  storage.setItem(panelPrefsStorageKey(chatId), JSON.stringify(prefs));
}

/** The browser storage, or null during SSR / when persistence is unavailable. */
export function browserPanelStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || window.localStorage === null) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Viewport mode — the mobile bottom sheet (< 768px) is a presentation, not a
// width state; the host picks the presentation from this matchMedia probe
// (injected for tests).
// ---------------------------------------------------------------------------

export function isMobileViewport(matcher: MediaQueryList | { matches: boolean }): boolean {
  return matcher.matches;
}

export function mobileViewportQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
}
