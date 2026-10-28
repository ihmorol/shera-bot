import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CHAT_MIN_WIDTH,
  KEYBOARD_RESIZE_LARGE_STEP,
  KEYBOARD_RESIZE_STEP,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  type PanelAction,
  type PanelPrefs,
  type PanelState,
  type PanelWidthState,
  initialPanelState,
  isMobileViewport,
  loadPanelPrefs,
  panelPrefsStorageKey,
  panelReducer,
  prefsFromState,
  savePanelPrefs,
} from "../lib/workspace-panel";
import {
  WorkspaceLeaseConflictError,
  base64ToBytes,
  childrenOf,
  createWorkspaceDirectory,
  deleteWorkspaceNode,
  fetchWorkspaceNodes,
  formatBytes,
  readWorkspaceFile,
  uploadWorkspaceFile,
  workspaceUriForPath,
  workspaceUriSegments,
} from "../lib/workspace-api";
import { FilesTabView } from "../components/workspace/files-tab";
import { TabComingSoon, WORKSPACE_TABS } from "../components/workspace/panel-tabs";
import type { WorkspaceNode } from "../lib/workspace-api";

/**
 * S17 chunk 4 component + client tests for the workspace panel host (UI_DESIGN
 * §4 S7, §2.2 docked states) and the Files tab against the REAL local-API
 * surface through the same-origin proxy. The suite follows the apps/web test
 * convention: node-environment static markup for components, vi.stubGlobal
 * fetch mocks at the client seam (lib/workspace-api.ts), and source reads for
 * wiring that only exists inside event handlers (the same idiom as the 360px
 * block in chat-view.test.ts).
 */

const APP_DIR = join(import.meta.dirname, "..");
const WORKSPACE = "workspace_demo";
const CHAT = "conversation_agent_researcher";

const render = (element: ReactElement): string => renderToStaticMarkup(element);

// ---------------------------------------------------------------------------
// Fixtures — the shapes the S17 route module answers (nodeJson verbatim)
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<WorkspaceNode> & { name: string }): WorkspaceNode {
  return {
    id: `node_${overrides.name}`,
    workspace_id: WORKSPACE,
    scope: "workspace",
    agent_id: null,
    parent_id: null,
    is_directory: false,
    size: 12,
    mime_type: "text/markdown",
    created_by_type: "user",
    created_by_id: "user_emon",
    created_at: "2026-10-28T09:00:00Z",
    updated_at: "2026-10-28T09:00:00Z",
    ...overrides,
  };
}

const TREE_NODES: WorkspaceNode[] = [
  makeNode({ name: "docs", is_directory: true, size: 0, mime_type: null }),
  makeNode({ name: "report.md", size: 2048 }),
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// 1. Panel state machine — 0 / 360 / 50% / full-page (UI_DESIGN S7 entry)
// ---------------------------------------------------------------------------

describe("panel state machine (S7 docked states)", () => {
  const VW = 1440;

  it("starts closed (0) and opens inline at the 360px default", () => {
    const opened = panelReducer(initialPanelState(), { type: "open", viewportWidth: VW });
    expect(opened.widthState).toEqual({ kind: "inline", width: PANEL_DEFAULT_WIDTH });
    expect(PANEL_DEFAULT_WIDTH).toBe(360);
    expect(initialPanelState().widthState).toEqual({ kind: "closed" });
  });

  it("cycles the chat-header toggle: closed → 360 → 50% → full-page request", () => {
    let state = initialPanelState();
    let fullPageRequests = 0;
    const onOpenFullPage = () => {
      fullPageRequests += 1;
    };

    state = panelReducer(state, { type: "chatHeaderToggle", viewportWidth: VW, onOpenFullPage });
    expect(state.widthState).toEqual({ kind: "inline", width: 360 });
    expect(fullPageRequests).toBe(0);

    state = panelReducer(state, { type: "chatHeaderToggle", viewportWidth: VW, onOpenFullPage });
    expect(state.widthState.kind).toBe("inline");
    const half = (state.widthState as { kind: "inline"; width: number }).width;
    expect(half).toBe(Math.floor(VW / 2));
    expect(fullPageRequests).toBe(0);

    state = panelReducer(state, { type: "chatHeaderToggle", viewportWidth: VW, onOpenFullPage });
    expect(fullPageRequests).toBe(1);
    // The inline state is unchanged — the full page is a ROUTE, not a width.
    expect(state.widthState).toEqual({ kind: "inline", width: half });
  });

  it("closes from any inline width; closing keeps the width for the next open", () => {
    let state = panelReducer(initialPanelState(), {
      type: "open",
      viewportWidth: VW,
      preferredWidth: 480,
    });
    state = panelReducer(state, { type: "close" });
    expect(state.widthState).toEqual({ kind: "closed" });
    state = panelReducer(state, { type: "open", viewportWidth: VW, preferredWidth: 480 });
    expect(state.widthState).toEqual({ kind: "inline", width: 480 });
  });

  it("clamps resizes: panel never smaller than 320px, chat never under its own minimum", () => {
    const wide = panelReducer(initialPanelState(), {
      type: "open",
      viewportWidth: 700,
    });
    // Max width leaves the chat CHAT_MIN_WIDTH: 700 - 320 = 380.
    const maxed = panelReducer(wide, { type: "keyboardMax", viewportWidth: 700 });
    expect((maxed.widthState as { width: number }).width).toBe(700 - CHAT_MIN_WIDTH);
    expect(CHAT_MIN_WIDTH).toBe(320);

    const narrowed = panelReducer(maxed, { type: "keyboardMin" });
    expect((narrowed.widthState as { width: number }).width).toBe(PANEL_MIN_WIDTH);
    expect(PANEL_MIN_WIDTH).toBe(320);
  });

  it("reset returns to the 360 default", () => {
    let state = panelReducer(initialPanelState(), { type: "showHalf", viewportWidth: VW });
    state = panelReducer(state, { type: "reset", viewportWidth: VW });
    expect(state.widthState).toEqual({ kind: "inline", width: PANEL_DEFAULT_WIDTH });
  });
});

// ---------------------------------------------------------------------------
// 2. Drag resize — single owner (pointer capture), cancel restores
// ---------------------------------------------------------------------------

describe("drag resize (single-owner resize state)", () => {
  const VW = 1440;

  function dragging(): PanelState {
    const state = panelReducer(initialPanelState(), { type: "open", viewportWidth: VW });
    return panelReducer(state, { type: "dragStart", pointerX: 1000 });
  }

  it("sizes from the drag START width — moves never accumulate", () => {
    let state = dragging();
    state = panelReducer(state, { type: "dragMove", pointerX: 960 }); // widen 40
    expect((state.widthState as { width: number }).width).toBe(360 + 40);
    state = panelReducer(state, { type: "dragMove", pointerX: 990 }); // widen 10, from START
    expect((state.widthState as { width: number }).width).toBe(360 + 10);
  });

  it("widens when the pointer moves LEFT (the panel docks right of the chat)", () => {
    const state = panelReducer(dragging(), { type: "dragMove", pointerX: 900 });
    expect((state.widthState as { width: number }).width).toBe(360 + 100);
  });

  it("clamps during the drag, not only at commit", () => {
    const state = panelReducer(dragging(), { type: "dragMove", pointerX: 0 });
    expect((state.widthState as { width: number }).width).toBe(VW - CHAT_MIN_WIDTH);
  });

  it("while a drag owns the resize, keyboard actions are ignored (no fighting)", () => {
    let state = panelReducer(dragging(), { type: "dragMove", pointerX: 960 });
    state = panelReducer(state, {
      type: "keyboardResize",
      direction: "widen",
      viewportWidth: VW,
    });
    expect((state.widthState as { width: number }).width).toBe(400);

    state = panelReducer(state, { type: "dragEnd" });
    // Ownership released: keyboard works again.
    state = panelReducer(state, {
      type: "keyboardResize",
      direction: "narrow",
      viewportWidth: VW,
    });
    expect((state.widthState as { width: number }).width).toBe(400 - KEYBOARD_RESIZE_STEP);
  });

  it("endDrag commits; cancel restores the starting width (Escape / pointercancel)", () => {
    const committed = panelReducer(dragging(), { type: "dragEnd" });
    expect((committed.widthState as { width: number }).width).toBe(360);
    expect(committed.drag).toBeNull();

    const cancelled = panelReducer(
      panelReducer(dragging(), { type: "dragMove", pointerX: 900 }),
      { type: "dragCancel" },
    );
    expect((cancelled.widthState as { width: number }).width).toBe(360);
    expect(cancelled.drag).toBeNull();
  });

  it("a press/release with no movement does not change the width", () => {
    const state = panelReducer(dragging(), { type: "dragEnd" });
    expect((state.widthState as { width: number }).width).toBe(360);
  });
});

// ---------------------------------------------------------------------------
// 3. Keyboard resize operability (mockup §8 divider semantics)
// ---------------------------------------------------------------------------

describe("keyboard resize", () => {
  const VW = 1440;

  function open(): PanelState {
    return panelReducer(initialPanelState(), { type: "open", viewportWidth: VW });
  }

  it("arrows step 16px; with Shift 48px; Left widens the right-docked panel", () => {
    expect(KEYBOARD_RESIZE_STEP).toBe(16);
    expect(KEYBOARD_RESIZE_LARGE_STEP).toBe(48);
    const widened = panelReducer(open(), { type: "keyboardResize", direction: "widen", viewportWidth: VW });
    expect((widened.widthState as { width: number }).width).toBe(360 + 16);
    const large = panelReducer(open(), {
      type: "keyboardResize",
      direction: "narrow",
      large: true,
      viewportWidth: VW,
    });
    expect((large.widthState as { width: number }).width).toBe(360 - 48);
  });

  it("Home/End reach the min/max limits and Enter resets to 360", () => {
    const min = panelReducer(open(), { type: "keyboardMin" });
    expect((min.widthState as { width: number }).width).toBe(PANEL_MIN_WIDTH);
    const max = panelReducer(open(), { type: "keyboardMax", viewportWidth: VW });
    expect((max.widthState as { width: number }).width).toBe(VW - CHAT_MIN_WIDTH);
    const reset = panelReducer(max, { type: "keyboardReset" });
    expect((reset.widthState as { width: number }).width).toBe(PANEL_DEFAULT_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// 4. Per-conversation persistence (width + membership)
// ---------------------------------------------------------------------------

describe("per-conversation panel persistence", () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key) => (map.has(key) ? map.get(key)! : null),
      key: (index) => Array.from(map.keys())[index] ?? null,
      removeItem: (key) => {
        map.delete(key);
      },
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it("keys preferences by conversation id", () => {
    expect(panelPrefsStorageKey(CHAT)).toBe(`shera.workspace-panel.${CHAT}`);
  });

  it("saves and reloads width + open state per conversation, isolated between chats", () => {
    const storage = memoryStorage();
    const prefs: PanelPrefs = { open: true, width: 512 };
    savePanelPrefs(CHAT, prefs, storage);
    expect(loadPanelPrefs(CHAT, storage)).toEqual(prefs);
    expect(loadPanelPrefs("conversation_other", storage)).toBeNull();

    savePanelPrefs(CHAT, { open: false, width: 512 }, storage);
    expect(loadPanelPrefs(CHAT, storage)).toEqual({ open: false, width: 512 });
  });

  it("derives the persisted prefs from the panel state", () => {
    const closed = initialPanelState();
    expect(prefsFromState(closed)).toEqual({ open: false, width: PANEL_DEFAULT_WIDTH });
    const open = panelReducer(closed, { type: "open", viewportWidth: 1440 });
    expect(prefsFromState(open)).toEqual({ open: true, width: 360 });
  });

  it("corrupt storage is answered with null, never a crash or fake defaults", () => {
    const storage = memoryStorage();
    storage.setItem(panelPrefsStorageKey(CHAT), "{not json");
    expect(loadPanelPrefs(CHAT, storage)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Viewport mode (mobile bottom sheet < 768px)
// ---------------------------------------------------------------------------

describe("viewport mode", () => {
  it("below 768px the docked panel renders as a bottom sheet, not a resized column", () => {
    const query = (matches: boolean) =>
      ({ matches, media: "(max-width: 767px)" }) as MediaQueryList;
    expect(isMobileViewport(query(false))).toBe(false);
    expect(isMobileViewport(query(true))).toBe(true);
  });

  it("the panel host wires the mobile sheet through the md breakpoint", () => {
    const source = readFileSync(
      join(APP_DIR, "components/workspace/workspace-panel.tsx"),
      "utf8",
    );
    expect(source).toMatch(/isMobileViewport/);
    expect(source).toMatch(/bottom sheet|sheet|BottomSheet/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Workspace client — the REAL S17 routes through the same-origin proxy
// ---------------------------------------------------------------------------

describe("workspace client (S17 local-API seam)", () => {
  it("fetchWorkspaceNodes GETs the nodes route with the D4 user actor and parses rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { nodes: TREE_NODES }));
    vi.stubGlobal("fetch", fetchMock);

    const nodes = await fetchWorkspaceNodes(WORKSPACE, "workspace://");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ name: "docs", is_directory: true });

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path);
    expect(url.pathname).toBe("/api/runtime/v1/workspace/nodes");
    expect(url.searchParams.get("workspace_id")).toBe(WORKSPACE);
    expect(url.searchParams.get("path")).toBe("workspace://");
    expect(url.searchParams.get("actor_type")).toBe("user");
    expect(url.searchParams.get("actor_id")).toBe("user_emon");
  });

  it("uploadWorkspaceFile POSTs the base64 body with the user actor (prototype convention)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { node: makeNode({ name: "note.txt", size: 5 }) }));
    vi.stubGlobal("fetch", fetchMock);

    const node = await uploadWorkspaceFile(
      WORKSPACE,
      "workspace://docs/note.txt",
      new TextEncoder().encode("hello"),
      "text/plain",
    );
    expect(node.name).toBe("note.txt");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/workspace/files/upload");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace_id: WORKSPACE,
      path: "workspace://docs/note.txt",
      actor: { type: "user", id: "user_emon" },
      mime_type: "text/plain",
    });
    // "hello" in base64 — the binary rides the JSON body byte-exact.
    expect(body["content_base64"]).toBe("aGVsbG8=");
  });

  it("createWorkspaceDirectory and deleteWorkspaceNode hit the typed routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { node: makeNode({ name: "new-folder", is_directory: true }) }))
      .mockResolvedValueOnce(
        jsonResponse(200, { node: makeNode({ name: "new-folder", is_directory: true }) }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { deleted: true }));
    vi.stubGlobal("fetch", fetchMock);

    await createWorkspaceDirectory(WORKSPACE, "workspace://new-folder");
    await deleteWorkspaceNode(WORKSPACE, "workspace://docs", { recursive: true });

    const [mkdirPath, mkdirInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(mkdirPath).toBe("/api/runtime/v1/workspace/directories");
    const mkdirBody = JSON.parse(mkdirInit.body as string) as Record<string, unknown>;
    expect(mkdirBody).toMatchObject({
      workspace_id: WORKSPACE,
      path: "workspace://new-folder",
      actor: { type: "user" },
    });

    const [deletePath, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(deletePath).toBe("/api/runtime/v1/workspace/delete");
    const deleteBody = JSON.parse(deleteInit.body as string) as Record<string, unknown>;
    expect(deleteBody).toMatchObject({ path: "workspace://docs", recursive: true });
  });

  it("readWorkspaceFile decodes the base64 content to bytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        node: makeNode({ name: "report.md", size: 6 }),
        mime_type: "text/markdown",
        size: 6,
        content_base64: "IyBoZWxsby4=",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await readWorkspaceFile(WORKSPACE, "workspace://report.md");
    expect(file.size).toBe(6);
    expect(new TextDecoder().decode(file.bytes)).toBe("# hello.");
  });

  it("surfaces the WRITE_LEASE_CONFLICT 409 as a typed conflict (G5 — API data, never invented)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        code: "WRITE_LEASE_CONFLICT",
        category: "conflict",
        safe_message: "This file is being edited by an Agent task.",
        retryable: false,
        user_action: "Wait for the task to finish, or read the file.",
        internal_details: {
          write_lease_conflict: {
            holding_agent_id: "agent_developer",
            holding_agent_name: "Developer",
            task_id: "task_4",
            path: "workspace://docs/report.md",
          },
        },
        correlation_id: "corr_1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await uploadWorkspaceFile(
      WORKSPACE,
      "workspace://docs/report.md",
      new TextEncoder().encode("x"),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceLeaseConflictError);
    const conflict = error as WorkspaceLeaseConflictError;
    expect(conflict.holding_agent_name).toBe("Developer");
    expect(conflict.task_id).toBe("task_4");
    expect(conflict.safeMessage).toBe("This file is being edited by an Agent task.");
  });

  it("builds workspace:// URIs and reads them back as display segments", () => {
    expect(workspaceUriForPath([])).toBe("workspace://");
    expect(workspaceUriForPath(["docs", "sub"])).toBe("workspace://docs/sub");
    expect(workspaceUriSegments("workspace://docs/sub")).toEqual(["docs", "sub"]);
    expect(workspaceUriSegments("workspace://")).toEqual([]);
  });

  it("orders directory listings folders-first and formats sizes for the rows", () => {
    const nodes = [
      makeNode({ name: "z-report.md", size: 2048 }),
      makeNode({ name: "a-folder", is_directory: true, size: 0, mime_type: null }),
      makeNode({ name: "b-folder", is_directory: true, size: 0, mime_type: null }),
      makeNode({ name: "a-file.txt", size: 3 }),
    ];
    const ordered = childrenOf(nodes);
    expect(ordered.map((node) => node.name)).toEqual(["a-folder", "b-folder", "a-file.txt", "z-report.md"]);
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("base64ToBytes decodes byte-exact (the download path)", () => {
    const bytes = base64ToBytes("aGVsbG8=");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// 7. Files tab — tree browser rendering the real rows + §2.4 states
// ---------------------------------------------------------------------------

describe("Files tab (workspace:// tree browser)", () => {
  const baseProps = {
    workspaceId: WORKSPACE,
    state: "ready" as const,
    nodes: TREE_NODES,
    currentUri: "workspace://",
    safeErrorMessage: undefined,
    onNavigate: () => undefined,
    onDownload: () => undefined,
    onRequestDelete: () => undefined,
    deleteTarget: null,
    onCancelDelete: () => undefined,
    onConfirmDelete: () => undefined,
    deletePending: false,
    onCreateDirectory: () => undefined,
    createPending: false,
    onUploadFiles: () => undefined,
    uploadPending: false,
    conflictMessage: null,
  };

  it("renders the real API rows: folder navigates, file carries size + date", () => {
    const html = render(createElement(FilesTabView, baseProps));
    expect(html).toContain("docs");
    expect(html).toContain("report.md");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("workspace://");
    // Folder row is a navigation control with an accessible name.
    expect(html).toMatch(/aria-label="Open folder docs"/);
  });

  it("download and delete affordances are named controls on file rows", () => {
    const html = render(createElement(FilesTabView, baseProps));
    expect(html).toMatch(/aria-label="Download report\.md"/);
    expect(html).toMatch(/aria-label="Delete report\.md"/);
  });

  it("empty state explains and offers the upload action (§2.4)", () => {
    const html = render(
      createElement(FilesTabView, { ...baseProps, state: "ready", nodes: [] }),
    );
    expect(html).toContain("No files yet");
    expect(html).toContain("Upload a file");
  });

  it("loading state is a layout-matched skeleton, never a spinner", () => {
    const html = render(createElement(FilesTabView, { ...baseProps, state: "loading", nodes: [] }));
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("<svg");
  });

  it("error state carries the safe_message with retry (D23 rule 4)", () => {
    const html = render(
      createElement(FilesTabView, {
        ...baseProps,
        state: "error",
        nodes: [],
        safeErrorMessage: "The workspace files could not be loaded.",
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The workspace files could not be loaded.");
    expect(html).toContain("Retry");
  });

  it("a lease conflict on write renders the API-provided holder + task (G5)", () => {
    const html = render(
      createElement(FilesTabView, {
        ...baseProps,
        conflictMessage: "Developer is editing this file · task task_4",
      }),
    );
    expect(html).toContain("Developer is editing this file · task task_4");
  });
});

// ---------------------------------------------------------------------------
// 8. Delete confirmation gate (G6 — delete is never automatic, PRD §12)
// ---------------------------------------------------------------------------

describe("delete confirmation gate", () => {
  const baseProps = {
    workspaceId: WORKSPACE,
    state: "ready" as const,
    nodes: TREE_NODES,
    currentUri: "workspace://",
    safeErrorMessage: undefined,
    onNavigate: () => undefined,
    onDownload: () => undefined,
    onRequestDelete: () => undefined,
    deleteTarget: null as { uri: string; name: string; isDirectory: boolean } | null,
    onCancelDelete: () => undefined,
    onConfirmDelete: () => undefined,
    deletePending: false,
    onCreateDirectory: () => undefined,
    createPending: false,
    onUploadFiles: () => undefined,
    uploadPending: false,
    conflictMessage: null,
  };

  it("without a confirmed target there is no delete-call affordance — only the row opener", () => {
    const html = render(createElement(FilesTabView, baseProps));
    expect(html).not.toContain("Delete file");
    expect(html).not.toContain('data-testid="delete-confirm"');
  });

  it("the confirmation dialog NAMES the file before the delete can fire", () => {
    const html = render(
      createElement(FilesTabView, {
        ...baseProps,
        deleteTarget: { uri: "workspace://report.md", name: "report.md", isDirectory: false },
      }),
    );
    expect(html).toContain('data-testid="delete-confirm"');
    expect(html).toContain("Delete report.md");
    expect(html).toContain("This permanently removes");
    // The destructive confirm is the ONLY trigger of the delete call.
    expect(html).toMatch(/data-testid="delete-confirm-action"/);
    expect(html).toContain("Cancel");
  });

  it("a folder target warns about its whole subtree (recursive)", () => {
    const html = render(
      createElement(FilesTabView, {
        ...baseProps,
        deleteTarget: { uri: "workspace://docs", name: "docs", isDirectory: true },
      }),
    );
    expect(html).toContain("and everything inside it");
  });

  it("the row delete button only OPENS the confirmation — the mutation lives behind it", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/files-tab.tsx"), "utf8");
    // The row control hands the node to the gate; the delete client call is
    // reachable only from the dialog's confirm handler.
    expect(source).toMatch(/onRequestDelete=\{/);
    expect(source).toMatch(/onConfirmDelete=\{\(\) =>/);
    const dialogConfirm = source.indexOf("delete-confirm-action");
    const deleteCall = source.indexOf("deleteNodeMutation");
    expect(dialogConfirm).toBeGreaterThanOrEqual(0);
    expect(deleteCall).toBeGreaterThan(dialogConfirm);
  });
});

// ---------------------------------------------------------------------------
// 9. Panel chrome — the tab strip and the honest not-yet tabs
// ---------------------------------------------------------------------------

describe("panel chrome (tab strip + honest empty tabs)", () => {
  it("exposes exactly the chunk-4 tab set with accessible names", () => {
    expect(WORKSPACE_TABS.map((tab) => tab.id)).toEqual(["files", "editor", "private", "artifacts"]);
    expect(WORKSPACE_TABS.map((tab) => tab.label)).toEqual([
      "Files",
      "Editor",
      "Private files",
      "Artifacts",
    ]);
  });

  it("the not-yet tabs render a designed lands-next-increment state, not a stub box", () => {
    const html = render(createElement(TabComingSoon, { tabLabel: "Editor" }));
    expect(html).toContain("Editor");
    expect(html).toContain("lands in the next build increment");
    expect(html).not.toContain("placeholder");
  });
});

// ---------------------------------------------------------------------------
// 10. Panel host wiring — route-level composition (source reads)
// ---------------------------------------------------------------------------

describe("panel host routes", () => {
  it("the full-page route renders the host full-page with a Back-to-chat affordance", () => {
    const source = readFileSync(
      join(APP_DIR, "app/app/chat/[chatId]/workspace/full/page.tsx"),
      "utf8",
    );
    expect(source).toMatch(/WorkspacePanelHost|WorkspaceFullSurface/);
    expect(source).toContain("Back to chat");
    expect(source).toMatch(/router\.back|history\.back/);
  });

  it("the inline route renders the per-conversation panel (persisted width)", () => {
    const source = readFileSync(join(APP_DIR, "app/app/chat/[chatId]/workspace/page.tsx"), "utf8");
    expect(source).toMatch(/WorkspacePanelHost|WorkspacePanelSurface/);
    expect(source).toContain("Open full page");
  });

  it("the docked host owns the persisted panel state machine per conversation", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/workspace-panel.tsx"), "utf8");
    expect(source).toMatch(/panelReducer/);
    expect(source).toMatch(/loadPanelPrefs|savePanelPrefs/);
    expect(source).toMatch(/setPointerCapture/);
    // Escape cancels an active drag; pointercancel/lostcapture too.
    expect(source).toMatch(/dragCancel/);
  });

  it("the full-page and inline surfaces are deep-linkable through the route builders", () => {
    const routes = readFileSync(join(APP_DIR, "lib/routes.ts"), "utf8");
    expect(routes).toContain("workspace:");
    expect(routes).toContain("workspaceFull:");
  });
});

// ---------------------------------------------------------------------------
// Type-level pins (compile-time contract for the state machine)
// ---------------------------------------------------------------------------

describe("panel state types", () => {
  it("models exactly closed and inline width states", () => {
    const states: PanelWidthState[] = [{ kind: "closed" }, { kind: "inline", width: 360 }];
    expect(states).toHaveLength(2);
    const action: PanelAction = { type: "close" };
    expect(action.type).toBe("close");
  });
});
