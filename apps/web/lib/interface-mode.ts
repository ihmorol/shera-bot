"use client";

import { useSyncExternalStore } from "react";

/**
 * Interface mode (owner direction, 2026-11-20): the UI defaults to SIMPLE —
 * one conversation list, the Operation machinery (roster management, pack
 * summary, template gallery, the full settings register) reachable on
 * request — and ADVANCED restores the full documented structure (UI_DESIGN
 * §3.2 sidebar, §S4 operation surface, §S9 settings register). Pattern
 * reference: OpenMausBot's simple/advanced interface mode (E43 note:
 * pattern only, never a base).
 *
 * The choice persists in localStorage; SSR and static renders report the
 * module's session choice (so component suites can opt into the advanced
 * structure explicitly), defaulting to simple.
 */

const ADVANCED_MODE_KEY = "shera-advanced-mode";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readStored(): boolean | undefined {
  try {
    const stored = storage()?.getItem(ADVANCED_MODE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage unavailable (private mode, SSR) — stay simple.
  }
  return undefined;
}

export function readAdvancedMode(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  return readStored() ?? false;
}

export function setAdvancedMode(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(ADVANCED_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // The session choice still applies for this document.
  }
  for (const listener of listeners) listener();
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
 * subscribe, never removed — the module lives as long as the page): React
 * remount cycles must not accumulate duplicate storage handlers.
 */
let windowListenerBound = false;
function ensureWindowListener(): void {
  if (windowListenerBound || typeof window === "undefined") return;
  windowListenerBound = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== ADVANCED_MODE_KEY && event.key !== null) return;
    sessionChoice = undefined;
    for (const other of listeners) other();
  });
}

/**
 * Server/static snapshot: the module session choice when one was made
 * (component suites opt into advanced explicitly), otherwise simple —
 * the first paint a real user sees is the minimal UI.
 */
export function useAdvancedMode(): boolean {
  return useSyncExternalStore(subscribe, readAdvancedMode, () => sessionChoice ?? false);
}

/** Test hook: back to the truly fresh state (no session choice, storage read). */
export function resetSessionChoice(): void {
  sessionChoice = undefined;
}
