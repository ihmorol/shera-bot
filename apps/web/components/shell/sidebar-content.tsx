"use client";

import type { Agent } from "@shera-bot/contracts";
import { Layers, Loader2, MoreHorizontal, Pin, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { AgentRosterSection } from "@/components/shell/agent-roster";
import { CreditsPill } from "@/components/shell/credits-pill";
import { LiveOperationChatsSection } from "@/components/shell/operation-chats-section";
import { NotificationBell } from "@/components/shell/notification-center";
import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAgentRoster } from "@/lib/agent-data";
import {
  setChatUnreadMark,
  toggleChatPin,
  useChatViewPrefs,
  type ChatUnreadMark,
} from "@/lib/chat-view-prefs";
import { useContainerResolution } from "@/lib/container-connection";
import {
  agentById,
  entitySlug,
  messagesForConversation,
  sessionPresenceFor,
  sidebarModel,
  type AttentionVariant,
  type ChatMessage,
  type ConversationState,
  type SessionPresence,
} from "@/lib/fixtures";
import { useAdvancedMode, setAdvancedMode } from "@/lib/interface-mode";
import { useOperationsList } from "@/lib/operation-data";
import { formatChatTimestamp, useRelativeNow } from "@/lib/relative-time";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { Wordmark } from "./wordmark";

/**
 * Sidebar (UI_DESIGN §3.2, §2.1, PRD §4.1) in two interface modes
 * (lib/interface-mode.ts, owner direction 2026-11-20):
 *
 * SIMPLE (default) — one "Chats" list: the pack Agents' direct chats and the
 * Operation chats interleaved by last activity, each row reduced to
 * avatar-or-Operation glyph + name + the honest state trail. No role
 * descriptions, no subtitles, no template gallery — a student opens the app
 * and picks up a conversation. The Operation framing stays: Operation rows
 * carry the Layers glyph and open the Operation chat surface.
 *
 * ADVANCED — the documented structure: the six pack Agents as persistent
 * direct chats (AC3, with the §3.2 settings affordance), the pack-defined
 * Operation templates (launch → preview, D30), and the active Operation
 * chats group (S14 live rows + fixture demo rows). Two sections only (D41);
 * no workspace or pack switcher (D40, D19).
 *
 * State language is shared by both modes (§2.1, G2): unread (count pill),
 * running (spinner), approval_required (amber dot + count — a pending
 * proposal, never a granted state), failed (red only for genuinely FAILED
 * runs; amber "needs your review" otherwise), quiet (no marker). Color is
 * never the only signal — every dot pairs with a glyph, count, or
 * screen-reader label. Live rows fabricate no state (G4) and render quiet.
 */

/** The live Agents section once the container is ready (S11 roster read). */
function LiveAgentRosterSection({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const roster = useAgentRoster(workspaceId);
  return (
    <AgentRosterSection
      entries={roster.agents}
      state={roster.state === "ready" && roster.agents.length === 0 ? "empty" : roster.state}
      safeErrorMessage={roster.safeErrorMessage}
      onRetry={roster.refetch}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );
}

/**
 * The live Operation chats (S14): the workspace's REAL Operations read from
 * GET /v1/operations, each entry carrying the ad-hoc identity (D41). Rendered
 * beside the fixture demo chats (which stay, honestly labeled demo data, G4);
 * a wrapper component keeps the list hook's lifecycle inside "container
 * ready" — the same discipline as LiveAgentRosterSection.
 */
function LiveOperationChats({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const operations = useOperationsList(workspaceId);
  return (
    <LiveOperationChatsSection
      operations={operations.operations}
      state={operations.state}
      safeErrorMessage={operations.safeErrorMessage}
      onRetry={operations.refetch}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );
}

/** Screen-reader label per sidebar state (color is never the only signal). */
const STATE_LABELS: Record<ConversationState, string> = {
  unread: "unread messages",
  running: "work in progress",
  approval_required: "waiting for your approval",
  failed: "needs your review",
  quiet: "no new activity",
};

function SidebarSectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-2 font-mono text-xs uppercase tracking-[0.16em] text-muted">{children}</p>
  );
}

function UnreadPill({ count }: { count: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-surface-elevated px-1.5 py-0.5 font-mono text-[11px] leading-none text-text">
      {count}
    </span>
  );
}

function StateTrail({
  state,
  unreadCount,
  approvalCount,
  attention,
}: {
  state: ConversationState;
  unreadCount: number;
  approvalCount: number;
  attention: AttentionVariant;
}) {
  // §2.1 palette: red marks a genuinely FAILED run only; a run that is
  // paused or needs recovery review reads amber (attention), never red.
  const failedLabel = attention === "error" ? "failed" : "needs your review";
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {state === "running" ? (
        <Loader2 className="size-3.5 animate-spin text-sky" aria-hidden="true" />
      ) : null}
      {state === "approval_required" ? (
        <>
          <span className="size-2 rounded-full bg-approval" aria-hidden="true" />
          <UnreadPill count={approvalCount} />
        </>
      ) : null}
      {state === "failed" ? (
        // §2.1 palette: red marks a genuinely FAILED run only; PAUSED /
        // RECOVERY_REQUIRED read amber. The sr-only label renders once,
        // in the shared trailing span below.
        <span
          className={cn("size-2 rounded-full", attention === "error" ? "bg-failed" : "bg-approval")}
          aria-hidden="true"
        />
      ) : null}
      {state === "unread" ? <UnreadPill count={unreadCount} /> : null}
      <span className="sr-only">{state === "failed" ? failedLabel : STATE_LABELS[state]}</span>
    </span>
  );
}

const ITEM_BASE = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
const ITEM_ACTIVE = "bg-surface-elevated text-text";
const ITEM_IDLE = "text-muted hover:bg-surface-elevated hover:text-text";

/**
 * The merged Chats list is recency-sorted (D52, UI_DESIGN §3.4): agent
 * direct chats and Operation chats interleave by their own recorded
 * timestamps, newest first, agent rows winning ties (stable sort keeps
 * roster order within a tie). Exported for the order contract test.
 */
export function mergeChatsByRecency<A extends { at: number }, O extends { at: number }>(
  agentRows: A[],
  operationRows: O[],
): (A | O)[] {
  return [...agentRows, ...operationRows].sort((a, b) => b.at - a.at);
}

/**
 * One row of the SIMPLE merged Chats list (wave A chunk A1, D52). Both list
 * paths (fixture demo + real workspace reads) build these and render them
 * through {@link SimpleChatRows} so the two-line anatomy exists exactly once.
 */
export interface SimpleChatRow {
  kind: "agent" | "operation";
  key: string;
  /**
   * The row's stable identifier — the pin/copy key of the row menu (chunk
   * A2). Demo rows carry the fixture conversation id; live rows carry the
   * runtime record id the row actually holds (the roster payload has no
   * conversation id — the client never invents one, G4).
   */
  conversationId: string;
  href: string;
  title: string;
  /** Demo Agent rows carry the full fixture Agent (avatar + presence). */
  agent?: Agent | null;
  /** Live Agent rows carry identity-only fields (G4 — nothing fabricated). */
  hue?: number;
  glyph?: string;
  presence?: SessionPresence | undefined;
  /** Recency sort key; 0 when the record carries no stamp (renders none). */
  at: number;
  /** The activity preview line; null renders no line — the row stays quiet. */
  preview: string | null;
  /** Demo rows carry the derived §2.1 state; live rows fabricate no state. */
  state?: ConversationState | undefined;
  unreadCount?: number;
  approvalCount?: number;
  attention?: AttentionVariant | undefined;
  autoLabel?: boolean;
  isAdhoc?: boolean;
}

/**
 * Pin-first ordering (UI_DESIGN §3.4 amendment, D52 wave A): pinned rows
 * lead the list; recency order survives within the pinned group and the
 * rest. The input list is already recency-merged (mergeChatsByRecency) —
 * this only stable-partitions it, never re-introduces attention-rank
 * ordering (attention states render as markers, not sort keys). Exported
 * for the order contract test.
 */
export function orderChatsPinFirst<T extends { conversationId: string }>(
  rows: T[],
  pinnedIds: readonly string[],
): T[] {
  if (pinnedIds.length === 0) return rows;
  const pins = new Set(pinnedIds);
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    (pins.has(row.conversationId) ? pinned : rest).push(row);
  }
  return [...pinned, ...rest];
}

/**
 * The demo (fixture) preview line: the newest recorded message of the
 * conversation, prefixed "You: " when the user sent it and attributed by
 * Agent name inside an Operation chat. Conversations with no recorded
 * messages preview nothing — the row stays quiet (G4). Demo data only: live
 * rows render the runtime-derived preview verbatim and never derive one
 * client-side.
 */
export function chatPreviewFromMessages(
  messages: ChatMessage[],
  conversationKind: "agent_direct" | "operation",
): string | null {
  const newest = messages[messages.length - 1];
  if (!newest) return null;
  if (newest.sender.kind === "user") return `You: ${newest.text}`;
  if (conversationKind === "operation" && newest.sender.kind === "agent") {
    const agent = agentById(newest.sender.agent_id);
    return agent ? `${agent.display_name}: ${newest.text}` : newest.text;
  }
  return newest.text;
}

// ---------------------------------------------------------------------------
// Wave A chunk A2 — the row context menu (E43 §3 contract, D52): pin,
// read-state overlay, copy conversation id, and the kind-specific last
// entry. There is NO delete/archive/rename in v1 — conversations persist
// (PRD §4.2) and the runtime has no such chat-mutation commands, so menu
// items that would need them are not invented (G2).
// ---------------------------------------------------------------------------

export type ChatRowMenuEntry =
  | { kind: "separator" }
  | {
      kind: "item";
      key: string;
      label: string;
      /** Navigation items push this route; action items fire onSelect. */
      href?: string | undefined;
      onSelect?: (() => void) | undefined;
      disabled?: boolean | undefined;
      /** The reason a disabled item cannot fire (title attr; never guessed). */
      disabledReason?: string | undefined;
      /** A hover hint — e.g. the local-only nature of the unread overlay. */
      title?: string | undefined;
    };

/**
 * The menu entries for one chat row, in the recorded order. Pure — the
 * component wires the callbacks and the sheet renders the result.
 */
export function chatRowMenuItems(options: {
  kind: "agent" | "operation";
  conversationId: string;
  pinned: boolean;
  mark: ChatUnreadMark | undefined;
  runtimeUnread: boolean;
  containerReady: boolean;
  /** Agent rows: the settings-route slug (settings need the Agent identity). */
  agentSlug?: string | undefined;
  /** Operation rows: the operation chat route the "Open roster" item opens. */
  operationHref?: string | undefined;
  onTogglePin: () => void;
  onSetMark: (mark: ChatUnreadMark) => void;
  onCopy: () => void;
}): ChatRowMenuEntry[] {
  const separator: ChatRowMenuEntry = { kind: "separator" };
  // The overlay wins over runtime state for this browser: an explicit
  // "unread"/"read" mark decides, otherwise the runtime's own state.
  const effectivelyUnread =
    options.mark === "unread" ? true : options.mark === "read" ? false : options.runtimeUnread;
  return [
    {
      kind: "item",
      key: "pin",
      label: options.pinned ? "Unpin" : "Pin",
      onSelect: options.onTogglePin,
    },
    {
      kind: "item",
      key: "mark",
      label: effectivelyUnread ? "Mark as read" : "Mark as unread",
      onSelect: () => options.onSetMark(effectivelyUnread ? "read" : "unread"),
      ...(effectivelyUnread ? {} : { title: "Marked unread here only" }),
    },
    separator,
    {
      kind: "item",
      key: "copy",
      label: "Copy conversation ID",
      onSelect: options.onCopy,
    },
    separator,
    options.kind === "agent"
      ? {
          kind: "item",
          key: "settings",
          label: "Agent settings",
          href: routes.settings(`agents/${options.agentSlug ?? ""}`),
          disabled: !options.containerReady,
          disabledReason: "Settings need the workspace ready",
        }
      : {
          kind: "item",
          key: "roster",
          label: "Open roster",
          href: options.operationHref,
          disabled: false,
        },
  ];
}

/**
 * Viewport clamp for the portal sheet (E43 §3: 8px margins, never off-screen).
 * Pure — tested directly.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}

/**
 * Roving focus over the ENABLED menu items (E43 §3): ArrowDown/ArrowUp wrap,
 * Home/End jump, anything else is not a focus move. `current` is the index
 * within the enabled list (-1 when nothing is focused yet). Pure — tested
 * directly.
 */
export function nextMenuFocusIndex(
  current: number,
  key: string,
  enabledCount: number,
): number | null {
  if (enabledCount === 0) return null;
  // Nothing focused yet: ArrowDown enters at the first item, ArrowUp at the
  // last — the wrap formula below only holds for valid indices.
  if (current < 0) {
    if (key === "ArrowDown") return 0;
    if (key === "ArrowUp") return enabledCount - 1;
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return (current + 1) % enabledCount;
    case "ArrowUp":
      return (current - 1 + enabledCount) % enabledCount;
    case "Home":
      return 0;
    case "End":
      return enabledCount - 1;
    default:
      return null;
  }
}

const MENU_WIDTH = 224;
const MENU_MARGIN_PX = 8;

/**
 * The portal sheet (E43 §3 recipe): rounded surface on the elevated token,
 * 30px min-height rows, 14px text, hairline separators, disabled =
 * opacity-40 with the reason in the title. Escape closes, roving arrow keys
 * move focus, viewport-clamped via the caller's position. Exported for the
 * a11y contract test.
 */
export function ChatRowMenuSheet({
  entries,
  position,
  onDismiss,
  menuRef,
  copied,
}: {
  entries: ChatRowMenuEntry[];
  position?: { x: number; y: number } | undefined;
  onDismiss: () => void;
  /** Ref passthrough so the opener can scope focus + outside-click logic. */
  menuRef?: RefObject<HTMLDivElement | null> | undefined;
  /** Copy feedback: the copy item's title flips to "Copied" briefly. */
  copied?: boolean | undefined;
}) {
  const router = useRouter();
  const internalRef = useRef<HTMLDivElement>(null);
  const sheetRef = menuRef ?? internalRef;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
      return;
    }
    const enabled = Array.from(
      sheetRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    const current = enabled.findIndex((item) => item === document.activeElement);
    const next = nextMenuFocusIndex(current, event.key, enabled.length);
    if (next === null) return;
    event.preventDefault();
    enabled[next]?.focus();
  };

  return (
    <div
      ref={sheetRef}
      role="menu"
      data-testid="chat-row-menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="z-50 w-56 rounded-xl border border-line bg-surface-elevated p-1.5 shadow-lg shadow-black/40"
      style={position ? { position: "fixed", left: position.x, top: position.y } : undefined}
    >
      {entries.map((entry, index) =>
        entry.kind === "separator" ? (
          <div key={`sep-${index}`} role="separator" className="mx-1.5 my-1 h-px bg-line" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            title={
              entry.disabled
                ? entry.disabledReason
                : entry.key === "copy" && copied
                  ? "Copied"
                  : entry.title
            }
            onClick={() => {
              if (entry.disabled) return;
              if (entry.href) router.push(entry.href);
              entry.onSelect?.();
              onDismiss();
            }}
            className={cn(
              "flex min-h-[30px] w-full items-center rounded-md px-3 text-left text-sm text-text transition-colors",
              entry.disabled ? "cursor-default opacity-40" : "hover:bg-surface",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

const COPY_FEEDBACK_MS = 1500;
/** Conservative sheet-height estimate for the viewport clamp (items + padding). */
const MENU_ESTIMATED_HEIGHT = 168;

/**
 * One SIMPLE row (wave A): the two-line anatomy inside the row link plus the
 * menu trigger as a sibling control. The row owns the menu's local state —
 * right-click and Shift+F10 open the sheet at the pointer, the trigger
 * anchors it to its own box; Escape/outside-mousedown close it; focus
 * restores to the opener. The pin glyph, the read/unread overlay, and the
 * menu all read the same client view store — nothing here writes to the
 * runtime (G2/G4).
 */
function SimpleChatRowItem({
  row,
  active,
  timestamp,
  containerReady,
  onNavigate,
}: {
  row: SimpleChatRow;
  active: boolean;
  timestamp: string | null;
  containerReady: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { pins, marks } = useChatViewPrefs();
  const pinned = pins.includes(row.conversationId);
  const mark = marks[row.conversationId];
  // The overlay wins for this browser only: "read" clears the runtime pill,
  // "unread" forces the local dot (no fake count — G4).
  const stateAfterOverlay = mark === "read" && row.state === "unread" ? "quiet" : row.state;

  const close = useCallback(() => {
    setOpen(false);
    // Focus returns to the opener (E43 §3 focus discipline).
    openerRef.current?.focus();
  }, []);

  const openAt = useCallback((x: number, y: number) => {
    if (typeof window !== "undefined") {
      setPosition(
        clampMenuPosition(
          x,
          y,
          MENU_WIDTH,
          MENU_ESTIMATED_HEIGHT,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    } else {
      setPosition({ x: MENU_MARGIN_PX, y: MENU_MARGIN_PX });
    }
    setCopied(false);
    setOpen(true);
  }, []);

  // Outside mousedown closes (the opener's own mousedown lets its click
  // toggle the menu instead of double-firing).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) || openerRef.current?.contains(target))
      ) {
        return;
      }
      close();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open, close]);

  // Focus the first ENABLED item on open (E43 §3).
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const copyConversationId = useCallback(() => {
    try {
      void navigator.clipboard?.writeText(row.conversationId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard unavailable — nothing is promised; the id stays in the
      // conversation record (it renders in the address bar for Operations).
    }
  }, [row.conversationId]);

  const entries = chatRowMenuItems({
    kind: row.kind,
    conversationId: row.conversationId,
    pinned,
    mark,
    runtimeUnread: row.state === "unread",
    containerReady,
    agentSlug: row.kind === "agent" ? entitySlug(row.key) : undefined,
    operationHref: row.kind === "operation" ? row.href : undefined,
    onTogglePin: () => toggleChatPin(row.conversationId),
    onSetMark: (nextMark) => setChatUnreadMark(row.conversationId, nextMark),
    onCopy: copyConversationId,
  });

  const openFromTrigger = () => {
    const rect = openerRef.current?.getBoundingClientRect();
    openAt(
      rect ? rect.right - MENU_WIDTH : MENU_MARGIN_PX,
      rect ? rect.bottom + 4 : MENU_MARGIN_PX,
    );
  };

  return (
    <li
      className="group relative"
      onContextMenu={(event) => {
        event.preventDefault();
        openAt(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.shiftKey && event.key === "F10") {
          event.preventDefault();
          const rect = openerRef.current?.getBoundingClientRect();
          openAt(rect ? rect.left : MENU_MARGIN_PX, rect ? rect.bottom + 4 : MENU_MARGIN_PX);
        }
      }}
    >
      <div className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}>
        <Link
          href={row.href}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-3"
          {...(onNavigate ? { onClick: onNavigate } : {})}
        >
          {row.agent ? (
            <AgentAvatar
              agent={row.agent}
              size="sm"
              {...(row.presence ? { presence: row.presence } : {})}
            />
          ) : row.hue !== undefined && row.glyph !== undefined ? (
            <AgentAvatar
              agent={{
                agent_id: row.key,
                display_name: row.title,
                ui_identity: { avatar_hue: row.hue, initial_glyph: row.glyph },
              }}
              size="sm"
            />
          ) : (
            <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {pinned ? (
                <Pin
                  className="size-3 shrink-0 text-muted"
                  aria-hidden="true"
                  data-testid="chat-pin-glyph"
                />
              ) : null}
              <span
                className={cn(
                  "min-w-0 truncate",
                  row.kind === "operation" && row.autoLabel && "italic text-muted",
                )}
              >
                {row.title}
              </span>
              {timestamp ? (
                <span
                  data-testid="chat-timestamp"
                  className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted"
                >
                  {timestamp}
                </span>
              ) : null}
            </span>
            {row.preview ? (
              <span
                data-testid="chat-preview-line"
                title={row.preview}
                className="block truncate text-xs text-muted"
              >
                {row.preview}
              </span>
            ) : null}
          </span>
          {mark === "unread" ? (
            <span
              data-testid="chat-unread-dot"
              role="img"
              aria-label="Marked unread here only"
              title="Marked unread here only"
              className="size-1.5 shrink-0 rounded-full bg-brand"
            />
          ) : null}
          {stateAfterOverlay ? (
            <StateTrail
              state={stateAfterOverlay}
              unreadCount={row.unreadCount ?? 0}
              approvalCount={row.approvalCount ?? 0}
              attention={row.attention}
            />
          ) : null}
          {row.kind === "operation" && row.isAdhoc ? (
            <span
              title="Created without a pack definition"
              className="shrink-0 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted"
            >
              Ad-hoc
            </span>
          ) : null}
        </Link>
        {/* The hover/keyboard-reachable "..." trigger — a sibling of the row
            link (never nested interactive elements), always in the DOM for
            keyboard users, revealed on hover or focus. */}
        <button
          type="button"
          ref={openerRef}
          aria-label={`Chat options for ${row.title}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Chat options"
          onClick={openFromTrigger}
          className="shrink-0 rounded-md p-1.5 text-muted opacity-0 transition-[opacity,color] hover:bg-surface-elevated hover:text-text focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </div>
      {open && typeof document !== "undefined"
        ? createPortal(
            <ChatRowMenuSheet
              entries={entries}
              position={position}
              onDismiss={close}
              menuRef={menuRef}
              copied={copied}
            />,
            document.body,
          )
        : null}
    </li>
  );
}

/**
 * The shared SIMPLE row list (wave A): two-line rows — line 1 avatar or
 * Operation glyph + pin glyph + name + relative timestamp (right-aligned,
 * tabular numerals, 12px), line 2 the activity preview line. Rows with no
 * preview stay quiet single-line (G4). Pinned rows lead (§3.4) — the pins
 * come from the client view store. Exported for the row-anatomy contract
 * test.
 */
export function SimpleChatRows({
  rows,
  pathname,
  onNavigate,
  now: nowOverride,
  containerReady = false,
}: {
  rows: SimpleChatRow[];
  pathname: string;
  onNavigate?: (() => void) | undefined;
  /**
   * Clock injection for static renders (tests pin the labels). Unset in the
   * app: the mount-gated render clock is used and pre-mount rows render no
   * timestamp rather than guessing one.
   */
  now?: number | undefined;
  /** Whether the workspace container is ready (gates the settings entry). */
  containerReady?: boolean | undefined;
}) {
  const { pins } = useChatViewPrefs();
  const clockNow = useRelativeNow();
  const now = nowOverride ?? clockNow;
  const ordered = orderChatsPinFirst(rows, pins);
  return (
    <ul>
      {ordered.map((row) => {
        const active = pathname === row.href || pathname.startsWith(`${row.href}/`);
        const timestamp = formatChatTimestamp(row.at, now);
        return (
          <SimpleChatRowItem
            key={row.key}
            row={row}
            active={active}
            timestamp={timestamp}
            containerReady={containerReady}
            onNavigate={onNavigate}
          />
        );
      })}
    </ul>
  );
}

/** The Advanced footer toggle — one quiet control, both modes. */
function AdvancedToggle() {
  const advanced = useAdvancedMode();
  return (
    <button
      type="button"
      aria-pressed={advanced}
      onClick={() => setAdvancedMode(!advanced)}
      title={advanced ? "Show the simple interface" : "Show agents, templates, and machinery"}
      className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-text"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-3.5 w-6 items-center rounded-full border px-0.5 transition-colors",
          advanced ? "border-line-accent bg-surface-elevated" : "border-line bg-transparent",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full transition-colors",
            advanced ? "translate-x-2.5 bg-sky" : "translate-x-0 bg-muted",
          )}
        />
      </span>
      Advanced
    </button>
  );
}

/** The SIMPLE chat list — fixture demo data (no container yet). */
function SimpleChatListDemo({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const model = sidebarModel();
  const rows = mergeChatsByRecency(
    model.agents.map((entry): SimpleChatRow => ({
      kind: "agent",
      key: entry.agent.agent_id,
      conversationId: entry.conversation.conversation_id,
      href: routes.agent(entitySlug(entry.agent.agent_id)),
      title: entry.agent.display_name,
      agent: entry.agent,
      presence: sessionPresenceFor(entry.conversation.conversation_id),
      at: Date.parse(entry.conversation.last_activity_at),
      // Demo data only: the newest fixture message quotes as the preview
      // ("You: " for the user's own lines); no messages → a quiet row (G4).
      preview: chatPreviewFromMessages(
        messagesForConversation(entry.conversation.conversation_id),
        entry.conversation.kind,
      ),
      state: entry.state,
      unreadCount: entry.conversation.unread_count,
      approvalCount: entry.approvalCount,
      attention: entry.attention,
    })),
    model.operationChats.map((entry): SimpleChatRow => ({
      kind: "operation",
      key: entry.operation.operation_id,
      conversationId: entry.conversation.conversation_id,
      href: routes.operation(entry.operation.operation_id),
      title: entry.conversation.title,
      agent: null,
      at: Date.parse(entry.conversation.last_activity_at),
      // The fixture Operation chats carry no recorded messages — the
      // derivation returns null and the rows stay preview-less (G4).
      preview: chatPreviewFromMessages(
        messagesForConversation(entry.conversation.conversation_id),
        entry.conversation.kind,
      ),
      state: entry.state,
      unreadCount: entry.conversation.unread_count,
      approvalCount: entry.approvalCount,
      attention: entry.attention,
    })),
  );

  return (
    <SimpleChatRows
      rows={rows}
      pathname={pathname}
      onNavigate={onNavigate}
      containerReady={false}
    />
  );
}

/** The SIMPLE chat list over the REAL workspace reads (S11/S14 discipline). */
function SimpleChatListLive({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const roster = useAgentRoster(workspaceId);
  const operations = useOperationsList(workspaceId);

  // Real reads fabricate no state (G4): live rows render quiet — no derived
  // unread/approval markers until the runtime's real tracking lands.
  const agentRows: SimpleChatRow[] = roster.agents.map((agent) => ({
    kind: "agent",
    key: agent.agent_id,
    // The roster payload carries no conversation id — the runtime record id
    // is the honest stable key for pins and the row menu (chunk A2).
    conversationId: agent.agent_id,
    href: routes.agent(entitySlug(agent.agent_id)),
    title: agent.display_name,
    agent: null,
    hue: agent.avatar_hue,
    glyph: agent.initial_glyph,
    at: agent.last_activity ? Date.parse(agent.last_activity.at) : 0,
    // S30 (E43 idea 4): the runtime derives the preview from its journal —
    // render it verbatim; null stays a quiet single-line row (G4).
    preview: agent.last_activity ? agent.last_activity.preview : null,
  }));
  const operationRows: SimpleChatRow[] = operations.operations.map((operation) => ({
    kind: "operation",
    key: operation.operation_id,
    conversationId: operation.operation_id,
    href: routes.operation(operation.operation_id),
    title: operation.name,
    agent: null,
    // The runtime derives no last-activity preview for Operations — the
    // record's updated_at is the honest available stamp (G4); rows stay
    // preview-less until the runtime adds a field.
    at: Date.parse(operation.updated_at) || 0,
    preview: null,
    autoLabel: operation.auto_label,
    isAdhoc: operation.is_adhoc,
  }));

  if (roster.state === "loading" || operations.state === "loading") {
    return (
      <div aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-2">
            <span className="size-6 animate-pulse rounded-full bg-surface-elevated" />
            <span className="h-3 w-36 animate-pulse rounded bg-surface-elevated" />
          </div>
        ))}
      </div>
    );
  }

  if (roster.state === "error" || operations.state === "error") {
    const safeErrorMessage = roster.safeErrorMessage ?? operations.safeErrorMessage;
    return (
      <div role="alert" className="mx-1 flex flex-col gap-2 rounded-lg px-2 py-2">
        <p className="text-sm text-text">
          {safeErrorMessage ?? "The conversations could not be loaded."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            roster.refetch();
            operations.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // §2.4 + §3.4: the live merged list defines its empty state — one line
  // naming what will appear; the New Operation action sits directly above.
  if (agentRows.length === 0 && operationRows.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted" role="status">
        No conversations yet. Agent chats and Operations appear here.
      </p>
    );
  }

  return (
    <SimpleChatRows
      rows={mergeChatsByRecency(agentRows, operationRows)}
      pathname={pathname}
      onNavigate={onNavigate}
      containerReady={true}
    />
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const advanced = useAdvancedMode();
  const model = sidebarModel();
  const linkProps = onNavigate ? { onClick: onNavigate } : {};
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Global chrome row (§3.2: bell | gear) */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Wordmark />
        <div className="flex items-center gap-1">
          <NotificationBell workspaceId={readyWorkspaceId} onNavigate={onNavigate} />
          <Button variant="ghost" size="icon" asChild>
            <Link href={routes.settings()} aria-label="Open settings" {...linkProps}>
              <Settings2 className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <Separator />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-4" aria-label="Primary">
        {advanced ? (
          <>
            {/* Agents — the REAL workspace roster once the container is ready
                (S11); the fixture demo rows otherwise (§3.2, AC3). */}
            <section>
              {readyWorkspaceId ? (
                <LiveAgentRosterSection
                  workspaceId={readyWorkspaceId}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ) : (
                <>
                  <SidebarSectionLabel>Agents</SidebarSectionLabel>
                  <ul>
                    {model.agents.map(
                      ({ agent, conversation, state, approvalCount, attention }) => {
                        const href = routes.agent(entitySlug(agent.agent_id));
                        const active = pathname === href || pathname.startsWith(`${href}/`);
                        const presence = sessionPresenceFor(conversation.conversation_id);
                        return (
                          <li key={agent.agent_id}>
                            <Link
                              href={href}
                              aria-current={active ? "page" : undefined}
                              title={agent.role_description}
                              className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}
                              {...linkProps}
                            >
                              <AgentAvatar agent={agent} size="sm" presence={presence} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-text">
                                  {agent.display_name}
                                </span>
                                <span className="block truncate text-xs text-muted">
                                  {agent.role_description}
                                </span>
                              </span>
                              <StateTrail
                                state={state}
                                unreadCount={conversation.unread_count}
                                approvalCount={approvalCount}
                                attention={attention}
                              />
                            </Link>
                          </li>
                        );
                      },
                    )}
                  </ul>
                </>
              )}
            </section>

            <Separator className="my-4" />

            {/* Operations — templates open the launch preview (D30); chats open directly */}
            <section>
              <div className="flex items-center justify-between pr-2">
                <SidebarSectionLabel>Operations</SidebarSectionLabel>
                <Button variant="ghost" size="sm" asChild className="-my-1">
                  <Link href={routes.operationNew()} {...linkProps}>
                    + New
                  </Link>
                </Button>
              </div>
              <ul>
                {model.templates.map(({ definition }) => {
                  const slug = entitySlug(definition.operation_id);
                  return (
                    <li key={definition.operation_id}>
                      <Link
                        href={routes.operationPreview(slug)}
                        className={cn(ITEM_BASE, ITEM_IDLE)}
                        {...linkProps}
                      >
                        <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{definition.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>

              {/* Active Operation chats group (§3.2: "── active chats ──").
                  S14: the REAL Operations render first with the ad-hoc identity
                  (D41); the fixture demo chats stay below, honestly demo. */}
              <p className="px-3 pb-1 pt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Active chats
              </p>
              {readyWorkspaceId ? (
                <div className="pb-1">
                  <LiveOperationChats
                    workspaceId={readyWorkspaceId}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                </div>
              ) : null}
              <ul>
                {model.operationChats.map(
                  ({ operation, conversation, subtitle, state, approvalCount, attention }) => {
                    return (
                      <li key={operation.operation_id}>
                        <Link
                          href={routes.operation(operation.operation_id)}
                          className={cn(ITEM_BASE, ITEM_IDLE)}
                          {...linkProps}
                        >
                          <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{conversation.title}</span>
                            <span className="block truncate text-xs text-muted">{subtitle}</span>
                          </span>
                          <StateTrail
                            state={state}
                            unreadCount={conversation.unread_count}
                            approvalCount={approvalCount}
                            attention={attention}
                          />
                        </Link>
                      </li>
                    );
                  },
                )}
              </ul>
            </section>
          </>
        ) : (
          <>
            {/* SIMPLE (default): one conversation list + one primary action. */}
            <div className="px-1 pb-3">
              <Button className="w-full" asChild>
                <Link href={routes.operationNew()} {...linkProps}>
                  New Operation
                </Link>
              </Button>
            </div>
            <section aria-label="Chats">
              <SidebarSectionLabel>Chats</SidebarSectionLabel>
              {readyWorkspaceId ? (
                <SimpleChatListLive
                  workspaceId={readyWorkspaceId}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ) : (
                <SimpleChatListDemo pathname={pathname} onNavigate={onNavigate} />
              )}
            </section>
          </>
        )}
      </nav>

      {/* Footer: the credits pill (S24, D21 — remaining, reserved on hover).
          Advanced also shows the pinned pack once as a label, not a control
          (D40); simple keeps the footer to credits + the mode toggle. */}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-3">
        <CreditsPill workspaceId={readyWorkspaceId} />
        <div className="flex items-center gap-3">
          {advanced ? (
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
              student pack v1
            </p>
          ) : null}
          <AdvancedToggle />
        </div>
      </div>
    </div>
  );
}
