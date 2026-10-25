import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { OperationRecord, OperationRenameCommand } from "@shera-bot/contracts";

import { NewOperationForm } from "../components/operations/new-operation-form";
import { OperationChatHeader } from "../components/operations/operation-chat-header";
import { OperationPackSummary } from "../components/operations/operation-pack-summary";
import { LiveOperationChatsSection } from "../components/shell/operation-chats-section";
import {
  CREATE_REFUSAL_COPY,
  createOperation,
  createOperationOutcomeMessage,
  fetchOperationDetail,
  fetchOperations,
  renameOperation,
  renameOperationMutationOptions,
  type OperationDetail,
  type PackSummary,
} from "../lib/operation-api";
import { RuntimeApiError } from "../lib/runtime-client";
import type { AgentRosterSummary } from "../lib/agent-api";

/**
 * S14 chunk 2 — the ad-hoc Operation creation web surfaces (UI_DESIGN §S6 +
 * the F6 conformance finding): the optional-name creation form with the
 * auto-label hint and the zero-Agent inline refusal, the peer-to-peer
 * coordinator option (D42), the ad-hoc identity in the chat header and the
 * sidebar (D41), the rename affordance over the S14 rename route (D23 rule 6),
 * and the collapsible pack summary (roster + the pinned pack's skills and
 * connectors, connectors HONESTLY "Not configured" — D38, no connector
 * runtime in the prototype). Components render to static markup (node
 * environment, no DOM) like the S13 suites; the client is exercised through
 * the same-origin runtime proxy with fetch stubbed at that boundary.
 */

const WORKSPACE = "ws_account-1";
const OPERATION_ID = "op_adhoc_01";
const CHAT_ID = "conversation_operation_chat_01";
const PACK_ID = "student";
const PACK_VERSION = "1.0.0";

const APP_DIR = join(import.meta.dirname, "..");

// The same source of truth as operation-surfaces.test.ts: the six seeded Agents.
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(join(APP_DIR, "..", "..", "agent-packs", "student", "v1", "manifest.json"), "utf8"),
) as {
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    ui_identity: { avatar_hue: number; initial_glyph: string };
  }>;
};

const IDENTITIES: AgentRosterSummary[] = STUDENT_MANIFEST.agents.map((agent) => ({
  agent_id: agent.agent_id,
  display_name: agent.display_name,
  role_description: agent.role_description,
  avatar_hue: agent.ui_identity.avatar_hue,
  initial_glyph: agent.ui_identity.initial_glyph,
  has_user_instructions: false,
  session: { presence: "none" },
}));

const GA = IDENTITIES[0]!;
const RESEARCHER = IDENTITIES[1]!;

/** A contracts-valid named record (the creation POST's 201 payload). */
const OPERATION = OperationRecord.parse({
  operation_id: OPERATION_ID,
  workspace_id: WORKSPACE,
  definition_ref: null,
  name: "Weekly Review",
  status: "active",
  coordinator_agent_id: GA.agent_id,
  pinning: {
    pack_id: PACK_ID,
    pack_version: PACK_VERSION,
    roster_agent_ids: [GA.agent_id, RESEARCHER.agent_id],
    capabilities: [],
    provider_snapshot: {},
  },
  created_at: "2026-10-24T10:00:00.000Z",
  updated_at: "2026-10-24T10:00:00.000Z",
});

/** The auto-labeled ad-hoc record shape the server derives (D41). */
const AUTO_LABEL = "Ad-hoc · 2 Agents";

/** The S14 detail read model adds the derived fields + the F6 pack summary. */
const PACK_SUMMARY: PackSummary = {
  skills: [
    { skill_id: "skill_research_core", title: "Research core" },
    { skill_id: "skill_mystery_core", title: null },
  ],
  connectors: [{ connector_id: "connector_scholar_library", connected: false }],
};

const DETAIL: OperationDetail = {
  operation: OPERATION,
  is_adhoc: true,
  auto_label: false,
  roster: [],
  runs: [],
  recent_refusals: [],
  chat_conversation_id: CHAT_ID,
  pack_summary: PACK_SUMMARY,
};

const render = (element: ReactElement): string => renderToStaticMarkup(element);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The S6 creation form — optional name (auto-label), multi-select roster
//    with the zero-Agent inline refusal, D42 peer-to-peer coordinator option
// ---------------------------------------------------------------------------

describe("New Operation form (§S6, D41/D42)", () => {
  const renderForm = (props: Record<string, unknown> = {}) =>
    render(
      createElement(NewOperationForm, {
        identities: IDENTITIES,
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        pending: false,
        errorMessage: null,
        defaultCoordinatorId: GA.agent_id,
        initialSelectedAgentIds: [],
        onSubmit: () => undefined,
        ...props,
      }),
    );

  it("the name is OPTIONAL with the auto-label hint — an unnamed create labels itself (D41)", () => {
    const html = renderForm({
      // One pre-selected Agent (deep-link/seed hook) proves the empty NAME
      // alone never blocks Create — only the empty roster does.
      initialSelectedAgentIds: [GA.agent_id],
    });
    expect(html).toContain("Leave unnamed to label it automatically");
    const createButton = html.split("<button").find((segment) => segment.includes("Create Operation"));
    expect(createButton).toBeDefined();
    expect(createButton).not.toMatch(/\bdisabled=""/);
  });

  it("zero Agents selected disables Create with the inline refusal copy mirroring the server (D41)", () => {
    const html = renderForm();
    expect(html).toMatch(/<button[^>]*?\bdisabled=""[^>]*>\s*Create Operation/);
    expect(html).toContain('role="status"');
    expect(html).toContain("An Operation needs at least one Agent.");
  });

  it("the roster picker is a multi-select of checkbox chips with the pack-authored identity", () => {
    const html = renderForm();
    // Checkbox affordance per Agent, with avatar hue + role riding along (D39).
    expect(html).toContain(`aria-label="Include ${GA.display_name}"`);
    expect(html).toContain(`aria-label="Include ${RESEARCHER.display_name}"`);
    expect(html).toContain(`--agent-hue:${RESEARCHER.avatar_hue}`);
    expect(html).toContain(RESEARCHER.role_description);
  });

  it("the coordinator defaults to the General Assistant, named in the copy, with a peer-to-peer option (D42)", () => {
    const html = renderForm();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain(`${GA.display_name} coordinates by default`);
    // The explicit "none" option — peer-to-peer coordination (D42/D49) — is
    // selectable at creation, and the runtime stays authoritative either way.
    expect(html).toContain('aria-label="No coordinator (peer-to-peer)"');
    // The default is marked checked in the initial markup (never silently chosen).
    const gaOption = html
      .split("<input")
      .find((segment) => segment.includes(`aria-label="Coordinator: ${GA.display_name}"`));
    expect(gaOption).toContain("checked");
  });

  it("pending disables Create; the typed failure renders as an alert; loading is a skeleton", () => {
    const pending = renderForm({ pending: true });
    expect(pending).toMatch(/<button[^>]*?\bdisabled=""[^>]*>\s*Create Operation/);

    const error = renderForm({ errorMessage: "An Operation needs at least one Agent." });
    expect(error).toContain('role="alert"');

    const loading = renderForm({ state: "loading", identities: [] });
    expect(loading).toContain("animate-pulse");
  });

  it("the roster error state carries the safe message + retry", () => {
    const html = renderForm({
      state: "error",
      identities: [],
      safeErrorMessage: "The Agent roster could not be loaded.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The Agent roster could not be loaded.");
    expect(html).toContain("Retry");
  });
});

// ---------------------------------------------------------------------------
// 2. The chat header — ad-hoc identity (D41) + the rename affordance (D23 r6)
// ---------------------------------------------------------------------------

describe("Operation chat header (§S4 + S14)", () => {
  const renderHeader = (props: Record<string, unknown> = {}) =>
    render(
      createElement(OperationChatHeader, {
        name: AUTO_LABEL,
        isAdhoc: true,
        autoLabel: true,
        packLabel: `${PACK_ID} v${PACK_VERSION}`,
        runCount: 0,
        renameEditing: false,
        renameDraft: "",
        renamePending: false,
        renameErrorMessage: null,
        onRenameStart: () => undefined,
        onRenameCancel: () => undefined,
        onRenameDraftChange: () => undefined,
        onRenameSubmit: () => undefined,
        ...props,
      }),
    );

  it("marks an ad-hoc Operation with an Ad-hoc tag next to the title (D41)", () => {
    // A NAMED ad-hoc Operation: the "Ad-hoc" string can only come from the tag.
    const html = renderHeader({ name: "Weekly Review", autoLabel: false });
    expect(html).toContain("Ad-hoc");
    expect(html).not.toContain(AUTO_LABEL);
  });

  it("a pack-defined Operation carries no Ad-hoc tag", () => {
    const html = renderHeader({ name: "Research Paper", isAdhoc: false, autoLabel: false });
    expect(html).not.toContain("Ad-hoc");
  });

  it("the auto-label name renders muted/italic — a derived label, never user-authored", () => {
    const html = renderHeader();
    expect(html).toContain('data-testid="operation-auto-label"');
    expect(html).toMatch(/italic/);
    expect(html).toContain(AUTO_LABEL);

    const named = renderHeader({ name: "Weekly Review", autoLabel: false });
    expect(named).not.toContain('data-testid="operation-auto-label"');
  });

  it("offers a rename affordance on the title while idle", () => {
    const html = renderHeader();
    expect(html).toContain('aria-label="Rename Operation"');
  });

  it("the editing state renders the name editor with Save/Cancel and the current draft", () => {
    const html = renderHeader({
      renameEditing: true,
      renameDraft: "Weekly Review",
    });
    expect(html).toContain('aria-label="Operation name"');
    expect(html).toContain('aria-label="Save name"');
    expect(html).toContain('aria-label="Cancel rename"');
    expect(html).toMatch(/value="Weekly Review"/);
  });

  it("an empty or whitespace-only draft keeps Save disabled; a valid draft enables it", () => {
    const saveState = (draft: string): string =>
      renderHeader({ renameEditing: true, renameDraft: draft })
        .split("<button")
        .find((segment) => segment.includes('aria-label="Save name"'))!;

    expect(saveState("")).toMatch(/\bdisabled=""/);
    expect(saveState("   ")).toMatch(/\bdisabled=""/);
    expect(saveState("Weekly Review")).not.toMatch(/\bdisabled=""/);
  });

  it("Save stays honestly disabled while the rename is pending", () => {
    const saveButton = renderHeader({
      renameEditing: true,
      renameDraft: "Weekly Review",
      renamePending: true,
    })
      .split("<button")
      .find((segment) => segment.includes('aria-label="Save name"'))!;
    expect(saveButton).toMatch(/\bdisabled=""/);
  });

  it("a rename validation failure renders verbatim as an alert — never raw internals", () => {
    const html = renderHeader({
      renameEditing: true,
      renameDraft: "x".repeat(121),
      renameErrorMessage: "The Operation name must be between 1 and 120 characters.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The Operation name must be between 1 and 120 characters.");
  });
});

// ---------------------------------------------------------------------------
// 3. The F6 pack summary — roster line + skills/connectors, truthfully
//    "Not configured" (D38: no connector runtime in the prototype)
// ---------------------------------------------------------------------------

describe("Operation pack summary (§S6/F6, D38)", () => {
  const renderSummary = (props: Record<string, unknown> = {}) =>
    render(
      createElement(OperationPackSummary, {
        packSummary: PACK_SUMMARY,
        rosterCount: 2,
        open: false,
        onOpenChange: () => undefined,
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        ...props,
      }),
    );

  it("collapses by default behind an explicit toggle; opening reveals the lists", () => {
    const closed = renderSummary();
    expect(closed).toMatch(/aria-expanded="false"/);
    expect(closed).not.toContain("Research core");

    const open = renderSummary({ open: true });
    expect(open).toMatch(/aria-expanded="true"/);
    expect(open).toContain("Research core");
    expect(open).toContain("Scholar library");
  });

  it("renders the pinned pack's skills by title, falling back to the id — never a fabricated name", () => {
    const html = renderSummary({ open: true });
    expect(html).toContain("Research core");
    expect(html).toContain("skill_mystery_core");
  });

  it("renders every connector as Not configured — never 'Connected' (D38, G3)", () => {
    const html = renderSummary({ open: true });
    expect(html).toContain("Scholar library");
    expect(html).toContain("Not configured");
    expect(html).not.toMatch(/Connected/);
  });

  it("summarizes the roster it accompanies", () => {
    const html = renderSummary();
    expect(html).toContain("2 Agents");
  });

  it("error carries the safe message + retry; loading is a skeleton", () => {
    const error = renderSummary({
      state: "error",
      packSummary: null,
      safeErrorMessage: "The Operation could not be loaded.",
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The Operation could not be loaded.");
    expect(error).toContain("Retry");

    const loading = renderSummary({ state: "loading", packSummary: null });
    expect(loading).toContain("animate-pulse");
  });
});

// ---------------------------------------------------------------------------
// 4. The sidebar's live Operation chats — the same ad-hoc identity (D41)
// ---------------------------------------------------------------------------

describe("Sidebar live Operation chats (§3.2 + S14)", () => {
  const row = (overrides: Record<string, unknown>) =>
    OperationRecord.parse({
      ...OPERATION,
      operation_id: "op_sidebar_01",
      name: AUTO_LABEL,
      ...overrides,
    });

  const renderSection = (props: Record<string, unknown> = {}) =>
    render(
      createElement(LiveOperationChatsSection, {
        operations: [{ ...row({}), is_adhoc: true, auto_label: true }],
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        ...props,
      }),
    );

  it("links every real Operation into the Active chats group", () => {
    const html = renderSection();
    expect(html).toContain('href="/app/operation/op_sidebar_01"');
    expect(html).toContain(AUTO_LABEL);
  });

  it("marks ad-hoc Operations with the Ad-hoc tag and mutes/italicizes the auto-label", () => {
    const html = renderSection();
    expect(html).toContain("Ad-hoc");
    expect(html).toMatch(/italic/);

    const named = renderSection({
      operations: [
        { ...row({ name: "Weekly Review" }), is_adhoc: true, auto_label: false },
      ],
    });
    expect(named).toContain("Weekly Review");
    expect(named).not.toMatch(/italic/);
  });

  it("a pack-defined Operation carries no Ad-hoc tag", () => {
    const html = renderSection({
      operations: [{ ...row({ name: "Research Paper" }), is_adhoc: false, auto_label: false }],
    });
    expect(html).toContain("Research Paper");
    expect(html).not.toContain("Ad-hoc");
  });

  it("loading is a skeleton; error carries the safe message + retry", () => {
    const loading = renderSection({ state: "loading", operations: [] });
    expect(loading).toContain("animate-pulse");

    const error = renderSection({
      state: "error",
      operations: [],
      safeErrorMessage: "The Operations could not be loaded.",
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The Operations could not be loaded.");
    expect(error).toContain("Retry");
  });
});

// ---------------------------------------------------------------------------
// 5. The typed client — S14 derived read models, the rename route, and the
//    create refusals, through the same-origin proxy
// ---------------------------------------------------------------------------

describe("Operation client (S14 surfaces, proxy paths)", () => {
  it("fetchOperations parses the S14 derived is_adhoc/auto_label on list rows", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { operations: [{ ...OPERATION, is_adhoc: true, auto_label: false }] }));
    vi.stubGlobal("fetch", fetchMock);

    const operations = await fetchOperations(WORKSPACE);
    expect(operations[0]).toMatchObject({
      operation_id: OPERATION_ID,
      name: "Weekly Review",
      is_adhoc: true,
      auto_label: false,
    });
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/operations?workspace_id=${WORKSPACE}`);
  });

  it("fetchOperationDetail parses is_adhoc/auto_label and the F6 pack_summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ...DETAIL, auto_label: true, operation: { ...OPERATION, name: AUTO_LABEL } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchOperationDetail(WORKSPACE, OPERATION_ID);
    expect(detail.is_adhoc).toBe(true);
    expect(detail.auto_label).toBe(true);
    expect(detail.pack_summary).toEqual(PACK_SUMMARY);
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}?workspace_id=${WORKSPACE}`);
  });

  it("createOperation sends the OPTIONAL name as null (auto-label) and accepts the none coordinator (D42)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, { ...OPERATION, name: AUTO_LABEL, coordinator_agent_id: "none" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const record = await createOperation(WORKSPACE, {
      name: null,
      roster_agent_ids: [GA.agent_id, RESEARCHER.agent_id],
      coordinator_agent_id: "none",
    });
    expect(record.name).toBe(AUTO_LABEL);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: null,
      coordinator_agent_id: "none",
    });
  });

  it("renameOperation POSTs a contracts-valid envelope to the S14 rename route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, OPERATION));
    vi.stubGlobal("fetch", fetchMock);

    const record = await renameOperation(WORKSPACE, OPERATION_ID, "Weekly Review");
    expect(record.name).toBe("Weekly Review");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}/rename`);
    expect(init.method).toBe("POST");
    // The envelope parses through the SAME contracts schema the runtime
    // enforces — a malformed rename fails at build time, never on the wire.
    const envelope = OperationRenameCommand.parse(JSON.parse(String(init.body)));
    expect(envelope).toMatchObject({
      type: "operation.rename_operation",
      workspace_id: WORKSPACE,
      operation_id: OPERATION_ID,
      name: "Weekly Review",
      actor: { type: "user" },
    });
  });

  it("renameOperation surfaces the typed validation failure (safe copy, D23 rule 4)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          code: "OPERATION_COMMAND_INVALID",
          category: "validation",
          safe_message: "The rename command is not valid.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );
    await expect(renameOperation(WORKSPACE, OPERATION_ID, "")).rejects.toMatchObject({
      sheraError: { code: "OPERATION_COMMAND_INVALID", safe_message: "The rename command is not valid." },
    });
  });

  it("the rename hook invalidates the detail AND list reads after a successful rename", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["operation-detail", WORKSPACE, OPERATION_ID], { seeded: true });
    queryClient.setQueryData(["operations", WORKSPACE], { seeded: true });

    const renamed = { ...OPERATION, name: "Weekly Review" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, renamed)));

    const options = renameOperationMutationOptions(queryClient, WORKSPACE, OPERATION_ID);
    const record = await options.mutationFn("Weekly Review");
    expect(record.name).toBe("Weekly Review");
    await options.onSuccess(record);
    await Promise.resolve();

    expect(
      queryClient.getQueryState(["operation-detail", WORKSPACE, OPERATION_ID])?.isInvalidated,
    ).toBe(true);
    expect(queryClient.getQueryState(["operations", WORKSPACE])?.isInvalidated).toBe(true);
  });

  it("maps the typed create refusals: the server safe_message first, known codes to friendly copy", () => {
    const rosterEmpty = new RuntimeApiError({
      code: "OPERATION_ROSTER_EMPTY",
      category: "validation",
      safe_message: "An Operation needs at least one Agent.",
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(createOperationOutcomeMessage(rosterEmpty)).toBe("An Operation needs at least one Agent.");

    // The local friendly copy for the two S14 refusal codes (used when the
    // server answer carries no usable safe_message), keyed by the typed code.
    expect(CREATE_REFUSAL_COPY["OPERATION_ROSTER_EMPTY"]).toMatch(/at least one Agent/);
    expect(CREATE_REFUSAL_COPY["OPERATION_NAME_REQUIRED"]).toMatch(/name/i);

    // Anything else falls back to honest generic copy — never internals (G3).
    expect(createOperationOutcomeMessage(new Error("postgres exploded"))).toBe(
      "The Operation could not be created.",
    );
  });
});
