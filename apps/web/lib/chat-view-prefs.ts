"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * Chat view preferences (wave A chunk A2, D52; E43 §3 pattern-not-pixels):
 * the SIMPLE sidebar rows' pin set and read/unread overlay. These are VIEW
 * preferences layered over runtime state — the runtime owns conversation
 * truth; the sidebar never writes to the runtime. A pin floats a row to the
 * top of the simple list; an overlay ("read" clears the runtime unread
 * pill, "unread" forces the unread dot) wins over runtime state for this
 * browser only, and nothing leaves this module.
 *
 * The store follows lib/interface-mode.ts exactly: module session state +
 * useSyncExternalStore + one module-lifetime window `storage` listener so
 * two tabs agree, try/catch localStorage guards, in-memory fallback when
 * storage is unavailable (private mode, SSR).
 */

const PIN_KEY = "shera-chat-pins";
const UNREAD_MARKS_KEY = "shera-chat-unread-marks";

/** Storage key names, exported for the persistence contract test. */
export const CHAT_PINS_STORAGE_KEY = PIN_KEY;
export const CHAT_UNREAD_MARKS_STORAGE_KEY = UNREAD_MARKS_KEY;

export type ChatUnreadMark = "unread" | "read";
export type ChatUnreadMarks = Record<string, ChatUnreadMark>;

/** Module session state — the parsed cache; stable references between writes. */
let pins: string[] = [];
let marks: ChatUnreadMarks = {};
let initialized = false;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Parse the pins key; corrupted or wrong-shape payloads read as empty. */
function readPinsFromStorage(): string[] {
  try {
    const raw = storage()?.getItem(PIN_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** Parse the overlay key; corrupted or wrong-shape payloads read as empty. */
function readMarksFromStorage(): ChatUnreadMarks {
  try {
    const raw = storage()?.getItem(UNREAD_MARKS_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: ChatUnreadMarks = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "unread" || value === "read") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  pins = readPinsFromStorage();
  marks = readMarksFromStorage();
}

/** The store's raw subscription (exported for test pinning of the lifecycle). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureWindowListener();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One window listener for the module's lifetime (mounted on the first
 * subscribe, never removed — the module lives as long as the page): a
 * `storage` event fires only in OTHER documents, so this is the cross-tab
 * sync path — re-read the other tab's write and notify.
 */
let windowListenerBound = false;
function ensureWindowListener(): void {
  if (windowListenerBound || typeof window === "undefined") return;
  windowListenerBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== PIN_KEY && event.key !== UNREAD_MARKS_KEY && event.key !== null) return;
    initialized = true;
    pins = readPinsFromStorage();
    marks = readMarksFromStorage();
    notify();
  });
}

// ---------------------------------------------------------------------------
// Pins (the pin-first ordering input; conversation ids, demo or live keys)
// ---------------------------------------------------------------------------

export function readChatPins(): string[] {
  ensureInitialized();
  return pins;
}

/** Pin or unpin; returns the new pin list (insertion order preserved). */
export function toggleChatPin(conversationId: string): string[] {
  ensureInitialized();
  const next = pins.includes(conversationId)
    ? pins.filter((id) => id !== conversationId)
    : [...pins, conversationId];
  pins = next;
  try {
    storage()?.setItem(PIN_KEY, JSON.stringify(next));
  } catch {
    // The session choice still applies for this document.
  }
  notify();
  return next;
}

// ---------------------------------------------------------------------------
// Read/unread overlays ("read" | "unread" | cleared)
// ---------------------------------------------------------------------------

export function readChatUnreadMarks(): ChatUnreadMarks {
  ensureInitialized();
  return marks;
}

export function getChatUnreadMark(conversationId: string): ChatUnreadMark | undefined {
  return readChatUnreadMarks()[conversationId];
}

/**
 * Set or clear (null) the overlay for one conversation. "read" suppresses
 * the runtime unread pill locally; "unread" forces the unread dot (no fake
 * count — the runtime's count stays the count of record).
 */
export function setChatUnreadMark(
  conversationId: string,
  mark: ChatUnreadMark | null,
): ChatUnreadMarks {
  ensureInitialized();
  const next: ChatUnreadMarks = { ...marks };
  if (mark === null) {
    delete next[conversationId];
  } else {
    next[conversationId] = mark;
  }
  marks = next;
  try {
    storage()?.setItem(UNREAD_MARKS_KEY, JSON.stringify(next));
  } catch {
    // The session choice still applies for this document.
  }
  notify();
  return next;
}

// ---------------------------------------------------------------------------
// The hook (server/static snapshot reports the module session choice, so
// component suites opt into state explicitly; first paint carries none).
// ---------------------------------------------------------------------------

const EMPTY_PINS: readonly string[] = [];
const EMPTY_MARKS: ChatUnreadMarks = {};

export interface ChatViewPrefs {
  pins: readonly string[];
  marks: ChatUnreadMarks;
}

function getClientPins(): readonly string[] {
  ensureInitialized();
  return pins;
}

function getClientMarks(): ChatUnreadMarks {
  ensureInitialized();
  return marks;
}

/**
 * Server/static snapshots report the module session state when one was
 * made (component suites opt in explicitly), otherwise the empty defaults —
 * the first paint shows no invented view state.
 */
function getServerPins(): readonly string[] {
  return initialized ? pins : EMPTY_PINS;
}

function getServerMarks(): ChatUnreadMarks {
  return initialized ? marks : EMPTY_MARKS;
}

export function useChatPins(): readonly string[] {
  return useSyncExternalStore(subscribe, getClientPins, getServerPins);
}

export function useChatUnreadMarks(): ChatUnreadMarks {
  return useSyncExternalStore(subscribe, getClientMarks, getServerMarks);
}

export function useChatViewPrefs(): ChatViewPrefs {
  const pinsSnapshot = useChatPins();
  const marksSnapshot = useChatUnreadMarks();
  return useMemo(
    () => ({ pins: pinsSnapshot, marks: marksSnapshot }),
    [pinsSnapshot, marksSnapshot],
  );
}

/** Test hook: back to the truly fresh state (re-reads storage on next use). */
export function resetChatViewPrefsForTests(): void {
  initialized = false;
  pins = [];
  marks = {};
}
