import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceLeaseConflictError,
  fetchWorkspaceArtifacts,
  fetchWorkspaceNodesAs,
  isTextMime,
  readWorkspaceArtifact,
  readWorkspaceFileAs,
  writeWorkspaceFile,
  type WorkspaceArtifact,
  type WorkspaceNode,
} from "../lib/workspace-api";
import { EditorTabView } from "../components/workspace/editor-tab";
import { PrivateFilesTabView } from "../components/workspace/private-files-tab";
import { ArtifactsTabView } from "../components/workspace/artifacts-tab";
import { workspaceFullBackMarkerKey } from "../lib/workspace-panel";

/**
 * S17 chunk 5 tests — the Editor tab (CodeMirror 6 save path + the D6
 * lease-conflict disabled state, G5), the Private files tab (agent://<id>/
 * scopes through the actor-parameterized reads, D39), and the Artifacts tab
 * (cards with real provenance + the byte-exact download, §5 artifact card).
 * The suite follows the apps/web test convention: node-environment static
 * markup for the presentational views, vi.stubGlobal fetch mocks at the
 * client seam (lib/workspace-api.ts), and source reads for wiring that only
 * exists inside event handlers (the idiom of workspace-panel.test.ts).
 */

const APP_DIR = join(import.meta.dirname, "..");
const WORKSPACE = "workspace_demo";

const render = (element: ReactElement): string => renderToStaticMarkup(element);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

function makeArtifact(overrides: Partial<WorkspaceArtifact> & { name: string }): WorkspaceArtifact {
  return {
    artifact_id: `artifact_${overrides.name}`,
    workspace_id: WORKSPACE,
    name: overrides.name,
    artifact_type: "document",
    size: 2048,
    mime_type: "text/markdown",
    producer_agent_id: "agent_developer",
    producer_task_id: "task_4",
    created_at: "2026-10-28T09:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Editor save path — the user's own edit is a user action (PUT, D4 actor)
// ---------------------------------------------------------------------------

describe("editor save path (client seam)", () => {
  it("writeWorkspaceFile PUTs the written content with the user actor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { node: makeNode({ name: "notes.md", size: 9 }) }));
    vi.stubGlobal("fetch", fetchMock);

    const node = await writeWorkspaceFile(WORKSPACE, "workspace://notes.md", "# rewritten");
    expect(node.name).toBe("notes.md");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/workspace/files");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      workspace_id: WORKSPACE,
      path: "workspace://notes.md",
      actor: { type: "user", id: "user_emon" },
      content: "# rewritten",
    });
  });

  it("a WRITE_LEASE_CONFLICT 409 on save carries the G5 tooltip (Agent + task, API data)", async () => {
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
            path: "workspace://notes.md",
          },
        },
        correlation_id: "corr_1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await writeWorkspaceFile(WORKSPACE, "workspace://notes.md", "x").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WorkspaceLeaseConflictError);
    const conflict = error as InstanceType<typeof WorkspaceLeaseConflictError>;
    expect(conflict.tooltip).toBe("Developer is editing this file · task task_4");
  });
});

// ---------------------------------------------------------------------------
// 2. Actor-parameterized reads — the Private tab's agent://<id>/ scopes (D39)
// ---------------------------------------------------------------------------

describe("actor-parameterized reads (agent:// scopes)", () => {
  it("fetchWorkspaceNodesAs lists an agent scope with the AGENT as the reading actor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { nodes: [makeNode({ name: "draft.md", scope: "agent" })] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const nodes = await fetchWorkspaceNodesAs(WORKSPACE, "agent://agent_researcher/", {
      type: "agent",
      id: "agent_researcher",
    });
    expect(nodes[0]).toMatchObject({ name: "draft.md", scope: "agent" });

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/runtime/v1/workspace/nodes");
    expect(url.searchParams.get("workspace_id")).toBe(WORKSPACE);
    expect(url.searchParams.get("path")).toBe("agent://agent_researcher/");
    expect(url.searchParams.get("actor_type")).toBe("agent");
    expect(url.searchParams.get("actor_id")).toBe("agent_researcher");
  });

  it("readWorkspaceFileAs reads one agent-scoped file with the agent actor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        node: makeNode({ name: "draft.md", size: 6, scope: "agent" }),
        mime_type: "text/markdown",
        size: 6,
        content_base64: "ZHJhZnQh",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await readWorkspaceFileAs(WORKSPACE, "agent://agent_researcher/draft.md", {
      type: "agent",
      id: "agent_researcher",
    });
    expect(new TextDecoder().decode(file.bytes)).toBe("draft!");

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path, "http://localhost");
    expect(url.searchParams.get("path")).toBe("agent://agent_researcher/draft.md");
    expect(url.searchParams.get("actor_type")).toBe("agent");
  });

  it("the read model survives the real API's is_directory 0/1 serialization", async () => {
    // The storage layer answers is_directory as 0|1 (INTEGER); the client's
    // read model normalizes it so the tree/editor never drfit on real data.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        nodes: [
          { ...makeNode({ name: "docs" }), is_directory: 1 },
          { ...makeNode({ name: "report.md" }), is_directory: 0 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const nodes = await fetchWorkspaceNodesAs(WORKSPACE, "workspace://", {
      type: "user",
      id: "user_emon",
    });
    expect(nodes.map((node) => node.is_directory)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// 3. Artifacts client — the E12 list and the byte-exact download
// ---------------------------------------------------------------------------

describe("artifacts client (list + download)", () => {
  it("fetchWorkspaceArtifacts lists by workspace (E12); the count is the list's", async () => {
    const artifacts = [makeArtifact({ name: "sources.md" }), makeArtifact({ name: "bib.tex" })];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { artifacts }));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await fetchWorkspaceArtifacts(WORKSPACE);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      name: "sources.md",
      producer_agent_id: "agent_developer",
      producer_task_id: "task_4",
    });

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/runtime/v1/workspace/artifacts");
    expect(url.searchParams.get("workspace_id")).toBe(WORKSPACE);
    expect(url.searchParams.has("task_id")).toBe(false);
  });

  it("fetchWorkspaceArtifacts narrows to one run when task context exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { artifacts: [makeArtifact({ name: "sources.md" })] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWorkspaceArtifacts(WORKSPACE, "task_4");
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(new URL(path, "http://localhost").searchParams.get("task_id")).toBe("task_4");
  });

  it("readWorkspaceArtifact GETs the byte-exact download route and decodes the bytes", async () => {
    const artifact = makeArtifact({ name: "sources.md", size: 6 });
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        artifact,
        mime_type: "text/markdown",
        size: 6,
        content_base64: "IyBoaQo=",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await readWorkspaceArtifact(WORKSPACE, artifact.artifact_id);
    expect(new TextDecoder().decode(file.bytes)).toBe("# hi\n");
    expect(file.artifact.producer_task_id).toBe("task_4");

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe(`/api/runtime/v1/workspace/artifacts/${artifact.artifact_id}`);
    expect(url.searchParams.get("workspace_id")).toBe(WORKSPACE);
  });
});

// ---------------------------------------------------------------------------
// 4. Text detection — the editor's binary boundary
// ---------------------------------------------------------------------------

describe("isTextMime (editor boundary)", () => {
  it("text mimes and unknown/null mimes edit as text; binary mimes refuse", () => {
    expect(isTextMime("text/markdown")).toBe(true);
    expect(isTextMime("text/plain")).toBe(true);
    expect(isTextMime("application/json")).toBe(true);
    expect(isTextMime(null)).toBe(true); // unknown mime: attempt text honestly
    expect(isTextMime("image/png")).toBe(false);
    expect(isTextMime("application/pdf")).toBe(false);
    expect(isTextMime("application/octet-stream")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Editor tab view — states, the G5 disabled lock, and the dirty indicator
// ---------------------------------------------------------------------------

describe("Editor tab view", () => {
  const baseProps = {
    workspaceId: WORKSPACE,
    openPath: null,
    loadState: "idle" as const,
    safeErrorMessage: undefined,
    onRetry: undefined,
    onOpenPath: () => undefined,
    content: null,
    size: 0,
    mimeType: null,
    isText: true,
    dirty: false,
    saveState: "idle" as const,
    saveSafeError: undefined,
    onSave: () => undefined,
    leaseLocked: false,
    conflictTooltip: null,
    editorSlot: null,
  };

  it("renders an inline open-by-path control bound to the workspace scope", () => {
    const html = render(createElement(EditorTabView, baseProps));
    expect(html).toMatch(/aria-label="File path"/);
    expect(html).toContain("workspace://");
    expect(html).toContain("Open");
  });

  it("an open text file shows its path, size, and the editor surface", () => {
    const html = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# hello",
        size: 7,
        mimeType: "text/markdown",
      }),
    );
    expect(html).toContain("workspace://notes.md");
    expect(html).toContain("7 B");
    expect(html).toContain('data-testid="workspace-editor-surface"');
  });

  it("a binary file refuses editing honestly: a read-only notice with mime + size", () => {
    const html = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://photo.png",
        loadState: "ready",
        content: null,
        size: 20480,
        mimeType: "image/png",
        isText: false,
      }),
    );
    expect(html).toContain('data-testid="editor-binary-notice"');
    expect(html).toContain("binary file");
    expect(html).toContain("image/png");
    expect(html).toContain("20.0 KB");
    // No editor mounts and no save fires for bytes the editor cannot edit.
    expect(html).not.toContain('data-testid="editor-save"');
  });

  it("the lease-conflict disabled state names the holding Agent and task verbatim (G5)", () => {
    const html = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# hello",
        size: 7,
        mimeType: "text/markdown",
        leaseLocked: true,
        conflictTooltip: "Developer is editing this file · task task_4",
      }),
    );
    expect(html).toContain('data-testid="editor-lease-lock"');
    expect(html).toContain("Developer is editing this file · task task_4");
    // The editor surface renders DISABLED (locked) — but the file itself
    // still renders: concurrent reads stay allowed while the Agent writes.
    expect(html).toMatch(/data-lease-locked="true"/);
    expect(html).toContain("workspace://notes.md");
    expect(html).toMatch(/disabled/);
  });

  it("the dirty indicator and save states are honest at every step", () => {
    const clean = render(createElement(EditorTabView, baseProps));
    expect(clean).not.toContain("Unsaved changes");

    const dirty = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# edited",
        size: 8,
        mimeType: "text/markdown",
        dirty: true,
      }),
    );
    expect(dirty).toContain("Unsaved changes");
    expect(dirty).toMatch(/data-testid="editor-save"/);
    expect(dirty).not.toMatch(/data-testid="editor-save"[^>]*disabled/);

    const saving = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# edited",
        size: 8,
        mimeType: "text/markdown",
        dirty: true,
        saveState: "saving",
      }),
    );
    expect(saving).toContain("Saving");

    const saved = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# edited",
        size: 8,
        mimeType: "text/markdown",
        dirty: false,
        saveState: "saved",
      }),
    );
    expect(saved).toContain("Saved");
  });

  it("a save failure renders the typed safe_message with role=alert", () => {
    const html = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://notes.md",
        loadState: "ready",
        content: "# edited",
        size: 8,
        mimeType: "text/markdown",
        dirty: true,
        saveState: "error",
        saveSafeError: "The change could not be saved. You can try again.",
      }),
    );
    expect(html).toContain("The change could not be saved. You can try again.");
    expect(html).toMatch(/role="alert"/);
  });

  it("a load failure renders the safe_message with retry (D23 rule 4)", () => {
    const html = render(
      createElement(EditorTabView, {
        ...baseProps,
        openPath: "workspace://missing.md",
        loadState: "error",
        safeErrorMessage: "The file could not be read.",
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain("The file could not be read.");
    expect(html).toContain("Retry");
  });

  it("wires the save path through writeWorkspaceFile and a Mod-s keymap (source)", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/editor-tab.tsx"), "utf8");
    // The user's own save is the PUT client call with the editor's content.
    expect(source).toMatch(/writeWorkspaceFile\(/);
    // Cmd/Ctrl+S saves from inside the editor (preventDefault — no browser dialog).
    expect(source).toMatch(/Mod-s/);
    expect(source).toMatch(/preventDefault:\s*true/);
    // The conflict handler enters the lock WITHOUT dropping the loaded file —
    // the read keeps rendering while the Agent holds the lease.
    expect(source).toMatch(/WorkspaceLeaseConflictError/);
    expect(source).not.toMatch(/setContent\(null\)|setCurrentDoc\(null\)\s*;?\s*\/\/.*conflict/);
  });

  it("mounts CodeMirror 6 client-only and disposes the view (source)", () => {
    const cm = readFileSync(
      join(APP_DIR, "components/workspace/codemirror-editor.tsx"),
      "utf8",
    );
    expect(cm).toMatch(/from "@codemirror\/state"/);
    expect(cm).toMatch(/from "@codemirror\/view"/);
    expect(cm).toMatch(/EditorView\.editable\.of\(/);
    expect(cm).toMatch(/view\.destroy\(\)/);
    // The lock is real in the editor itself: the facet AND the state facet.
    expect(cm).toMatch(/EditorState\.readOnly\.of\(/);
    // Doc changes stream out for the dirty tracking.
    expect(cm).toMatch(/docChanged/);
  });
});

// ---------------------------------------------------------------------------
// 6. Private files tab — the D39 private scope viewer
// ---------------------------------------------------------------------------

describe("Private files tab view", () => {
  const AGENTS = [
    { agent_id: "agent_researcher", display_name: "Researcher" },
    { agent_id: "agent_developer", display_name: "Developer" },
  ];
  const baseProps = {
    workspaceId: WORKSPACE,
    agents: AGENTS,
    selectedAgentId: "agent_researcher" as string | null,
    onSelectAgent: () => undefined,
    state: "ready" as const,
    nodes: [makeNode({ name: "draft.md", scope: "agent" as const, agent_id: "agent_researcher" })],
    safeErrorMessage: undefined,
    onRetry: undefined,
    onNavigate: () => undefined,
    onDownload: () => undefined,
  };

  it("labels the tab private and names the owning Agent (D39 copy)", () => {
    const html = render(createElement(PrivateFilesTabView, baseProps));
    expect(html).toContain('data-testid="private-badge"');
    expect(html).toContain("Private");
    expect(html).toContain("Private to Researcher");
    expect(html).toContain("never appears in the shared workspace");
  });

  it("renders the Agent selector with the roster's agents", () => {
    const html = render(createElement(PrivateFilesTabView, baseProps));
    expect(html).toMatch(/aria-label="Choose an Agent"/);
    expect(html).toContain("Researcher");
    expect(html).toContain("Developer");
    expect(html).toMatch(/value="agent_researcher"/);
  });

  it("lists agent-scoped nodes read-only: download only, no upload/delete/mkdir", () => {
    const html = render(createElement(PrivateFilesTabView, baseProps));
    expect(html).toContain("draft.md");
    expect(html).toMatch(/aria-label="Download draft\.md"/);
    expect(html).not.toContain("Upload a file");
    expect(html).not.toMatch(/aria-label="Delete /);
    expect(html).not.toContain("New folder");
  });

  it("navigates agent:// subfolders with the agent:// scheme visible", () => {
    const html = render(
      createElement(PrivateFilesTabView, {
        ...baseProps,
        nodes: [
          makeNode({ name: "notes", is_directory: true, size: 0, mime_type: null, scope: "agent" }),
        ],
      }),
    );
    expect(html).toContain("agent://agent_researcher/");
    expect(html).toMatch(/aria-label="Open folder notes"/);
  });

  it("without agents selected the view says so instead of faking a listing", () => {
    const html = render(
      createElement(PrivateFilesTabView, { ...baseProps, agents: [], selectedAgentId: null }),
    );
    expect(html).toContain("No Agent");
  });

  it("an empty private folder explains itself (§2.4)", () => {
    const html = render(createElement(PrivateFilesTabView, { ...baseProps, nodes: [] }));
    expect(html).toContain("No private files yet");
  });

  it("loads through the actor-parameterized client + roster (source)", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/private-files-tab.tsx"), "utf8");
    expect(source).toMatch(/fetchWorkspaceNodesAs\(/);
    expect(source).toMatch(/agent:\/\/\$\{/);
    expect(source).toMatch(/type: "agent"/);
    expect(source).toMatch(/useAgentRoster\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. Artifacts tab view — the §5 artifact card
// ---------------------------------------------------------------------------

describe("Artifacts tab view", () => {
  const baseProps = {
    workspaceId: WORKSPACE,
    artifacts: [
      makeArtifact({ name: "sources-digest.md" }),
      makeArtifact({ name: "bibliography.tex", producer_agent_id: null }),
      makeArtifact({ name: "screenshot.png", artifact_type: "image", mime_type: "image/png" }),
    ],
    state: "ready" as const,
    safeErrorMessage: undefined,
    onRetry: undefined,
    agentNames: { agent_developer: "Developer" } as Record<string, string>,
    preview: null,
    onOpen: () => undefined,
    onDownload: () => undefined,
  };

  it("renders one card per artifact and the count matches the API list (E12)", () => {
    const html = render(createElement(ArtifactsTabView, baseProps));
    expect(html).toContain("sources-digest.md");
    expect(html).toContain("bibliography.tex");
    expect(html).toContain("screenshot.png");
    expect(html).toMatch(/data-testid="artifact-count">3 artifacts</);
    expect(html.match(/data-testid="artifact-card"/g)?.length).toBe(3);
  });

  it("each card carries type icon, size, producer Agent, and run provenance", () => {
    const html = render(createElement(ArtifactsTabView, baseProps));
    // Producer resolved through the roster; provenance is the API's run id.
    expect(html).toContain("Developer");
    expect(html).toContain("from run task_4");
    expect(html).toContain("2.0 KB");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("an artifact produced without an Agent says so instead of inventing one", () => {
    const html = render(createElement(ArtifactsTabView, baseProps));
    expect(html).toContain("No producing Agent");
  });

  it("open previews small text artifacts inline; binary artifacts answer honestly", () => {
    const textPreview = render(
      createElement(ArtifactsTabView, {
        ...baseProps,
        preview: {
          artifactId: "artifact_sources-digest.md",
          kind: "text" as const,
          text: "# digest",
          mimeType: "text/markdown",
          size: 8,
        },
      }),
    );
    expect(textPreview).toMatch(/data-testid="artifact-preview"/);
    expect(textPreview).toContain("# digest");

    const binaryPreview = render(
      createElement(ArtifactsTabView, {
        ...baseProps,
        preview: {
          artifactId: "artifact_screenshot.png",
          kind: "binary" as const,
          mimeType: "image/png",
          size: 20480,
        },
      }),
    );
    expect(binaryPreview).toMatch(/data-testid="artifact-preview"/);
    expect(binaryPreview).toContain("binary file");
    expect(binaryPreview).toContain("image/png");
  });

  it("open and download are named controls on every card", () => {
    const html = render(createElement(ArtifactsTabView, baseProps));
    expect(html).toMatch(/aria-label="Open sources-digest\.md"/);
    expect(html).toMatch(/aria-label="Download sources-digest\.md"/);
  });

  it("the empty state explains provenance instead of a blank box (§2.4)", () => {
    const html = render(createElement(ArtifactsTabView, { ...baseProps, artifacts: [] }));
    expect(html).toContain("No artifacts yet");
  });

  it("downloads the real bytes through the artifact read (source)", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/artifacts-tab.tsx"), "utf8");
    expect(source).toMatch(/readWorkspaceArtifact\(/);
    expect(source).toMatch(/anchor\.download/);
    expect(source).toMatch(/URL\.createObjectURL/);
  });
});

// ---------------------------------------------------------------------------
// 8. Tab strip — every S7 tab shipped; the coming-soon state is gone
// ---------------------------------------------------------------------------

describe("tab strip (all four tabs real)", () => {
  it("the panel body routes Editor, Private files, and Artifacts to real tabs", () => {
    const host = readFileSync(join(APP_DIR, "components/workspace/workspace-panel.tsx"), "utf8");
    expect(host).toMatch(/<EditorTab /);
    expect(host).toMatch(/<PrivateFilesTab /);
    expect(host).toMatch(/<ArtifactsTab /);
    expect(host).not.toContain("TabComingSoon");
  });

  it("the designed coming-soon states retired with the last shipped tab", () => {
    const tabs = readFileSync(join(APP_DIR, "components/workspace/panel-tabs.tsx"), "utf8");
    expect(tabs).not.toContain("TabComingSoon");
    expect(tabs).not.toContain("COMING_SOON_ICONS");
  });
});

// ---------------------------------------------------------------------------
// 9. Craft-floor pins — chunk-4 findings + the state-aware Back affordance
// ---------------------------------------------------------------------------

describe("craft-floor pins (chunk-5 fixes)", () => {
  it("the Files toolbar sits on the 4px grid (no pb-2.5)", () => {
    const source = readFileSync(join(APP_DIR, "components/workspace/files-tab.tsx"), "utf8");
    expect(source).not.toMatch(/pb-2\.5/);
  });

  it("the mobile bottom sheet enters on the bottom axis (its own token)", () => {
    const css = readFileSync(join(APP_DIR, "app/globals.css"), "utf8");
    expect(css).toMatch(/--animate-sheet-up: sheet-up/);
    expect(css).toMatch(/@keyframes sheet-up \{\s*from \{\s*transform: translateY\(100%\);/);
    const host = readFileSync(join(APP_DIR, "components/workspace/workspace-panel.tsx"), "utf8");
    expect(host).toMatch(/animate-sheet-up/);
  });

  it("the full-page Back affordance is state-aware: in-app back, honest deep-link copy", () => {
    expect(workspaceFullBackMarkerKey("conversation_agent_researcher")).toBe(
      "shera.workspace-full.conversation_agent_researcher",
    );
    const routes = readFileSync(join(APP_DIR, "components/workspace/workspace-routes.tsx"), "utf8");
    // The marker set by the in-app toggle decides back vs the dashboard push.
    expect(routes).toMatch(/workspaceFullBackMarkerKey/);
    expect(routes).toMatch(/sessionStorage\.getItem/);
    expect(routes).toMatch(/router\.back\(\)/);
    expect(routes).toContain("Go to dashboard");
  });
});
