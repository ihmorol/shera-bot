import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPROVAL_CHOICES,
  ApprovalRequest,
  type ApprovalChoice,
} from "@shera-bot/contracts";

import {
  ApprovalCard,
  ApprovalDecisionContent,
  ApprovalDecisionModal,
} from "../components/chat/approval-card";
import {
  PendingApprovalsRows,
  pendingApprovalsEmptyNotice,
} from "../components/chat/pending-approvals";
import { OperationRunsPanel } from "../components/operations/operation-runs-panel";
import {
  PermissionsReadout,
  grantsEmptyCopy,
} from "../components/settings/permissions-settings";
import type { AgentRosterSummary } from "../lib/agent-api";
import {
  APPROVALS_POLL_MS,
  approvalsRefetchInterval,
  APPROVAL_CHOICE_LABELS,
  APPROVAL_CHOICE_ORDER,
  createApprovalMute,
  fetchApprovalDetail,
  fetchApprovalGrants,
  fetchApprovalMutes,
  fetchDueReminders,
  fetchPendingApprovals,
  formatExpiry,
  muteTargetFor,
  reminderSlots,
  revokeApprovalGrant,
  submitApprovalDecision,
  type ApprovalCardData,
  type ApprovalDetail,
  type ApprovalGrantRecord,
  type ApprovalMuteRecord,
  type DecisionOutcome,
  type DueReminderEntry,
} from "../lib/approvals-api";

/**
 * S20 chunk 5 — the approvals web UI (UI_DESIGN §S8, D9, PRD §8, E3): the
 * in-thread D9 approval card, the five-choice decision modal, mute controls,
 * the WAITING_FOR_APPROVAL run display, and the Settings → Permissions &
 * approvals surface, all rendered to static markup (node environment, no DOM)
 * like the S13 suites. Data comes from the REAL S20 approvals HTTP surface
 * under /v1/approvals, reached through the same-origin runtime proxy; fetch is
 * stubbed at that boundary, and the real round trip is proven in
 * apps/user-runtime (s20-approvals-api suite).
 *
 * The five choice labels are VERBATIM PRD §8 copy (UI_DESIGN §7: "Do not
 * paraphrase safety copy"); the card fields are the D9 vocabulary the S20 API
 * answers — the arguments surface is the digest only, never raw args (G3).
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

const WORKSPACE = "ws_account-1";

/** The five PRD §8 labels, verbatim from UI_DESIGN §S8. */
const VERBATIM_CHOICES = [
  "Approve this execution only",
  "Always approve this tool",
  "Always approve this tool for this agent",
  "Reject this action",
  "Cancel the task",
] as const;

const REQUESTED_AT = "2026-10-28T10:00:00.000Z";

const PENDING_APPROVAL: ApprovalCardData = {
  approval_id: "approval_pending_01",
  workspace_id: WORKSPACE,
  task_id: "task_run_01",
  conversation_id: "conversation_operation_chat_01",
  tool_id: "tool_repo_issue_create",
  tool_version: "2.1.0",
  capability: "repo.issue.create",
  risk_class: "EXTERNAL_WRITE",
  resource_scope: "repo:shera-bot/issues",
  args_digest: "9f2c44e7a1b0d3f5c6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
  side_effect_summary: "Opens one issue in the pinned repository's tracker.",
  requested_by: { type: "agent", id: "agent_researcher" },
  requested_at: REQUESTED_AT,
  status: "pending",
  expires_at: null,
};

const RESOLVED_APPROVAL: ApprovalCardData = {
  ...PENDING_APPROVAL,
  approval_id: "approval_resolved_01",
  status: "approved",
  resolved_at: "2026-10-28T10:05:00.000Z",
  resolved_by_choice: "always-approve-this-tool",
};

const RESEARCHER: AgentRosterSummary = {
  agent_id: "agent_researcher",
  display_name: "Researcher",
  role_description: "Gathers and checks sources",
  avatar_hue: 200,
  initial_glyph: "R",
  has_user_instructions: false,
  session: { presence: "active" },
};

/** The detail read model's five E3 slots (index 1 delivered). */
const DETAIL_REMINDERS = [
  { reminder_index: 0, due_at: REQUESTED_AT, delivered_at: REQUESTED_AT },
  { reminder_index: 1, due_at: "2026-10-28T10:15:00.000Z", delivered_at: null },
  { reminder_index: 2, due_at: "2026-10-28T10:45:00.000Z", delivered_at: null },
  { reminder_index: 3, due_at: "2026-10-28T13:00:00.000Z", delivered_at: null },
  { reminder_index: 4, due_at: "2026-10-29T10:00:00.000Z", delivered_at: null },
];

const APPROVAL_DETAIL: ApprovalDetail = {
  approval: PENDING_APPROVAL,
  reminders: DETAIL_REMINDERS,
  run: { task_id: "task_run_01", state: "WAITING_FOR_APPROVAL", version: 3 },
};

// ---------------------------------------------------------------------------
// 1. The typed approvals client through the same-origin proxy
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

describe("Approvals client (proxy paths)", () => {
  it("fetchPendingApprovals GETs the workspace's pending D9 cards", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { approvals: [PENDING_APPROVAL] }));
    vi.stubGlobal("fetch", fetchMock);

    const approvals = await fetchPendingApprovals(WORKSPACE);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approval_id: "approval_pending_01",
      tool_id: "tool_repo_issue_create",
      tool_version: "2.1.0",
      risk_class: "EXTERNAL_WRITE",
      args_digest: PENDING_APPROVAL.args_digest,
      side_effect_summary: "Opens one issue in the pinned repository's tracker.",
      status: "pending",
    });

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/approvals/pending?workspace_id=${WORKSPACE}`);
  });

  it("fetchApprovalDetail GETs the card, the five E3 slots, and the run state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          approval: PENDING_APPROVAL,
          reminders: DETAIL_REMINDERS,
          run: APPROVAL_DETAIL.run,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchApprovalDetail(WORKSPACE, "approval_pending_01");
    expect(detail.reminders).toHaveLength(5);
    expect(detail.run).toEqual({ task_id: "task_run_01", state: "WAITING_FOR_APPROVAL", version: 3 });

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(
      `/api/runtime/v1/approvals/approval_pending_01?workspace_id=${WORKSPACE}`,
    );
  });

  it("submitApprovalDecision POSTs the user actor and parses the approved outcome with its grant", async () => {
    const grant: ApprovalGrantRecord = {
      grant_id: "grant_01",
      workspace_id: WORKSPACE,
      source_choice: "approve-this-execution-only",
      principal_type: "user",
      principal_id: "user-1",
      tool_id: "tool_repo_issue_create",
      tool_version: "2.1.0",
      capability: "repo.issue.create",
      resource_scope: "repo:shera-bot/issues",
      conversation_scope: "any",
      workspace_scope: WORKSPACE,
      expires_at: null,
      one_time: true,
      created_by: { type: "user", id: "user-1" },
      approved_at: "2026-10-28T10:05:00.000Z",
      revoked_at: null,
      args_digest: PENDING_APPROVAL.args_digest,
      consumed_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        outcome: "approved",
        approval_id: "approval_pending_01",
        request: RESOLVED_APPROVAL,
        run: { task_id: "task_run_01", state: "RUNNING", version: 4 },
        grant,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await submitApprovalDecision({
      workspaceId: WORKSPACE,
      approvalId: "approval_pending_01",
      choice: "approve-this-execution-only",
      decidedBy: { type: "user", id: "user-1" },
    });
    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome === "approved") {
      expect(outcome.grant?.grant_id).toBe("grant_01");
      expect(outcome.run.state).toBe("RUNNING");
    }

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/runtime/v1/approvals/approval_pending_01/decision`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: WORKSPACE,
      choice: "approve-this-execution-only",
      decided_by: { type: "user", id: "user-1" },
    });
  });

  it("parses task_cancelled (with the cancelled children) and the already_decided safe retry", async () => {
    const cancelled: DecisionOutcome = {
      outcome: "task_cancelled",
      approval_id: "approval_pending_01",
      request: { ...PENDING_APPROVAL, status: "cancelled" },
      run: { task_id: "task_run_01", state: "CANCELLED", version: 4 },
      cancelled_child_run_ids: ["task_run_02"],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, cancelled));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await submitApprovalDecision({
      workspaceId: WORKSPACE,
      approvalId: "approval_pending_01",
      choice: "cancel-the-task",
      decidedBy: { type: "user", id: "user-1" },
    });
    expect(outcome.outcome).toBe("task_cancelled");
    if (outcome.outcome === "task_cancelled") {
      expect(outcome.cancelled_child_run_ids).toEqual(["task_run_02"]);
    }

    const already: DecisionOutcome = {
      outcome: "already_decided",
      approval_id: "approval_pending_01",
      choice: "reject-this-action",
      request: { ...PENDING_APPROVAL, status: "rejected" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, already)),
    );
    const retried = await submitApprovalDecision({
      workspaceId: WORKSPACE,
      approvalId: "approval_pending_01",
      choice: "approve-this-execution-only",
      decidedBy: { type: "user", id: "user-1" },
    });
    expect(retried.outcome).toBe("already_decided");
  });

  it("raises the typed failure (an agent actor is refused — G6) with its safe message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          code: "APPROVAL_DECISION_ACTOR_FORBIDDEN",
          category: "permission",
          safe_message: "Only a user can decide an approval.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );
    await expect(
      submitApprovalDecision({
        workspaceId: WORKSPACE,
        approvalId: "approval_pending_01",
        choice: "approve-this-execution-only",
        decidedBy: { type: "user", id: "user-1" },
      }),
    ).rejects.toMatchObject({
      sheraError: { safe_message: "Only a user can decide an approval." },
    });
  });

  it("fetchApprovalGrants lists active grants; revokeApprovalGrant POSTs the revoke", async () => {
    const grant: ApprovalGrantRecord = {
      grant_id: "grant_02",
      workspace_id: WORKSPACE,
      source_choice: "always-approve-this-tool",
      principal_type: "user",
      principal_id: "user-1",
      tool_id: "tool_repo_issue_create",
      tool_version: "2.1.0",
      capability: "repo.issue.create",
      resource_scope: "repo:shera-bot/issues",
      conversation_scope: "any",
      workspace_scope: WORKSPACE,
      expires_at: "2026-11-28T10:00:00.000Z",
      one_time: false,
      created_by: { type: "user", id: "user-1" },
      approved_at: "2026-10-28T10:05:00.000Z",
      revoked_at: null,
      args_digest: null,
      consumed_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { grants: [grant] }));
    vi.stubGlobal("fetch", fetchMock);

    const grants = await fetchApprovalGrants(WORKSPACE);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ grant_id: "grant_02", tool_id: "tool_repo_issue_create" });
    const [listPath] = fetchMock.mock.calls[0] as [string];
    expect(listPath).toBe(`/api/runtime/v1/approvals/grants?workspace_id=${WORKSPACE}`);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { revoked: true, grant_id: "grant_02" })),
    );
    const result = await revokeApprovalGrant(WORKSPACE, "grant_02");
    expect(result).toEqual({ revoked: true, grant_id: "grant_02" });
    const [path, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/approvals/grants/revoke");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: WORKSPACE,
      grant_id: "grant_02",
    });
  });

  it("createApprovalMute posts the scope with its target (approval / task / all)", async () => {
    const mute: ApprovalMuteRecord = {
      workspace_id: WORKSPACE,
      mute_id: "mute_01",
      scope: "task",
      target_id: "task_run_01",
      created_at: "2026-10-28T10:06:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, mute));
    vi.stubGlobal("fetch", fetchMock);

    const created = await createApprovalMute(WORKSPACE, muteTargetFor("task", PENDING_APPROVAL));
    expect(created).toMatchObject({ mute_id: "mute_01", scope: "task" });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/approvals/mutes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: WORKSPACE,
      scope: "task",
      target_id: "task_run_01",
    });
  });

  it("muteTargetFor maps the three scopes; the workspace-wide mute carries no target", () => {
    expect(muteTargetFor("approval", PENDING_APPROVAL)).toEqual({
      scope: "approval",
      target_id: "approval_pending_01",
    });
    expect(muteTargetFor("task", PENDING_APPROVAL)).toEqual({
      scope: "task",
      target_id: "task_run_01",
    });
    expect(muteTargetFor("all", PENDING_APPROVAL)).toEqual({ scope: "all" });
  });

  it("fetchApprovalMutes lists mutes; fetchDueReminders lists the fired slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          mutes: [
            {
              workspace_id: WORKSPACE,
              mute_id: "mute_01",
              scope: "all",
              target_id: null,
              created_at: "2026-10-28T10:06:00.000Z",
            },
          ],
        }),
      ),
    );
    const mutes = await fetchApprovalMutes(WORKSPACE);
    expect(mutes).toHaveLength(1);
    const [mutesPath] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(mutesPath).toBe(`/api/runtime/v1/approvals/mutes?workspace_id=${WORKSPACE}`);

    const entry: DueReminderEntry = {
      workspace_id: WORKSPACE,
      approval_id: "approval_pending_01",
      reminder_index: 1,
      due_at: "2026-10-28T10:15:00.000Z",
      outcome: "delivered",
      delivered_at: "2026-10-28T10:15:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { reminders: [entry] })));
    const reminders = await fetchDueReminders(WORKSPACE);
    expect(reminders).toEqual([entry]);
    const [duePath] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(duePath).toBe(`/api/runtime/v1/approvals/due-reminders?workspace_id=${WORKSPACE}`);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure display logic — choices, reminder slots, expiry
// ---------------------------------------------------------------------------

describe("Approval display logic", () => {
  it("the five choices map to the contract ids in PRD §8 order, verbatim", () => {
    expect(APPROVAL_CHOICE_ORDER).toEqual([...APPROVAL_CHOICES]);
    expect(APPROVAL_CHOICE_ORDER.map((choice) => APPROVAL_CHOICE_LABELS[choice])).toEqual([
      ...VERBATIM_CHOICES,
    ]);
  });

  it("the poll cadence matches the app's 5s presence cadence and pauses when hidden", () => {
    expect(APPROVALS_POLL_MS).toBe(5000);
    expect(approvalsRefetchInterval({ visibilityState: "visible" })).toBe(5000);
    expect(approvalsRefetchInterval({ visibilityState: "hidden" })).toBe(false);
  });

  it("reminderSlots renders the five E3 slots with delivered markers from the detail read", () => {
    const slots = reminderSlots(REQUESTED_AT, DETAIL_REMINDERS);
    expect(slots.map((slot) => slot.label)).toEqual([
      "Immediate",
      "15 min",
      "45 min",
      "3 h",
      "24 h",
    ]);
    // Slot 0's delivered stamp comes from the runtime's row; the rest stay honest.
    expect(slots[0]?.deliveredAt).toBe(REQUESTED_AT);
    expect(slots[1]?.deliveredAt).toBeNull();
    // Due times ride the runtime's due_at when the detail read provides them.
    expect(slots[1]?.dueAt).toBe("2026-10-28T10:15:00.000Z");
    expect(slots[4]?.dueAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("reminderSlots computes due times from the contract schedule when no detail row exists", () => {
    const slots = reminderSlots(REQUESTED_AT);
    expect(slots).toHaveLength(5);
    expect(slots.every((slot) => slot.deliveredAt === null)).toBe(true);
    expect(slots[1]?.dueAt).toBe("2026-10-28T10:15:00.000Z");
    expect(slots[2]?.dueAt).toBe("2026-10-28T10:45:00.000Z");
    expect(slots[3]?.dueAt).toBe("2026-10-28T13:00:00.000Z");
    expect(slots[4]?.dueAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("formatExpiry answers the honest no-expiry copy for the prototype's null", () => {
    expect(formatExpiry(null)).toContain("No expiry");
    expect(formatExpiry("2026-11-28T10:00:00.000Z")).toContain("2026");
  });
});

// ---------------------------------------------------------------------------
// 3. The in-thread approval card (D9 fields, reminders, mutes, resolution)
// ---------------------------------------------------------------------------

function renderCard(props: Record<string, unknown> = {}): string {
  return render(
    createElement(ApprovalCard, {
      approval: PENDING_APPROVAL,
      identities: [RESEARCHER],
      reminders: undefined,
      onReview: () => undefined,
      onMute: () => undefined,
      reviewPending: false,
      mutePending: false,
      ...props,
    }),
  );
}

describe("Approval card (§S8, D9)", () => {
  it("renders every D9 field: exact tool + version, capability, target, side effect, digest, risk, requester, scope", () => {
    const html = renderCard();
    expect(html).toContain("tool_repo_issue_create");
    expect(html).toContain("2.1.0");
    expect(html).toContain("repo.issue.create");
    expect(html).toContain("repo:shera-bot/issues");
    // SSR entity-encodes the apostrophe (the S13 suites' verbatim-check trick:
    // assert the apostrophe-free prefix).
    expect(html).toContain("Opens one issue in the pinned repository");
    // G3: the digest IS the arguments surface — a short fingerprint renders, never raw args.
    expect(html).toContain("9f2c44e7");
    expect(html).not.toContain('{"');
    expect(html).toContain("EXTERNAL_WRITE");
    // The requesting Agent resolves through the roster — never a fabricated name.
    expect(html).toContain("Researcher");
    expect(html).not.toContain("Expert");
    // Task/conversation scope.
    expect(html).toContain("task_run_01");
    expect(html).toContain("conversation_operation_chat_01");
    // Requested time renders.
    expect(html).toContain("10:00");
  });

  it("the expiry slot is honest when the prototype carries no expiry", () => {
    const html = renderCard();
    expect(html).toContain("No expiry");
  });

  it("renders the reminder timeline: five slots, delivered markers from the detail read", () => {
    const html = renderCard({ reminders: DETAIL_REMINDERS });
    expect(html).toContain("Immediate");
    expect(html).toContain("15 min");
    expect(html).toContain("45 min");
    expect(html).toContain("3 h");
    expect(html).toContain("24 h");
    // Slot 0 delivered — the marker is text, not color alone (§2.3).
    expect(html).toContain("delivered");
  });

  it("offers the decision affordance and the three mute scopes with the notifications-only copy", () => {
    const html = renderCard();
    expect(html).toContain("Review decision");
    expect(html).toContain("Mute this approval");
    expect(html).toContain("Mute this task");
    expect(html).toContain("Mute all reminders");
    // E3 honesty: mutes stop notifications only — never the pause, never visibility.
    expect(html).toContain("notifications only");
    expect(html).toContain("stays paused");
    expect(html).toContain("stays visible");
  });

  it("a resolved card records the decision quietly — no decision affordance remains", () => {
    const html = render(
      createElement(ApprovalCard, {
        approval: RESOLVED_APPROVAL,
        identities: [RESEARCHER],
        reminders: undefined,
        onReview: () => undefined,
        onMute: () => undefined,
        reviewPending: false,
        mutePending: false,
      }),
    );
    expect(html).toContain("Always approve this tool");
    expect(html).toContain("Decision recorded");
    expect(html).not.toContain("Review decision");
    expect(html).not.toContain("Mute this approval");
  });

  it("is an assertive live region (§2.3: tool/approval events announce)", () => {
    const html = renderCard();
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("aria-atomic");
  });
});

// ---------------------------------------------------------------------------
// 4. The decision modal — five verbatim choices, focus contract, announcements
// ---------------------------------------------------------------------------

function renderModal(props: Record<string, unknown> = {}): string {
  return render(
    createElement(ApprovalDecisionContent, {
      approval: PENDING_APPROVAL,
      identities: [RESEARCHER],
      run: APPROVAL_DETAIL.run,
      onChoose: () => undefined,
      onDismiss: () => undefined,
      chosenChoice: null,
      pending: false,
      safeErrorMessage: null,
      ...props,
    }),
  );
}

describe("Approval decision modal (§S8, §2.3)", () => {
  it("renders exactly the five PRD §8 choices, verbatim and in order", () => {
    const html = renderModal();
    let cursor = -1;
    for (const label of VERBATIM_CHOICES) {
      const at = html.indexOf(label);
      expect(at, `missing choice: ${label}`).toBeGreaterThan(-1);
      expect(at, `choice out of order: ${label}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("the Radix wrapper carries the modal semantics: trap, Escape, redirect to the first choice", () => {
    // The dialog box is a Radix Portal — not server-renderable — so its
    // semantics assert at source level (the ui/sheet.tsx precedent). Radix
    // supplies role="dialog" + aria-modal + the focus trap + Escape; the
    // default open-focus is REDIRECTED so the first choice takes it.
    const source = readFileSync(
      join(import.meta.dirname, "..", "components", "chat", "approval-card.tsx"),
      "utf8",
    );
    expect(source).toContain("@radix-ui/react-dialog");
    expect(source).toContain("onOpenAutoFocus={(event) => event.preventDefault()}");
    expect(source).toMatch(/querySelector<HTMLElement>\("\[data-autofocus\]"\)/);
    expect(source).toMatch(/DialogPrimitive\.Content/);
  });

  it("the request announces assertively with the tool named", () => {
    const html = renderModal();
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("tool_repo_issue_create");
    expect(html).toContain("Researcher asks to run");
    expect(html).toContain("paused until you decide");
  });

  it("the five choices are the only initially focusable actions (§2.3 focus contract)", () => {
    const html = renderModal();
    // Initial focus is MARKED on the first choice (the wrapper focuses it on
    // open)…
    expect(html).toContain('data-autofocus="true"');
    const autofocusAt = html.indexOf("data-autofocus");
    expect(html.slice(autofocusAt, autofocusAt + 400)).toContain(VERBATIM_CHOICES[0]);
    // …and the panel's only other affordance (close) is out of the initial
    // tab order — the five choices are what Tab reaches first.
    expect(html).toContain('tabindex="-1"');
    // No other focusable control exists in the panel.
    const focusableButtons = html.split("<button").length - 1;
    expect(focusableButtons).toBe(6); // five choices + the close affordance
  });

  it("while a decision is pending the choices disable; an error keeps its safe message", () => {
    const pending = renderModal({ pending: true, chosenChoice: "approve-this-execution-only" });
    expect(pending).toMatch(/<button[^>]*?\bdisabled=""/);
    expect(pending).toContain("aria-busy");

    const failed = renderModal({ safeErrorMessage: "The decision was not accepted. Try again." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The decision was not accepted. Try again.");
  });
});

// ---------------------------------------------------------------------------
// 5. The in-thread pending approvals region
// ---------------------------------------------------------------------------

describe("Pending approvals region (in-thread)", () => {
  it("renders one card row per pending approval; an empty workspace renders nothing", () => {
    const rows = render(
      createElement(PendingApprovalsRows, {
        approvals: [PENDING_APPROVAL],
        resolvedLocally: [],
        remindersByApproval: {},
        runByApproval: { approval_pending_01: APPROVAL_DETAIL.run },
        identities: [RESEARCHER],
        decidedByReady: true,
        openApprovalId: null,
        chosenChoice: null,
        decisionPending: false,
        decisionSafeError: null,
        mutePending: false,
        onOpenChange: () => undefined,
        onChoose: () => undefined,
        onMute: () => undefined,
      }),
    );
    expect(rows).toContain("approval_pending_01");
    expect(rows).toContain("Review decision");

    expect(
      render(
        createElement(PendingApprovalsRows, {
          approvals: [],
          resolvedLocally: [],
          remindersByApproval: {},
          runByApproval: {},
          identities: [RESEARCHER],
          decidedByReady: true,
          openApprovalId: null,
          chosenChoice: null,
          decisionPending: false,
          decisionSafeError: null,
          mutePending: false,
          onOpenChange: () => undefined,
          onChoose: () => undefined,
          onMute: () => undefined,
        }),
      ),
    ).toBe("");
  });

  it("decisions settled this session keep their quiet resolved card in the thread", () => {
    const rows = render(
      createElement(PendingApprovalsRows, {
        approvals: [],
        resolvedLocally: [RESOLVED_APPROVAL],
        remindersByApproval: {},
        runByApproval: {},
        identities: [RESEARCHER],
        decidedByReady: true,
        openApprovalId: null,
        chosenChoice: null,
        decisionPending: false,
        decisionSafeError: null,
        mutePending: false,
        onOpenChange: () => undefined,
        onChoose: () => undefined,
        onMute: () => undefined,
      }),
    );
    expect(rows).toContain("Decision recorded");
    expect(rows).toContain("Always approve this tool");
    expect(rows).not.toContain("Review decision");
  });

  it("the conversation-scoped helper exposes the quiet wait copy for thread surfaces", () => {
    // The region's wrapper copy: what the thread shows while an approval pends.
    expect(pendingApprovalsEmptyNotice).toContain("No approvals");
  });
});

// ---------------------------------------------------------------------------
// 6. WAITING_FOR_APPROVAL display in the runs panel
// ---------------------------------------------------------------------------

const RUN = {
  run_id: "run_01",
  workspace_id: WORKSPACE,
  operation_id: "op_01",
  parent_task_id: null,
  state: "WAITING_FOR_APPROVAL" as const,
  events_seq_cursor: 4,
  credits: {},
  artifacts: [],
  created_at: "2026-10-28T10:00:00.000Z",
  updated_at: "2026-10-28T10:01:00.000Z",
};

describe("WAITING_FOR_APPROVAL display (§S8)", () => {
  it("the waiting run shows the amber approval state with a text signal, not color alone", () => {
    const html = render(
      createElement(OperationRunsPanel, {
        runs: [RUN],
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        onCreateRun: () => undefined,
        createPending: false,
      }),
    );
    expect(html).toContain("WAITING_FOR_APPROVAL");
    expect(html).toContain("text-approval");
    expect(html).toContain("paused for your approval");
  });
});

// ---------------------------------------------------------------------------
// 7. Settings → Permissions & approvals
// ---------------------------------------------------------------------------

const GRANT: ApprovalGrantRecord = {
  grant_id: "grant_02",
  workspace_id: WORKSPACE,
  source_choice: "always-approve-this-tool",
  principal_type: "agent",
  principal_id: "agent_researcher",
  tool_id: "tool_repo_issue_create",
  tool_version: "2.1.0",
  capability: "repo.issue.create",
  resource_scope: "repo:shera-bot/issues",
  conversation_scope: "any",
  workspace_scope: WORKSPACE,
  expires_at: null,
  one_time: false,
  created_by: { type: "user", id: "user-1" },
  approved_at: "2026-10-28T10:05:00.000Z",
  revoked_at: null,
  args_digest: null,
  consumed_at: null,
};

const ONE_TIME_GRANT: ApprovalGrantRecord = {
  ...GRANT,
  grant_id: "grant_03",
  source_choice: "approve-this-execution-only",
  one_time: true,
  consumed_at: "2026-10-28T10:09:00.000Z",
};

const MUTE: ApprovalMuteRecord = {
  workspace_id: WORKSPACE,
  mute_id: "mute_01",
  scope: "task",
  target_id: "task_run_01",
  created_at: "2026-10-28T10:06:00.000Z",
};

function renderPermissions(props: Record<string, unknown> = {}): string {
  return render(
    createElement(PermissionsReadout, {
      state: "ready",
      grants: [GRANT],
      mutes: [MUTE],
      identities: [RESEARCHER],
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      onRevoke: () => undefined,
      revokePendingGrantId: null,
      successNote: null,
      errorMessage: null,
      ...props,
    }),
  );
}

describe("Permissions & approvals settings (§S9, D9/D35)", () => {
  it("lists every active grant with scope, tool + version, expiry, and creator", () => {
    const html = renderPermissions();
    expect(html).toContain("tool_repo_issue_create");
    expect(html).toContain("2.1.0");
    expect(html).toContain("repo.issue.create");
    expect(html).toContain("repo:shera-bot/issues");
    // The agent principal resolves through the roster (D39 identity).
    expect(html).toContain("Researcher");
    // Created by the user actor; expiry honest (null → no-expiry copy).
    expect(html).toContain("user-1");
    expect(html).toContain("No expiry");
    expect(html).toContain("Revoke");
    expect(html).toContain('aria-label="Revoke grant grant_02"');
  });

  it("a consumed one-time grant says so honestly", () => {
    const html = renderPermissions({ grants: [ONE_TIME_GRANT] });
    expect(html).toContain("One-time");
    expect(html).toContain("used");
  });

  it("lists reminder mutes with the honest no-unmute note", () => {
    const html = renderPermissions();
    expect(html).toContain("task_run_01");
    expect(html).toContain("Task");
    // The API has no un-mute path in this prototype — the surface says so.
    expect(html).toContain("cannot be removed");
  });

  it("the grants empty state teaches where grants come from", () => {
    expect(grantsEmptyCopy).toContain("Always approve");
    const html = renderPermissions({ grants: [] });
    expect(html).toContain(grantsEmptyCopy);
  });

  it("loading is a skeleton; error carries the safe message + retry", () => {
    const loading = renderPermissions({ state: "loading", grants: [], mutes: [] });
    expect(loading).toContain("animate-pulse");

    const error = renderPermissions({
      state: "error",
      grants: [],
      mutes: [],
      safeErrorMessage: "The grants list could not be loaded.",
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain("The grants list could not be loaded.");
    expect(error).toContain("Retry");
  });

  it("a revoke surfaces its typed outcome inline (success note / safe error)", () => {
    const success = renderPermissions({ successNote: "Grant revoked. The next execution needs a new approval." });
    expect(success).toContain('role="status"');
    expect(success).toContain("Grant revoked. The next execution needs a new approval.");

    const failure = renderPermissions({ errorMessage: "The revoke was not accepted." });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("The revoke was not accepted.");
  });
});
