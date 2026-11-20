import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_PINS_STORAGE_KEY,
  CHAT_UNREAD_MARKS_STORAGE_KEY,
  getChatUnreadMark,
  readChatPins,
  readChatUnreadMarks,
  resetChatViewPrefsForTests,
  setChatUnreadMark,
  subscribe,
  toggleChatPin,
  useChatViewPrefs,
} from "../lib/chat-view-prefs";

/**
 * Wave A chunk A2 (D52; E43 §3 pattern, not pixels) — the client-side chat
 * VIEW preference store behind the sidebar row menu. The runtime owns
 * conversation truth; these pins and read/unread overlays live in this
 * browser only (localStorage, never a runtime write). The module follows
 * lib/interface-mode.ts exactly: session cache + useSyncExternalStore +
 * one module-lifetime window storage listener for cross-tab sync, try/catch
 * guards, in-memory fallback.
 */

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return store;
}

const originalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

beforeEach(() => {
  stubStorage();
  resetChatViewPrefsForTests();
});

afterEach(() => {
  globalThis.localStorage = originalStorage;
  if (originalWindow === undefined) {
    // @ts-expect-error -- restoring the node default (no window)
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
  resetChatViewPrefsForTests();
});

describe("chat view preference keys (the persistence contract)", () => {
  it("uses the recorded shera-chat-pins / shera-chat-unread-marks keys", () => {
    expect(CHAT_PINS_STORAGE_KEY).toBe("shera-chat-pins");
    expect(CHAT_UNREAD_MARKS_STORAGE_KEY).toBe("shera-chat-unread-marks");
  });

  it("writes pins and overlays through exactly those keys", () => {
    const store = stubStorage();
    toggleChatPin("conversation_agent_researcher");
    setChatUnreadMark("conversation_agent_researcher", "unread");
    expect(store.get("shera-chat-pins")).toBe(
      JSON.stringify(["conversation_agent_researcher"]),
    );
    expect(store.get("shera-chat-unread-marks")).toBe(
      JSON.stringify({ conversation_agent_researcher: "unread" }),
    );
  });
});

describe("pin view preferences", () => {
  it("starts empty on a fresh document", () => {
    expect(readChatPins()).toEqual([]);
  });

  it("toggleChatPin pins and unpins, keeping insertion order", () => {
    expect(toggleChatPin("conv-a")).toEqual(["conv-a"]);
    expect(toggleChatPin("conv-b")).toEqual(["conv-a", "conv-b"]);
    expect(readChatPins()).toEqual(["conv-a", "conv-b"]);
    expect(toggleChatPin("conv-a")).toEqual(["conv-b"]);
    expect(readChatPins()).toEqual(["conv-b"]);
  });

  it("persists across a session reset (the storage round trip)", () => {
    toggleChatPin("conv-a");
    resetChatViewPrefsForTests();
    expect(readChatPins()).toEqual(["conv-a"]);
  });
});

describe("read/unread overlay preferences", () => {
  it("starts with no overlay entries", () => {
    expect(readChatUnreadMarks()).toEqual({});
    expect(getChatUnreadMark("conv-a")).toBeUndefined();
  });

  it("sets, flips, and clears an overlay per conversation", () => {
    setChatUnreadMark("conv-a", "read");
    setChatUnreadMark("conv-b", "unread");
    expect(getChatUnreadMark("conv-a")).toBe("read");
    expect(getChatUnreadMark("conv-b")).toBe("unread");
    setChatUnreadMark("conv-a", "unread");
    expect(getChatUnreadMark("conv-a")).toBe("unread");
    setChatUnreadMark("conv-a", null);
    expect(getChatUnreadMark("conv-a")).toBeUndefined();
    expect(getChatUnreadMark("conv-b")).toBe("unread");
  });

  it("persists across a session reset (the storage round trip)", () => {
    setChatUnreadMark("conv-a", "read");
    resetChatViewPrefsForTests();
    expect(getChatUnreadMark("conv-a")).toBe("read");
  });
});

describe("corrupted storage resilience", () => {
  it("a corrupted pins payload reads as the empty default", () => {
    stubStorage().set(CHAT_PINS_STORAGE_KEY, "not-json{{");
    resetChatViewPrefsForTests();
    expect(readChatPins()).toEqual([]);
  });

  it("a wrong-shape pins payload (object, number) reads as the empty default", () => {
    const store = stubStorage();
    store.set(CHAT_PINS_STORAGE_KEY, '{"pinned":true}');
    resetChatViewPrefsForTests();
    expect(readChatPins()).toEqual([]);
    store.set(CHAT_PINS_STORAGE_KEY, "3");
    resetChatViewPrefsForTests();
    expect(readChatPins()).toEqual([]);
  });

  it("non-string pin entries are dropped, not fatal", () => {
    stubStorage().set(CHAT_PINS_STORAGE_KEY, '["conv-a", 7, null, "conv-b"]');
    resetChatViewPrefsForTests();
    expect(readChatPins()).toEqual(["conv-a", "conv-b"]);
  });

  it("a corrupted overlay payload reads as the empty default", () => {
    const store = stubStorage();
    store.set(CHAT_UNREAD_MARKS_STORAGE_KEY, "not-json{{");
    resetChatViewPrefsForTests();
    expect(readChatUnreadMarks()).toEqual({});
    store.set(CHAT_UNREAD_MARKS_STORAGE_KEY, '["conv-a"]');
    resetChatViewPrefsForTests();
    expect(readChatUnreadMarks()).toEqual({});
    store.set(CHAT_UNREAD_MARKS_STORAGE_KEY, '{"conv-a":"bogus","conv-b":"read"}');
    resetChatViewPrefsForTests();
    expect(readChatUnreadMarks()).toEqual({ "conv-b": "read" });
  });
});

describe("cross-tab sync (the storage event)", () => {
  it("one window listener serves the module lifetime", () => {
    const addEventListener = vi.fn();
    globalThis.window = { addEventListener, removeEventListener: vi.fn() } as unknown as Window;
    const first = subscribe(() => undefined);
    const second = subscribe(() => undefined);
    first();
    second();
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]?.[0]).toBe("storage");
  });

  it("a storage event for a pref key re-reads the other tab's write and notifies", () => {
    let storageHandler: ((event: { key: string | null }) => void) | undefined;
    globalThis.window = {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") storageHandler = handler;
      },
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const store = stubStorage();
    const seen: string[][] = [];
    const unsubscribe = subscribe(() => seen.push(readChatPins()));

    // Another tab pins a conversation and writes the key directly.
    store.set(CHAT_PINS_STORAGE_KEY, JSON.stringify(["conv-other-tab"]));
    storageHandler?.({ key: CHAT_PINS_STORAGE_KEY });

    expect(readChatPins()).toEqual(["conv-other-tab"]);
    expect(seen).toEqual([["conv-other-tab"]]);
    unsubscribe();
  });

  it("a storage event for an unrelated key does not notify", () => {
    let storageHandler: ((event: { key: string | null }) => void) | undefined;
    globalThis.window = {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (type === "storage") storageHandler = handler;
      },
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const seen: number[] = [];
    const unsubscribe = subscribe(() => seen.push(seen.length));
    storageHandler?.({ key: "unrelated-key" });
    expect(seen).toEqual([]);
    unsubscribe();
  });
});

describe("in-memory fallback (storage unavailable)", () => {
  it("a throwing localStorage still yields a working session store", () => {
    globalThis.localStorage = {
      get getItem(): (key: string) => string | null {
        throw new Error("storage blocked");
      },
    } as unknown as Storage;
    resetChatViewPrefsForTests();
    expect(toggleChatPin("conv-a")).toEqual(["conv-a"]);
    expect(readChatPins()).toEqual(["conv-a"]);
    setChatUnreadMark("conv-a", "read");
    expect(getChatUnreadMark("conv-a")).toBe("read");
  });
});

describe("the useChatViewPrefs hook", () => {
  it("renders the session choice as the static snapshot (suites opt in explicitly)", () => {
    setChatUnreadMark("conversation_agent_researcher", "unread");
    toggleChatPin("conversation_agent_researcher");
    const Probe = () => {
      const { pins, marks } = useChatViewPrefs();
      return createElement(
        "span",
        { "data-testid": "probe" },
        JSON.stringify({ pins, marks }),
      );
    };
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain(
      JSON.stringify({
        pins: ["conversation_agent_researcher"],
        marks: { conversation_agent_researcher: "unread" },
      }),
    );
  });

  it("a fresh session renders the empty defaults (first paint shows no invented state)", () => {
    const Probe = () => {
      const { pins, marks } = useChatViewPrefs();
      return createElement("span", { "data-testid": "probe" }, JSON.stringify({ pins, marks }));
    };
    expect(renderToStaticMarkup(createElement(Probe))).toContain(
      JSON.stringify({ pins: [], marks: {} }),
    );
  });
});
