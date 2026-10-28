import { z } from "zod";

import {
  APPROVAL_CHOICES,
  APPROVAL_REMINDER_SCHEDULE_SECONDS,
  ApprovalChoice,
  ApprovalGrant,
  ApprovalRequest,
  RunState,
  type Actor,
} from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * S20 chunk 5 — the typed browser client for the approvals HTTP surface
 * (chunk 4's /v1/approvals routes), reached through the same-origin runtime
 * proxy (/api/runtime/* → the container's local API). Every failure arrives
 * as the S02 taxonomy through the shared typed-error parser, so surfaces show
 * safe_message only (G3); a 2xx body that breaks its contract is a server
 * drift, never a fabricated success.
 *
 * The card vocabulary is the D9 read the API answers: exact tool, arguments
 * DIGEST (the arguments surface — raw args never enter approval records, G3),
 * target resource, side effect, expiry, requester, scope, status. The
 * decisions POST the USER actor; the API (and service) refuse any agent actor
 * (G6 — the UI never implies an Agent can approve).
 */

/**
 * The D9 card exactly as GET /v1/approvals/pending and :id answer it.
 */
export const ApprovalCardData = ApprovalRequest.extend({
  expires_at: z.string().nullable(),
});
export type ApprovalCardData = z.infer<typeof ApprovalCardData>;

/** Re-exported for the surfaces that name a decision's choice. */
export type { ApprovalChoice } from "@shera-bot/contracts";

/** One E3 reminder slot of one approval (the detail read's reminder rows). */
const ReminderSlotRow = z.strictObject({
  reminder_index: z.number().int().min(0).max(4),
  due_at: z.string(),
  delivered_at: z.string().nullable(),
});
export type ReminderSlotRow = z.infer<typeof ReminderSlotRow>;

/** The journal-rebuilt run read model the detail read carries beside the card. */
export const ApprovalRunReadModel = z.strictObject({
  task_id: z.string(),
  state: RunState,
  version: z.number().int().positive(),
});
export type ApprovalRunReadModel = z.infer<typeof ApprovalRunReadModel>;

export interface ApprovalDetail {
  approval: ApprovalCardData;
  reminders: ReminderSlotRow[];
  run: ApprovalRunReadModel;
}

const ApprovalDetailPayload = z.strictObject({
  approval: ApprovalCardData,
  reminders: z.array(ReminderSlotRow),
  run: ApprovalRunReadModel,
});

/**
 * The decision outcome union, verbatim from POST /v1/approvals/:id/decision:
 * the three terminal choices carry their effects (grant / cancelled children);
 * already_decided is the STORED resolution — the honest retry answer.
 */
export type DecisionOutcome =
  | {
      outcome: "approved";
      approval_id: string;
      request: ApprovalCardData;
      run: ApprovalRunReadModel;
      grant: ApprovalGrantRecord | undefined;
    }
  | {
      outcome: "action_rejected";
      approval_id: string;
      request: ApprovalCardData;
      run: ApprovalRunReadModel;
    }
  | {
      outcome: "task_cancelled";
      approval_id: string;
      request: ApprovalCardData;
      run: ApprovalRunReadModel;
      cancelled_child_run_ids: string[];
    }
  | {
      outcome: "already_decided";
      approval_id: string;
      choice: ApprovalChoice;
      request: ApprovalCardData;
    };

/** A durable grant record: the contracts ApprovalGrant + the v10/v11 columns. */
export const ApprovalGrantRecord = ApprovalGrant.extend({
  args_digest: z.string().nullable(),
  consumed_at: z.string().nullable(),
});
export type ApprovalGrantRecord = z.infer<typeof ApprovalGrantRecord>;

/** One row of the reminder-mute list (GET /v1/approvals/mutes). */
export const ApprovalMuteRecord = z.strictObject({
  workspace_id: z.string(),
  mute_id: z.string(),
  scope: z.enum(["approval", "task", "all"]),
  target_id: z.string().nullable(),
  created_at: z.string(),
  /** The creating user actor's id (the mute's audit record; legacy rows null). */
  created_by: z.string().nullable(),
});
export type ApprovalMuteRecord = z.infer<typeof ApprovalMuteRecord>;

/** One fired reminder slot from the due-reminders scan (E3). */
const DueReminderEntry = z.strictObject({
  workspace_id: z.string(),
  approval_id: z.string(),
  reminder_index: z.number().int().min(0).max(4),
  due_at: z.string(),
  outcome: z.enum(["delivered", "muted"]),
  delivered_at: z.string().nullable(),
});
export type DueReminderEntry = z.infer<typeof DueReminderEntry>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchPendingApprovals(workspaceId: string): Promise<ApprovalCardData[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/approvals/pending?${query.toString()}`,
    (payload) => z.strictObject({ approvals: z.array(ApprovalCardData) }).parse(payload).approvals,
  );
}

export function fetchApprovalDetail(
  workspaceId: string,
  approvalId: string,
): Promise<ApprovalDetail> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/approvals/${encodeURIComponent(approvalId)}?${query.toString()}`,
    (payload) => {
      const detail = ApprovalDetailPayload.parse(payload);
      return { approval: detail.approval, reminders: detail.reminders, run: detail.run };
    },
  );
}

export function fetchApprovalGrants(workspaceId: string): Promise<ApprovalGrantRecord[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/approvals/grants?${query.toString()}`,
    (payload) => z.strictObject({ grants: z.array(ApprovalGrantRecord) }).parse(payload).grants,
  );
}

export function fetchApprovalMutes(workspaceId: string): Promise<ApprovalMuteRecord[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/approvals/mutes?${query.toString()}`,
    (payload) => z.strictObject({ mutes: z.array(ApprovalMuteRecord) }).parse(payload).mutes,
  );
}

/**
 * The reminder scan (E3): fires the due slots of the workspace — delivery
 * stamps delivered_at server-side and NEVER changes run state. The chat views
 * poll it on the presence cadence so the card timelines gain their delivered
 * markers without any local clock authority. (S20 review fix F3: the scan is
 * a POST — it mutates state, so it rides the command verb with the workspace
 * in the body, behind the proxy's Origin check like every mutation.)
 */
export function fetchDueReminders(workspaceId: string): Promise<DueReminderEntry[]> {
  return requestRuntime(
    "/api/runtime/v1/approvals/due-reminders",
    (payload) => z.strictObject({ reminders: z.array(DueReminderEntry) }).parse(payload).reminders,
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  );
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function submitApprovalDecision(input: {
  workspaceId: string;
  approvalId: string;
  choice: ApprovalChoice;
  decidedBy: Actor;
}): Promise<DecisionOutcome> {
  return requestRuntime(
    `/api/runtime/v1/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    (payload) => {
      // The outcome body carries only the fields its outcome needs; plain
      // z.object (not strict) — the union's per-outcome checks below own the
      // required-field drift, not an unknown-keys refusal.
      const parsed = z
        .object({
          outcome: z.enum(["approved", "action_rejected", "task_cancelled", "already_decided"]),
          approval_id: z.string(),
          request: ApprovalCardData,
          choice: ApprovalChoice.optional(),
          run: ApprovalRunReadModel.optional(),
          grant: ApprovalGrantRecord.optional(),
          cancelled_child_run_ids: z.array(z.string()).optional(),
        })
        .safeParse(payload);
      if (!parsed.success) {
        throw new Error("decision payload drift");
      }
      const data = parsed.data;
      switch (data.outcome) {
        case "approved":
          if (data.run === undefined) {
            throw new Error("decision payload drift");
          }
          return {
            outcome: "approved",
            approval_id: data.approval_id,
            request: data.request,
            run: data.run,
            grant: data.grant,
          } satisfies DecisionOutcome;
        case "action_rejected":
          if (data.run === undefined) {
            throw new Error("decision payload drift");
          }
          return {
            outcome: "action_rejected",
            approval_id: data.approval_id,
            request: data.request,
            run: data.run,
          } satisfies DecisionOutcome;
        case "task_cancelled":
          if (data.run === undefined || data.cancelled_child_run_ids === undefined) {
            throw new Error("decision payload drift");
          }
          return {
            outcome: "task_cancelled",
            approval_id: data.approval_id,
            request: data.request,
            run: data.run,
            cancelled_child_run_ids: data.cancelled_child_run_ids,
          } satisfies DecisionOutcome;
        case "already_decided":
          if (data.choice === undefined) {
            throw new Error("decision payload drift");
          }
          return {
            outcome: "already_decided",
            approval_id: data.approval_id,
            choice: data.choice,
            request: data.request,
          } satisfies DecisionOutcome;
      }
    },
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: input.workspaceId,
        choice: input.choice,
        decided_by: input.decidedBy,
      }),
    },
  );
}

export function revokeApprovalGrant(
  workspaceId: string,
  grantId: string,
): Promise<{ revoked: true; grant_id: string }> {
  return requestRuntime(
    "/api/runtime/v1/approvals/grants/revoke",
    (payload) =>
      z.strictObject({ revoked: z.literal(true), grant_id: z.string() }).parse(payload) as {
        revoked: true;
        grant_id: string;
      },
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, grant_id: grantId }),
    },
  );
}

/** The typed mute target for one scope: 'all' carries no target. */
export function muteTargetFor(
  scope: "approval" | "task" | "all",
  approval: Pick<ApprovalCardData, "approval_id" | "task_id">,
): { scope: "approval" | "task" | "all"; target_id?: string } {
  switch (scope) {
    case "approval":
      return { scope, target_id: approval.approval_id };
    case "task":
      return { scope, target_id: approval.task_id };
    case "all":
      return { scope };
  }
}

/**
 * Record one reminder-silencing mute (E3). The mute requires the deciding
 * USER actor (F2) — the session's identity is sent as `created_by`; the web
 * proxy additionally binds it server-side from the authenticated session, so
 * the audit record is the runtime's truth either way.
 */
export function createApprovalMute(
  workspaceId: string,
  target: { scope: "approval" | "task" | "all"; target_id?: string },
  createdBy: Actor,
): Promise<ApprovalMuteRecord> {
  return requestRuntime(
    "/api/runtime/v1/approvals/mutes",
    (payload) => ApprovalMuteRecord.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        scope: target.scope,
        created_by: createdBy,
        ...(target.target_id !== undefined ? { target_id: target.target_id } : {}),
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Polling cadence — the app's established 5s presence cadence (D32), paused
// while the tab is hidden (the approval cards keep the runtime's truth on the
// next visible tick; nothing fabricates liveness while hidden).
// ---------------------------------------------------------------------------

export const APPROVALS_POLL_MS = 5000;

export function approvalsRefetchInterval(
  doc?: { visibilityState?: string } | undefined,
): typeof APPROVALS_POLL_MS | false {
  const visibility = (doc ?? globalThis.document)?.visibilityState;
  return visibility === "hidden" ? false : APPROVALS_POLL_MS;
}

// ---------------------------------------------------------------------------
// Display logic — pure, so the safety copy and the timeline are directly
// testable and every surface renders the SAME vocabulary.
// ---------------------------------------------------------------------------

/**
 * The five choices in PRD §8 order with their VERBATIM labels (UI_DESIGN §7:
 * approval dialog labels are verbatim; do not paraphrase safety copy).
 */
export const APPROVAL_CHOICE_ORDER: readonly ApprovalChoice[] = APPROVAL_CHOICES;

export const APPROVAL_CHOICE_LABELS: Record<ApprovalChoice, string> = {
  "approve-this-execution-only": "Approve this execution only",
  "always-approve-this-tool": "Always approve this tool",
  "always-approve-this-tool-for-this-agent": "Always approve this tool for this agent",
  "reject-this-action": "Reject this action",
  "cancel-the-task": "Cancel the task",
};

/** The E3 schedule as card timeline labels, in slot order (§S8). */
export const REMINDER_SLOT_LABELS = ["Immediate", "15 min", "45 min", "3 h", "24 h"] as const;

/**
 * UTC time label for journal stamps — the app's established convention
 * (lib/thread-layout's timeLabel formats UTC; the journal's instants ARE UTC,
 * so every surface shows the same honest clock instead of a TZ-shifted one).
 */
const UTC_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
});
const UTC_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function utcTimeLabel(iso: string): string {
  return UTC_TIME_FORMATTER.format(new Date(iso));
}

export interface ReminderSlot {
  index: number;
  label: string;
  /** The slot's due time — the runtime's row when provided, else computed. */
  dueAt: string;
  dueLabel: string;
  deliveredAt: string | null;
}

/**
 * The five reminder slots for one approval's timeline. Delivered markers come
 * ONLY from the runtime's detail rows (delivered_at stamps) — the UI never
 * derives delivery from a local clock. When no detail read exists yet, due
 * times are computed from the CONTRACT schedule (requested_at + seconds) —
 * the schedule itself is fixed by PRD §8, so this is the runtime's own rule,
 * not a local invention.
 */
export function reminderSlots(
  requestedAt: string,
  detailReminders?: Array<Pick<ReminderSlotRow, "reminder_index" | "due_at" | "delivered_at">>,
): ReminderSlot[] {
  const requestedMs = Date.parse(requestedAt);
  const rows = new Map(detailReminders?.map((row) => [row.reminder_index, row]) ?? []);
  return APPROVAL_REMINDER_SCHEDULE_SECONDS.map((seconds, index) => {
    const row = rows.get(index);
    const dueAt = row?.due_at ?? new Date(requestedMs + seconds * 1000).toISOString();
    const dueLabel = utcTimeLabel(dueAt);
    return {
      index,
      label: REMINDER_SLOT_LABELS[index] ?? `Slot ${index}`,
      dueAt,
      dueLabel,
      deliveredAt: row?.delivered_at ?? null,
    };
  });
}

/** The expiry slot's honest copy — the prototype's requests/grants may carry null. */
export function formatExpiry(expiresAt: string | null): string {
  if (expiresAt === null) {
    return "No expiry — bounded by the workspace container's lifetime";
  }
  return `Expires ${UTC_DATE_FORMATTER.format(new Date(expiresAt))}, ${utcTimeLabel(expiresAt)} UTC`;
}

/** The resolved card's quiet record line: choice label + time. */
export function formatResolution(approval: ApprovalCardData): string | null {
  if (approval.status === "pending" || approval.resolved_by_choice === undefined) {
    return null;
  }
  const choice = APPROVAL_CHOICE_LABELS[approval.resolved_by_choice];
  return approval.resolved_at
    ? `Decision recorded: ${choice} · ${UTC_DATE_FORMATTER.format(new Date(approval.resolved_at))}, ${utcTimeLabel(approval.resolved_at)} UTC`
    : `Decision recorded: ${choice}`;
}

/** A sha256 digest renders as a short fingerprint — the full hex never helps a human. */
export function digestFingerprint(digest: string): string {
  return digest.slice(0, 8);
}
