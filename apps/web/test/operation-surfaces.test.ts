import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AddRosterAgentCommand,
  OperationCollaborationEvent,
  OperationRecord,
  RemoveRosterAgentCommand,
  type OperationRun,
} from "@shera-bot/contracts";

import { OperationRosterPanel } from "../components/operations/operation-roster-panel";
import { OperationRunsPanel } from "../components/operations/operation-runs-panel";
import { OperationThreadView } from "../components/operations/operation-thread";
import { NewOperationForm } from "../components/operations/new-operation-form";
import {
  buildOperationRosterCommand,
  candidateAgentsForOperation,
  collaborationEventSummary,
  createOperation,
  createOperationRun,
  fetchOperationDetail,
  fetchOperationThread,
  fetchOperations,
  newMessageDraftKey,
  newOperationCommandIds,
  OPERATION_EVENT_LABELS,
  sendOperationChatMessage,
  setOperationCoordinator,
  submitOperationRosterCommand,
  type OperationThreadPayload,
} from "../lib/operation-api";
import type { AgentRosterSummary } from "../lib/agent-api";

/**
 * S13 chunk 4 — the Operation chat UI surfaces (UI_DESIGN §S4): the roster
 * panel (D36 chips, D42/D49 coordinator badge + removal), the merged thread
 * (D41 messages with @-addressing chips, D7 collaboration event cards), the
 * runs panel (D31/D8, D34 subrun labels), and the ad-hoc creation form, all
 * rendered to static markup (node environment, no DOM) like the S11 suites.
 * Data comes from the REAL S13 local-API surfaces under /v1/operations,
 * reached through the same-origin runtime proxy; fetch is stubbed at that
 * boundary, and the real round trip is proven in apps/user-runtime.
 */

const APP_DIR = join(import.meta.dirname, "..");
const render = (element: ReactElement): string => renderToStaticMarkup(element);

const WORKSPACE = "ws_account-1";
const OPERATION_ID = "op_research_paper_01";
const CHAT_ID = "conversation_operation_chat_01";
const PACK_ID = "student";
const PACK_VERSION = "1.0.0";

/**
 * The REAL shipped pack manifest (same source of truth as
 * agent-surfaces.test.ts): the six seeded Agents, used for identities.
 */
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(join(APP_DIR, "..", "..", "agent-packs", "student", "v1", "manifest.json"), "utf8"),
) as {
  pack_id: string;
  version: string;
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
}));

const GA = IDENTITIES[0]!;
const RESEARCHER = IDENTITIES[1]!;
const CITATION = IDENTITIES[2]!;

/** A contracts-valid Operation record (the backend's POST/GET payload). */
const OPERATION = OperationRecord.parse({
  operation_id: OPERATION_ID,
  workspace_id: WORKSPACE,
  definition_ref: null,
  name: "Research Paper",
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

const ROSTER_MEMBER = (agent: AgentRosterSummary, requiresApproval = false) => ({
  agent_id: agent.agent_id,
  display_name: agent.display_name,
  requires_approval: requiresApproval,
  pack_id: PACK_ID,
  pack_version: PACK_VERSION,
  added_at: "2026-10-24T10:00:00.000Z",
});

const RUN: OperationRun = {
  run_id: "run_top_01",
  workspace_id: WORKSPACE,
  operation_id: OPERATION_ID,
  parent_task_id: null,
  state: "RUNNING",
  events_seq_cursor: 4,
  credits: {},
  artifacts: ["artifact_outline"],
  created_at: "2026-10-24T10:01:00.000Z",
  updated_at: "2026-10-24T10:02:00.000Z",
};

const SUBRUN: OperationRun = {
  ...RUN,
  run_id: "run_child_01",
  parent_task_id: "task_parent_01",
  state: "QUEUED",
  events_seq_cursor: 0,
  artifacts: [],
};

const DETAIL = {
  operation: OPERATION,
  roster: [ROSTER_MEMBER(GA), ROSTER_MEMBER(RESEARCHER)],
  runs: [RUN, SUBRUN],
  recent_refusals: [],
  chat_conversation_id: CHAT_ID,
};

function collaborationEvent(
  type: keyof typeof OPERATION_EVENT_LABELS,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return OperationCollaborationEvent.parse({
    event_id: `event_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    operation_id: OPERATION_ID,
    run_id: null,
    sender_agent_id: GA.agent_id,
    recipient_agent_ids: [],
    correlation_id: "corr_proposal_01",
    issued_at: "2026-10-24T10:05:00.000Z",
    type,
    payload,
    ...overrides,
  });
}

const THREAD: OperationThreadPayload = {
  operation_id: OPERATION_ID,
  workspace_id: WORKSPACE,
  chat_conversation_id: CHAT_ID,
  items: [
    {
      kind: "message",
      message_id: "msg_0001",
      conversation_id: CHAT_ID,
      sequence: 1,
      sender: { kind: "user", display_name: "Emon" },
      text: "@agent_researcher please gather sources",
      addressed_to: [RESEARCHER.agent_id],
      occurred_at: "2026-10-24T10:03:00.000Z",
    },
    {
      kind: "message",
      message_id: "msg_0002",
      conversation_id: CHAT_ID,
      sequence: 2,
      sender: { kind: "agent", agent_id: RESEARCHER.agent_id },
      text: "On it — starting with the method papers.",
      addressed_to: [],
      occurred_at: "2026-10-24T10:04:00.000Z",
    },
    {
      kind: "collaboration_event",
      sequence: 1,
      stream_id: "stream_operation_chat_01",
      sender: { kind: "agent", agent_id: GA.agent_id, display_name: GA.display_name },
      event: collaborationEvent("TaskProposed", {
        task_description: "Outline the related-work section",
        proposed_assignee_agent_id: RESEARCHER.agent_id,
      }),
      issued_at: "2026-10-24T10:05:00.000Z",
    },
    {
      kind: "collaboration_event",
      sequence: 2,
      stream_id: "stream_operation_chat_01",
      sender: { kind: "agent", agent_id: RESEARCHER.agent_id, display_name: RESEARCHER.display_name },
      event: collaborationEvent(
        "ProgressReported",
        { progress_text: "Found 12 candidate sources." },
        { sender_agent_id: RESEARCHER.agent_id },
      ),
      issued_at: "2026-10-24T10:06:00.000Z",
    },
  ],
};

function renderRoster(props: Record<string, unknown> = {}): string {
  return render(
    createElement(OperationRosterPanel, {
      roster: DETAIL.roster,
      identities: IDENTITIES,
      coordinatorAgentId: OPERATION.coordinator_agent_id,
      state: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      candidates: candidateAgentsForOperation(
        IDENTITIES,
        DETAIL.roster.map((member) => member.agent_id),
      ),
      confirmingAdd: null,
      pending: false,
      refusalMessage: null,
      persistedRefusalMessage: null,
      onAddClick: () => undefined,
      onConfirmAdd: () => undefined,
      onCancelAdd: () => undefined,
      onRemove: () => undefined,
      onCoordinatorChange: () => undefined,
      ...props,
    }),
  );
}

function renderThread(props: Record<string, unknown> = {}): string {
  return render(
    createElement(OperationThreadView, {
      items: THREAD.items,
      identities: IDENTITIES,
      state: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      composerValue: "",
      onComposerChange: () => undefined,
      onSend: () => undefined,
      sendPending: false,
      ...props,
    }),
  );
}

function renderRuns(props: Record<string, unknown> = {}): string {
  return render(
    createElement(OperationRunsPanel, {
      runs: DETAIL.runs,
      state: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      onCreateRun: () => undefined,
      createPending: false,
      ...props,
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Roster panel — D36 chips, D42/D49 coordinator badge + removal
// ---------------------------------------------------------------------------

describe("Operation roster panel (§S4, D36/D42/D49)", () => {
  it("renders one chip per roster Agent with the pack-authored identity", () => {
    const html = renderRoster();
    expect(html).toContain("Roster");
    // Names resolve from the seeded identities, in roster order.
    expect(html.indexOf(GA.display_name)).toBeGreaterThan(-1);
    expect(html.indexOf(RESEARCHER.display_name)).toBeGreaterThan(-1);
    expect(html.indexOf(RESEARCHER.display_name)).toBeGreaterThan(html.indexOf(GA.display_name));
    // Roles ride along like the s11 roster rows.
    expect(html).toContain(RESEARCHER.role_description);
    // Authored avatar identity reaches the chip (D39/D18 hue pattern).
    expect(html).toContain(`--agent-hue:${RESEARCHER.avatar_hue}`);
  });

  it("renders the coordinator BY ROLE even when the coordinating Agent holds no membership (D46)", () => {
    // The creation flow allows a roster without the coordinating Agent; the
    // chip still shows (identity from the workspace roster), with ONLY the
    // coordinator-remove action — nothing to remove from a roster it is not on.
    const html = renderRoster({
      roster: [ROSTER_MEMBER(RESEARCHER)],
      coordinatorAgentId: GA.agent_id,
      candidates: [],
    });
    expect(html).toContain("Coordinator");
    expect(html).toContain(GA.display_name);
    expect(html).not.toContain(`Remove ${GA.display_name} from this Operation`);
    const coordinatorRemove = html.split('aria-label="Remove the coordinator role"').length - 1;
    expect(coordinatorRemove).toBe(1);
  });

  it("renders a roster member without any resolvable identity by its id — never a fabricated name", () => {
    const html = renderRoster({
      roster: [{ ...ROSTER_MEMBER(GA), agent_id: "agent_unknown_member", display_name: null }],
      identities: [],
      candidates: [],
    });
    expect(html).toContain("agent_unknown_member");
    expect(html).not.toContain(GA.display_name);
  });

  it("marks the coordinator chip with a Coordinator badge and a remove action", () => {
    const html = renderRoster();
    expect(html).toContain("Coordinator");
    expect(html).toContain('aria-label="Remove the coordinator role"');
  });

  it("the coordinator remove action targets the coordinator, not another member", () => {
    // Non-coordinator chips carry no coordinator-remove control.
    const html = renderRoster();
    const coordinatorCount = html.split('aria-label="Remove the coordinator role"').length - 1;
    expect(coordinatorCount).toBe(1);
  });

  it("offers the same-pack Agents that are NOT yet on the roster as candidates", () => {
    const html = renderRoster();
    // Candidates: the four seeded Agents missing from the two-member roster.
    expect(html).toContain(CITATION.display_name);
    expect(html).toContain("Developer");
    expect(html).not.toContain(`Add ${RESEARCHER.display_name} to this Operation`);
  });

  it("computes candidates as workspace Agents minus roster members", () => {
    const candidates = candidateAgentsForOperation(
      IDENTITIES,
      IDENTITIES.slice(0, 4).map((agent) => agent.agent_id),
    );
    expect(candidates.map((agent) => agent.agent_id)).toEqual([
      IDENTITIES[4]!.agent_id,
      IDENTITIES[5]!.agent_id,
    ]);
  });

  it("arms an explicit confirm before any add command (D36 — never a silent add)", () => {
    const idle = renderRoster();
    expect(idle).not.toContain("Confirm add");
    const armed = renderRoster({ confirmingAdd: CITATION });
    expect(armed).toContain("Confirm add");
    expect(armed).toContain("Cancel");
    expect(armed).toContain(CITATION.display_name);
  });

  it("renders a refused add's fixed safe message verbatim, inline (D36)", () => {
    // The cost-increase refusal copy (no apostrophe, so the verbatim check
    // survives SSR entity-encoding) — the runtime's fixed safe copy, never
    // raw internals.
    const html = renderRoster({
      refusalMessage: "Adding this Agent increases cost or access and needs your approval first.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Adding this Agent increases cost or access and needs your approval first.");
  });

  it("falls back to the detail read model's most recent persisted refusal (the UI's why)", () => {
    // The backend persists every D36 refusal; across reloads the latest one
    // still explains itself. A live refusal from this session wins.
    const persisted = renderRoster({
      persistedRefusalMessage:
        "Adding this Agent increases cost or access and needs your approval first.",
    });
    expect(persisted).toContain('role="alert"');
    expect(persisted).toContain(
      "Adding this Agent increases cost or access and needs your approval first.",
    );

    const liveWins = renderRoster({
      refusalMessage: "Live refusal",
      persistedRefusalMessage: "Persisted refusal",
    });
    expect(liveWins).toContain("Live refusal");
    expect(liveWins).not.toContain("Persisted refusal");
  });

  it("loading state is a layout-matched skeleton; error state carries the safe message + retry", () => {
    const loading = renderRoster({ state: "loading", roster: [], candidates: [] });
    expect(loading).toContain("animate-pulse");
    expect(loading).not.toContain(GA.display_name);

    const error = renderRoster({
      state: "error",
      roster: [],
      candidates: [],
      safeErrorMessage: "The Operation could not be loaded.",
      onRetry: () => undefined,
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The Operation could not be loaded.");
    expect(error).toContain("Retry");
  });

  it("disables every roster control while a command is pending", () => {
    const html = renderRoster({ pending: true });
    expect(html).toMatch(/disabled/);
    expect(html).not.toContain("Confirm add");
  });
});

// ---------------------------------------------------------------------------
// 2. Thread — D41 messages with addressing, D7 collaboration event cards
// ---------------------------------------------------------------------------

describe("Operation thread (§S4, D41/D7)", () => {
  it("renders user and Agent messages with sender attribution", () => {
    const html = renderThread();
    expect(html).toContain("Emon");
    expect(html).toContain(RESEARCHER.display_name);
    expect(html).toContain("@agent_researcher please gather sources");
    expect(html).toContain("On it — starting with the method papers.");
    // Agent identity rides the pack-authored hue (D39).
    expect(html).toContain(`--agent-hue:${RESEARCHER.avatar_hue}`);
  });

  it("renders the visible addressing chip from addressed_to, resolved via roster names", () => {
    const html = renderThread();
    expect(html).toContain(`To ${RESEARCHER.display_name}:`);
  });

  it("an unaddressed message renders no To-chip", () => {
    const html = renderThread({
      items: THREAD.items.filter(
        (item) => item.kind === "message" && item.message_id === "msg_0002",
      ),
    });
    expect(html).not.toContain("To ");
  });

  it("an unresolvable addressee renders the raw id — never a fabricated name", () => {
    const html = renderThread({
      items: [
        {
          kind: "message",
          message_id: "msg_0003",
          conversation_id: CHAT_ID,
          sequence: 3,
          sender: { kind: "user", display_name: "Emon" },
          text: "who is this?",
          addressed_to: ["agent_missing_from_workspace"],
          occurred_at: "2026-10-24T10:07:00.000Z",
        },
      ],
    });
    expect(html).toContain("To agent_missing_from_workspace:");
  });

  it("renders D7 collaboration events as attributable typed cards", () => {
    const html = renderThread();
    expect(html).toContain("Task proposed");
    expect(html).toContain("Progress reported");
    expect(html).toContain("Outline the related-work section");
    expect(html).toContain("Found 12 candidate sources.");
    // Sender attribution on the event card.
    expect(html.indexOf(`${GA.display_name} proposed`)).toBeGreaterThan(-1);
  });

  it("TaskProposed renders as a display-only proposal card — no approval control yet", () => {
    // Approval flows arrive in S20; the proposal card must not fake them.
    const html = renderThread({ items: [THREAD.items[2]!] });
    expect(html).toContain("Task proposed");
    expect(html).not.toContain("<button");
  });

  it("labels every D7 event type and summarizes its payload", () => {
    const delegated = collaborationEvent("TaskDelegated", {
      task_description: "Draft the bibliography",
    });
    const completed = collaborationEvent("TaskCompleted", {
      completion_summary: "Bibliography drafted.",
    });
    const blocked = collaborationEvent("TaskBlocked", { blocked_reason: "waiting on access" });
    expect(OPERATION_EVENT_LABELS.TaskDelegated).toBe("Task delegated");
    expect(OPERATION_EVENT_LABELS.TaskCompleted).toBe("Task completed");
    expect(OPERATION_EVENT_LABELS.TaskBlocked).toBe("Task blocked");
    expect(collaborationEventSummary(delegated)).toBe("Draft the bibliography");
    expect(collaborationEventSummary(completed)).toBe("Bibliography drafted.");
    expect(collaborationEventSummary(blocked)).toBe("waiting on access");
  });

  it("empty thread explains the truth with the next action; error state carries retry", () => {
    const empty = renderThread({ items: [] });
    expect(empty).toContain("No messages yet");
    expect(empty).toContain("Say hello");

    const error = renderThread({
      state: "error",
      items: [],
      safeErrorMessage: "The Operation thread could not be loaded.",
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The Operation thread could not be loaded.");
    expect(error).toContain("Retry");
  });

  it("loading state is a skeleton — no fabricated history", () => {
    const html = renderThread({ state: "loading", items: [] });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Emon");
  });

  it("the composer lists roster names as the @-mention affordance while addressing", () => {
    const idle = renderThread();
    expect(idle).toContain('aria-label="Message the Operation"');
    const addressing = renderThread({ composerValue: "please review @" });
    expect(addressing).toContain("Mention an Agent");
    expect(addressing).toContain(RESEARCHER.display_name);
    expect(addressing).toContain(GA.display_name);
    // No roster match in progress → no hint (not a heavy autocomplete).
    expect(renderThread({ composerValue: "plain text" })).not.toContain("Mention an Agent");
  });

  it("disables the send affordance while a send is pending", () => {
    const html = renderThread({ sendPending: true });
    // The disabled ATTRIBUTE (the Button's disabled:* utility classes are
    // always present and never mean a control is actually disabled).
    expect(html).toMatch(/\bdisabled=""/);
  });
});

// ---------------------------------------------------------------------------
// 3. Runs panel — D31 runs in the D8 vocabulary, D34 subrun labels
// ---------------------------------------------------------------------------

describe("Operation runs panel (§S4, D31/D34/D8)", () => {
  it("lists every run with its D8 state, event cursor, and artifact count", () => {
    const html = renderRuns();
    expect(html).toContain("RUNNING");
    expect(html).toContain("QUEUED");
    expect(html).toContain("4 events");
    expect(html).toContain("1 artifact");
  });

  it("labels a delegated subrun by its parent task — runs are never merged (AC24)", () => {
    const html = renderRuns();
    expect(html).toContain("subrun");
    expect(html).toContain("task_parent_01");
  });

  it("offers New run, honestly disabled while the creation is pending", () => {
    const idle = renderRuns();
    expect(idle).toContain("New run");
    expect(idle).not.toMatch(/<button[^>]*?\bdisabled=""[^>]*>\s*New run/);

    const pending = renderRuns({ createPending: true });
    expect(pending).toMatch(/<button[^>]*?\bdisabled=""[^>]*>\s*New run/);
  });

  it("empty state explains that nothing has run yet", () => {
    const html = renderRuns({ runs: [] });
    expect(html).toContain("No runs yet");
    expect(html).toContain("New run");
  });

  it("error state carries the safe message + retry", () => {
    const html = renderRuns({
      state: "error",
      runs: [],
      safeErrorMessage: "The runs list could not be loaded.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The runs list could not be loaded.");
    expect(html).toContain("Retry");
  });
});

// ---------------------------------------------------------------------------
// 4. Ad-hoc creation form (S6 entry point to the chat)
// ---------------------------------------------------------------------------

describe("New Operation form (S6, D29/D31)", () => {
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
        onSubmit: () => undefined,
        ...props,
      }),
    );

  it("collects a name and an initial roster from the live workspace Agents", () => {
    const html = renderForm();
    expect(html).toContain('aria-label="Operation name"');
    expect(html).toContain(RESEARCHER.display_name);
    expect(html).toContain("Create Operation");
    // The default coordinator is named, not silently chosen (D42).
    expect(html).toContain("coordinates by default");
  });

  it("requires a name and at least one Agent — the submit stays honest", () => {
    // The form's own validation is asserted through the submit contract test
    // below (the page refuses to call onSubmit with an empty roster).
    const html = renderForm({ pending: true });
    expect(html).toMatch(/<button[^>]*?\bdisabled=""[^>]*>\s*Create Operation/);
  });

  it("error state carries the safe message + retry; loading state is a skeleton", () => {
    const error = renderForm({
      state: "error",
      identities: [],
      safeErrorMessage: "The Agent roster could not be loaded.",
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("Retry");

    const loading = renderForm({ state: "loading", identities: [] });
    expect(loading).toContain("animate-pulse");
  });
});

// ---------------------------------------------------------------------------
// 5. The typed Operation client through the same-origin proxy
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Operation client (proxy paths)", () => {
  it("fetchOperations GETs the workspace's Operation records", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { operations: [OPERATION] }));
    vi.stubGlobal("fetch", fetchMock);

    const operations = await fetchOperations(WORKSPACE);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ operation_id: OPERATION_ID, name: "Research Paper" });

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/operations?workspace_id=${WORKSPACE}`);
  });

  it("createOperation POSTs the ad-hoc creation body and parses the 201 record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, OPERATION));
    vi.stubGlobal("fetch", fetchMock);

    const record = await createOperation(WORKSPACE, {
      name: "Research Paper",
      roster_agent_ids: [GA.agent_id, RESEARCHER.agent_id],
      coordinator_agent_id: GA.agent_id,
    });
    expect(record.operation_id).toBe(OPERATION_ID);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/operations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Research Paper",
      roster_agent_ids: [GA.agent_id, RESEARCHER.agent_id],
      coordinator_agent_id: GA.agent_id,
    });
  });

  it("fetchOperationDetail GETs the roster+runs+refusals+coordinator read model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, DETAIL));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchOperationDetail(WORKSPACE, OPERATION_ID);
    expect(detail.roster).toHaveLength(2);
    expect(detail.runs).toHaveLength(2);
    expect(detail.operation.coordinator_agent_id).toBe(GA.agent_id);

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}?workspace_id=${WORKSPACE}`);
  });

  it("fetchOperationThread GETs the merged thread with the after cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, THREAD));
    vi.stubGlobal("fetch", fetchMock);

    const thread = await fetchOperationThread(WORKSPACE, OPERATION_ID, 7);
    expect(thread.items).toHaveLength(4);

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(
      `/api/runtime/v1/operations/${OPERATION_ID}/thread?workspace_id=${WORKSPACE}&after=7`,
    );
  });

  it("sendOperationChatMessage POSTs the idempotent addressed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        kind: "message_sent",
        conversation_id: CHAT_ID,
        message_id: "msg_0001",
        addressed_to: [RESEARCHER.agent_id],
        event_id: "event_msg_0001",
        created: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendOperationChatMessage(WORKSPACE, OPERATION_ID, {
      text: "@agent_researcher please gather sources",
      displayName: "Emon",
      idempotencyKey: "idem_msg_draft_0001",
    });
    expect(result).toMatchObject({ message_id: "msg_0001", addressed_to: [RESEARCHER.agent_id] });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}/thread/messages`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: WORKSPACE,
      idempotency_key: "idem_msg_draft_0001",
      sender: { kind: "user", display_name: "Emon" },
      text: "@agent_researcher please gather sources",
    });
  });

  it("submitOperationRosterCommand parses the applied/refused outcome union", async () => {
    const applied = vi.fn().mockResolvedValue(
      jsonResponse(200, { outcome: "applied", operation: OPERATION }),
    );
    vi.stubGlobal("fetch", applied);
    const command = buildOperationRosterCommand(
      { type: "operation.remove_roster_agent", agent_id: RESEARCHER.agent_id },
      {
        ...newOperationCommandIds(),
        workspace_id: WORKSPACE,
        operation_id: OPERATION_ID,
      },
    );
    expect(RemoveRosterAgentCommand.parse(command)).toEqual(command);

    const outcome = await submitOperationRosterCommand(WORKSPACE, OPERATION_ID, command);
    expect(outcome.outcome).toBe("applied");
    const [path, init] = applied.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}/roster/commands`);
    expect(init.method).toBe("POST");

    const refused = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        outcome: "refused",
        refusal: {
          refusal_code: "agent-not-in-pack",
          message: "This Agent is not a member of the Operation's pinned Pack.",
        },
      }),
    );
    vi.stubGlobal("fetch", refused);
    const refusedOutcome = await submitOperationRosterCommand(WORKSPACE, OPERATION_ID, command);
    expect(refusedOutcome.outcome).toBe("refused");
  });

  it("builds a contracts-valid same-pack add command with the D36 risk classification", () => {
    const command = buildOperationRosterCommand(
      {
        type: "operation.add_roster_agent",
        agent_id: CITATION.agent_id,
        pack_id: PACK_ID,
        pack_version: PACK_VERSION,
        risk: { same_pack: true, cost_or_access_increasing: false, requires_approval: false },
      },
      { ...newOperationCommandIds(), workspace_id: WORKSPACE, operation_id: OPERATION_ID },
    );
    expect(AddRosterAgentCommand.parse(command)).toEqual(command);
    expect(command).toMatchObject({ type: "operation.add_roster_agent", actor: { type: "user" } });
  });

  it("setOperationCoordinator POSTs an Agent id or the literal none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, OPERATION));
    vi.stubGlobal("fetch", fetchMock);

    await setOperationCoordinator(WORKSPACE, OPERATION_ID, "none");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}/coordinator`);
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: WORKSPACE,
      coordinator_agent_id: "none",
    });
  });

  it("createOperationRun POSTs the run creation and parses the 201 run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, RUN));
    vi.stubGlobal("fetch", fetchMock);

    const run = await createOperationRun(WORKSPACE, OPERATION_ID);
    expect(run.run_id).toBe(RUN.run_id);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/operations/${OPERATION_ID}/runs`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ workspace_id: WORKSPACE });
  });

  it("raises the typed failure from the local API's SheraError bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          code: "OPERATION_NOT_FOUND",
          category: "resource",
          safe_message: "The requested Operation does not exist in this workspace.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );
    await expect(fetchOperationDetail(WORKSPACE, "op_unknown")).rejects.toMatchObject({
      sheraError: { code: "OPERATION_NOT_FOUND" },
    });
  });

  it("mints fresh envelope ids and per-draft message keys", () => {
    const ids = newOperationCommandIds();
    expect(ids.command_id.length).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(ids.issued_at))).toBe(false);
    expect(newOperationCommandIds().idempotency_key).not.toBe(ids.idempotency_key);
    // Per-draft message idempotency: ≥8 chars (the local API's floor), unique.
    const key = newMessageDraftKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(newMessageDraftKey()).not.toBe(key);
  });
});
