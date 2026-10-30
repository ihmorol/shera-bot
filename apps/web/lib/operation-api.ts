import { z } from "zod";

import type { QueryClient } from "@tanstack/react-query";

import {
  AddRosterAgentCommand,
  OperationCollaborationEvent,
  OperationCoordinatorRef,
  OperationRecord,
  OperationRenameCommand,
  OperationRun,
  RemoveRosterAgentCommand,
  RosterRefusal,
  RosterRiskClassification,
  type OperationCollaborationEvent as OperationCollaborationEventType,
  type OperationRecord as OperationRecordType,
  type OperationRun as OperationRunType,
} from "@shera-bot/contracts";

import { AGENT_SETTINGS_USER_ACTOR } from "@/lib/agent-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * The Agent-shaped identity the avatar component consumes, built from the
 * allowlisted roster summary (whose identity fields are flat). D39: the
 * pack-authored hue + glyph ride along everywhere the Agent appears.
 */
export function agentIdentityFromSummary(summary: {
  agent_id: string;
  display_name: string;
  avatar_hue: number;
  initial_glyph: string;
}): {
  agent_id: string;
  display_name: string;
  ui_identity: { avatar_hue: number; initial_glyph: string };
} {
  return {
    agent_id: summary.agent_id,
    display_name: summary.display_name,
    ui_identity: { avatar_hue: summary.avatar_hue, initial_glyph: summary.initial_glyph },
  };
}

/**
 * Typed browser client for the S13 Operation chat surfaces (chunk 4), reached
 * through the same-origin runtime proxy exactly like the conversation and
 * agent clients (lib/runtime-client.ts, lib/agent-api.ts — the same transport
 * idiom and typed failures):
 *
 *   GET  /v1/operations                              workspace Operation records
 *   POST /v1/operations                              ad-hoc creation (D29/D41)
 *   GET  /v1/operations/:operation_id                detail: record + roster
 *                                                    (D36 requires_approval)
 *                                                    + runs + recent refusals
 *                                                    + chat binding id
 *   GET  /v1/operations/:operation_id/thread         the merged D41 thread
 *                                                    (messages + D7 events)
 *   POST /v1/operations/:operation_id/thread/messages  addressed message (D41)
 *   POST /v1/operations/:operation_id/roster/commands  the ONE roster mutation
 *                                                      surface (D36 contracts
 *                                                      command union)
 *   POST /v1/operations/:operation_id/coordinator    set an Agent or "none"
 *                                                    (D42/D49)
 *   POST /v1/operations/:operation_id/rename       rename (S14, D41/D23 r6 —
 *                                                  the OperationRenameCommand
 *                                                  envelope, durable row
 *                                                  update + receipt replay)
 *   POST /v1/operations/:operation_id/runs           create one run (D31)
 *
 * The D7 collaboration-event write route is deliberately NOT exposed: the
 * browser renders collaboration events, it never authors them (agents propose;
 * the runtime validates and executes).
 *
 * Command envelopes are built CLIENT-SIDE (command_id + idempotency_key +
 * issued_at minted per submit) and validated through the SAME contracts
 * schemas the runtime parses — a malformed command fails at build time, never
 * as a 400 on the wire. The actor is the S01 fixture user, exactly like the
 * settings commands; the real signed-in principal rides the authenticated
 * transport in a later chunk and is deliberately not faked here (G4).
 */

/** One roster member of the detail read model (display names may be unknown). */
export const OperationRosterMemberSchema = z.strictObject({
  agent_id: z.string().min(1),
  display_name: z.string().nullable(),
  requires_approval: z.boolean(),
  pack_id: z.string().min(1),
  pack_version: z.string().min(1),
  added_at: z.string().min(1),
});
export type OperationRosterMember = z.infer<typeof OperationRosterMemberSchema>;

/** One persisted D36 refusal (fixed safe copy — rendered verbatim, G3). */
export const OperationRefusalRowSchema = z.strictObject({
  refusal_code: z.string().min(1),
  agent_id: z.string().nullable(),
  pack_id: z.string().nullable(),
  message: z.string().min(1),
  created_at: z.string().min(1),
});
export type OperationRefusalRow = z.infer<typeof OperationRefusalRowSchema>;

/** One pinned-pack skill in the F6 pack summary (the pack may omit a title). */
export const PackSummarySkillSchema = z.strictObject({
  skill_id: z.string().min(1),
  title: z.string().nullable(),
});

/** One pinned-pack connector in the F6 pack summary (honestly not-configured). */
export const PackSummaryConnectorSchema = z.strictObject({
  connector_id: z.string().min(1),
  connected: z.boolean(),
});

/** The S6/F6 pack summary block (mirrors the runtime's read model verbatim). */
export const PackSummarySchema = z.strictObject({
  skills: z.array(PackSummarySkillSchema),
  connectors: z.array(PackSummaryConnectorSchema),
});
export type PackSummary = z.infer<typeof PackSummarySchema>;

/** The S13 detail read model: record + roster + runs + refusals + chat binding. */
export const OperationDetailSchema = z.strictObject({
  operation: OperationRecord,
  // S14 (D41): the derived ad-hoc fields — is_adhoc flags a definition-less
  // Operation; auto_label flags the server-derived `Ad-hoc · N Agents` name.
  is_adhoc: z.boolean(),
  auto_label: z.boolean(),
  roster: z.array(OperationRosterMemberSchema),
  runs: z.array(OperationRun),
  recent_refusals: z.array(OperationRefusalRowSchema),
  chat_conversation_id: z.string().nullable(),
  // S14 (UI_DESIGN S6/F6): the pinned pack's skills and connectors. The
  // runtime derives it honestly — every connector reports connected: false
  // in the prototype (D38: recommended, never auto-installed; no connector
  // runtime), so the UI may render "Not configured" but never "Connected".
  pack_summary: PackSummarySchema,
});
export type OperationDetail = z.infer<typeof OperationDetailSchema>;

/** Sender attribution on a thread message (the service's union verbatim). */
const OperationMessageSenderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), display_name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("agent"), agent_id: z.string().min(1) }),
]);

/** A conversation message in the merged thread (D41). */
export const ThreadMessageItemSchema = z.strictObject({
  kind: z.literal("message"),
  message_id: z.string().min(1),
  conversation_id: z.string().min(1),
  sequence: z.number().int().min(0),
  sender: OperationMessageSenderSchema,
  text: z.string(),
  addressed_to: z.array(z.string()),
  occurred_at: z.string().min(1),
});

/** A D7 collaboration event in the merged thread (attributable typed card). */
export const ThreadEventItemSchema = z.strictObject({
  kind: z.literal("collaboration_event"),
  sequence: z.number().int().min(0),
  stream_id: z.string().min(1),
  sender: z.strictObject({
    kind: z.literal("agent"),
    agent_id: z.string().min(1),
    display_name: z.string().nullable(),
  }),
  event: OperationCollaborationEvent,
  issued_at: z.string().min(1),
});

export const OperationThreadItemSchema = z.discriminatedUnion("kind", [
  ThreadMessageItemSchema,
  ThreadEventItemSchema,
]);
export type OperationThreadItem = z.infer<typeof OperationThreadItemSchema>;

export const OperationThreadSchema = z.strictObject({
  operation_id: z.string().min(1),
  workspace_id: z.string().min(1),
  chat_conversation_id: z.string().min(1),
  items: z.array(OperationThreadItemSchema),
});
export type OperationThreadPayload = z.infer<typeof OperationThreadSchema>;

/** The addressed message send receipt (one durable message per key, D23 rule 6). */
export const MessageSendResultSchema = z.strictObject({
  kind: z.literal("message_sent"),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  /** The resolved recipient Agent ids; [] = unaddressed (Operation-wide). */
  addressed_to: z.array(z.string()),
  event_id: z.string().min(1),
  /** False when the idempotency key replayed the original message. */
  created: z.boolean(),
});
export type MessageSendResult = z.infer<typeof MessageSendResultSchema>;

/** The roster command outcome union — applied OR the typed D36 refusal (403). */
export const RosterCommandOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("applied"), operation: OperationRecord }),
  z.strictObject({ outcome: z.literal("refused"), refusal: RosterRefusal }),
]);
export type RosterCommandOutcome = z.infer<typeof RosterCommandOutcomeSchema>;

// ---------------------------------------------------------------------------
// Transport — the shared runtime idiom, plus an outcome-aware variant for the
// roster commands endpoint whose 403 is a PARSED refusal, not a failure.
// ---------------------------------------------------------------------------

function toOperationError(payload: unknown): RuntimeApiError {
  const typed = typedErrorFromPayload(payload);
  return typed instanceof RuntimeApiError ? typed : new RuntimeApiError(typed.sheraError);
}

async function fetchRuntimeResponse(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  try {
    return await fetch(path, { ...init, headers });
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
}

/** The single typed read/write idiom shared with lib/runtime-client.ts. */
async function requestOperation<T>(
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchRuntimeResponse(path, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toOperationError(payload);
  }
  try {
    return parse(payload);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    // A 2xx body that fails its contract is a server drift, not user error.
    throw toOperationError(null);
  }
}

/**
 * The roster commands endpoint answers 200 applied OR 403 refused — both are
 * valid parsed outcomes of the D36 union; only anything ELSE is a failure.
 * A refused command must reach the UI as its refusal (fixed safe copy), never
 * flattened into a generic error.
 */
async function requestRosterOutcome(
  path: string,
  command: Record<string, unknown>,
): Promise<RosterCommandOutcome> {
  const response = await fetchRuntimeResponse(path, {
    method: "POST",
    body: JSON.stringify(command),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok || response.status === 403) {
    const parsed = RosterCommandOutcomeSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data;
    }
  }
  if (!response.ok) {
    throw toOperationError(payload);
  }
  throw toOperationError(null);
}

// ---------------------------------------------------------------------------
// Reads and writes (S13 chunk 4 surface)
// ---------------------------------------------------------------------------

/**
 * S14: the list rows carry the derived ad-hoc fields on top of the record —
 * the sidebar uses them for the Ad-hoc tag and the auto-label styling (D41).
 */
export const OperationListRowSchema = OperationRecord.extend({
  is_adhoc: z.boolean(),
  auto_label: z.boolean(),
});
export type OperationListRow = z.infer<typeof OperationListRowSchema>;

const OperationsListResponse = z.strictObject({
  operations: z.array(OperationListRowSchema),
});

export function fetchOperations(workspaceId: string): Promise<OperationListRow[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestOperation(
    `/api/runtime/v1/operations?${query.toString()}`,
    (payload) => OperationsListResponse.parse(payload).operations,
  );
}

/**
 * Ad-hoc creation input (D29/D41): no reusable definition, full pinning
 * derived. S14: `name` is OPTIONAL — null (or empty once trimmed) lets the
 * server auto-label the Operation `Ad-hoc · N Agents`.
 */
export interface CreateOperationInput {
  name: string | null;
  roster_agent_ids: string[];
  coordinator_agent_id: string;
}

export function createOperation(
  workspaceId: string,
  input: CreateOperationInput,
): Promise<OperationRecordType> {
  return requestOperation(
    "/api/runtime/v1/operations",
    (payload) => OperationRecord.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        definition_ref: null,
        // Null (or trimmed-empty) names the Operation server-side: the
        // `Ad-hoc · N Agents` auto-label (D41).
        name: input.name,
        roster_agent_ids: input.roster_agent_ids,
        coordinator_agent_id: input.coordinator_agent_id,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// S14 — rename (D23 rule 6): the ONE user-owned field write, carried by the
// same contracts command envelope as every other Operation mutation.
// ---------------------------------------------------------------------------

/**
 * The friendly copy for the S14 creation refusal codes. The server's
 * safe_message always wins when present; these are the local fallbacks,
 * phrased like the server's own refusals (no raw internals — G3).
 */
export const CREATE_REFUSAL_COPY: Record<string, string> = {
  OPERATION_ROSTER_EMPTY: "An Operation needs at least one Agent. Select at least one Agent below.",
  OPERATION_NAME_REQUIRED:
    "A pack-defined Operation needs a name. Name this Operation, or create it without a pack definition.",
};

/**
 * The create command's typed failure as ONE safe message: the server's
 * safe_message first (it is the runtime's own copy for its refusals), then
 * the known S14 refusal codes mapped to local friendly copy, then the honest
 * generic fallback. Never raw internals (D23 rule 4, G3).
 */
export function createOperationOutcomeMessage(error: unknown, fallback?: string): string {
  const generic = fallback ?? "The Operation could not be created.";
  if (error instanceof RuntimeApiError) {
    const { code, safe_message } = error.sheraError;
    if (safe_message.length > 0) {
      return safe_message;
    }
    return CREATE_REFUSAL_COPY[code] ?? generic;
  }
  return generic;
}

/**
 * Rename one Operation (D41: ad-hoc Operations are created nameless and
 * renamed by the user afterwards). The envelope is built CLIENT-SIDE and
 * validated through the runtime's own contracts schema — a malformed rename
 * (empty name, >120 chars) throws HERE, never as a 400 on the wire; the
 * server's typed validation failures still surface as RuntimeApiError with
 * their safe copy. The rename is a durable row update (no journaled event —
 * the record has no event stream of its own), idempotent through the command
 * receipt: a replayed envelope answers the record, never a duplicated effect.
 */
export function renameOperation(
  workspaceId: string,
  operationId: string,
  name: string,
): Promise<OperationRecordType> {
  const envelope = OperationRenameCommand.parse({
    ...newOperationCommandIds(),
    workspace_id: workspaceId,
    operation_id: operationId,
    actor: AGENT_SETTINGS_USER_ACTOR,
    type: "operation.rename_operation",
    name,
  });
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/rename`,
    (payload) => OperationRecord.parse(payload),
    {
      method: "POST",
      body: JSON.stringify(envelope),
    },
  );
}

/**
 * The rename mutation's options, built over a QueryClient so the hook's
 * invalidation contract stays testable without a React renderer: a
 * successful rename invalidates BOTH the detail read model (the renamed
 * record) and the workspace list (the row's name/derived fields) — the
 * rendered state is always the runtime's read-after-write truth.
 */
export function renameOperationMutationOptions(
  queryClient: QueryClient,
  workspaceId: string,
  operationId: string,
): {
  mutationFn: (name: string) => Promise<OperationRecordType>;
  onSuccess: (data: OperationRecordType) => void;
} {
  return {
    mutationFn: (name: string) => renameOperation(workspaceId, operationId, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-detail", workspaceId, operationId],
      });
      void queryClient.invalidateQueries({ queryKey: ["operations", workspaceId] });
    },
  };
}

export function fetchOperationDetail(
  workspaceId: string,
  operationId: string,
): Promise<OperationDetail> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}?${query.toString()}`,
    (payload) => OperationDetailSchema.parse(payload),
  );
}

/** The merged D41 thread; `after` is the message-leg journal cursor (exclusive). */
export function fetchOperationThread(
  workspaceId: string,
  operationId: string,
  after = 0,
): Promise<OperationThreadPayload> {
  const query = new URLSearchParams({ workspace_id: workspaceId, after: String(after) });
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/thread?${query.toString()}`,
    (payload) => OperationThreadSchema.parse(payload),
  );
}

export function sendOperationChatMessage(
  workspaceId: string,
  operationId: string,
  input: { text: string; displayName: string; idempotencyKey: string },
): Promise<MessageSendResult> {
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/thread/messages`,
    (payload) => MessageSendResultSchema.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        idempotency_key: input.idempotencyKey,
        sender: { kind: "user", display_name: input.displayName },
        text: input.text,
      }),
    },
  );
}

export function setOperationCoordinator(
  workspaceId: string,
  operationId: string,
  coordinatorAgentId: string,
): Promise<OperationRecordType> {
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/coordinator`,
    (payload) => OperationRecord.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        coordinator_agent_id: OperationCoordinatorRef.parse(coordinatorAgentId),
      }),
    },
  );
}

export function createOperationRun(
  workspaceId: string,
  operationId: string,
): Promise<OperationRunType> {
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/runs`,
    (payload) => OperationRun.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  );
}

/**
 * S22 (PRD §8, AC15): the user's stop control for one run — the idempotent
 * cancel command. Every outcome is a typed 200 (`cancelled` with the
 * teardown evidence + the preserved inventory, `already_cancelled` (a
 * replayed cancel is a no-op, never an error), `already_settled` (the cancel
 * lost the race against completion — deterministic), `actor_refused`,
 * `not_found`); only a transport-level failure throws.
 */
export const RunCancelOutcome = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("cancelled"),
    run_id: z.string(),
    state: z.string(),
    cancelled_child_run_ids: z.array(z.string()),
    cancelled_approval_ids: z.array(z.string()),
    cancelled_execution_ids: z.array(z.string()),
    released_lease_count: z.number(),
    reservation_release_requested: z.boolean(),
    preserved: z.strictObject({
      artifact_ids: z.array(z.string()),
      journal_event_count: z.number(),
    }),
  }),
  z.strictObject({ outcome: z.literal("already_cancelled"), run_id: z.string() }),
  z.strictObject({
    outcome: z.literal("already_settled"),
    run_id: z.string(),
    state: z.string(),
  }),
  z.strictObject({
    outcome: z.literal("actor_refused"),
    run_id: z.string(),
    reason: z.string(),
  }),
  z.strictObject({ outcome: z.literal("not_found"), run_id: z.string() }),
]);
export type RunCancelOutcomeType = z.infer<typeof RunCancelOutcome>;

export function cancelOperationRun(
  workspaceId: string,
  operationId: string,
  runId: string,
  cancelledBy: { type: "user" | "admin"; id: string },
): Promise<RunCancelOutcomeType> {
  return requestOperation(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/runs/${encodeURIComponent(runId)}/cancel`,
    (payload) => RunCancelOutcome.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, cancelled_by: cancelledBy }),
    },
  );
}

/**
 * S22 (AC3): the run's journal events — the TRUE attempt-count source. The
 * task.retry_scheduled envelopes carry the runtime's own attempt numbers;
 * the UI renders THIS number and never a hardcoded count. The payload is the
 * journal verbatim (a full D26 envelope per lifecycle row, the bare record
 * for runtime events); the client parses defensively (a journal row that
 * fails its shape is skipped, never a crash).
 */
export const RunEventReadModel = z.object({
  event_id: z.string(),
  stream_id: z.string(),
  type: z.string(),
  sequence: z.number(),
  occurred_at: z.string(),
  payload: z.unknown(),
});
export type RunEventReadModelType = z.infer<typeof RunEventReadModel>;

export async function listOperationRunEvents(
  workspaceId: string,
  operationId: string,
  runId: string,
): Promise<RunEventReadModelType[]> {
  const response = await fetchRuntimeResponse(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/runs/${encodeURIComponent(runId)}/events?workspace_id=${encodeURIComponent(workspaceId)}`,
    {},
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toOperationError(payload);
  }
  const events = (payload as { events?: unknown })?.events;
  if (!Array.isArray(events)) {
    throw toOperationError(null);
  }
  const parsed: RunEventReadModelType[] = [];
  for (const event of events) {
    const verdict = RunEventReadModel.safeParse(event);
    if (verdict.success) parsed.push(verdict.data);
  }
  return parsed;
}

/** The highest journalled retry attempt of one run (0 when none — honest). */
export function retryAttemptsFromEvents(events: RunEventReadModelType[]): number {
  let max = 0;
  for (const event of events) {
    if (event.type !== "task.retry_scheduled") continue;
    const attempt = (event.payload as { payload?: { attempt?: unknown } } | null)?.payload
      ?.attempt;
    if (typeof attempt === "number" && Number.isInteger(attempt) && attempt > max) {
      max = attempt;
    }
  }
  return max;
}

export function submitOperationRosterCommand(
  workspaceId: string,
  operationId: string,
  command: Record<string, unknown>,
): Promise<RosterCommandOutcome> {
  return requestRosterOutcome(
    `/api/runtime/v1/operations/${encodeURIComponent(operationId)}/roster/commands`,
    command,
  );
}

// ---------------------------------------------------------------------------
// The D36 roster command envelope (built client-side, validated by contracts)
// ---------------------------------------------------------------------------

/** The envelope fields the caller supplies per submit (minted fresh each time). */
export interface OperationCommandEnvelope {
  command_id: string;
  idempotency_key: string;
  workspace_id: string;
  operation_id: string;
  issued_at: string;
}

/** Fresh envelope ids: each submit is its own idempotency unit (D23 rule 6). */
export function newOperationCommandIds(): {
  command_id: string;
  idempotency_key: string;
  issued_at: string;
} {
  return {
    command_id: `cmd_${globalThis.crypto.randomUUID()}`,
    idempotency_key: `idem_${globalThis.crypto.randomUUID()}`,
    issued_at: new Date().toISOString(),
  };
}

/**
 * The per-draft message idempotency key. One draft → one key: a retry of the
 * SAME send reuses the key (never a duplicated turn), and a new draft mints a
 * fresh one. Length ≥ 8 satisfies the local API's idempotency_key floor.
 */
export function newMessageDraftKey(): string {
  return `idem_msg_${globalThis.crypto.randomUUID()}`;
}

/** A semantic roster action minus the envelope the builder fills in. */
export type OperationRosterAction =
  | {
      type: "operation.add_roster_agent";
      agent_id: string;
      pack_id: string;
      pack_version: string;
      risk: RosterRiskClassification;
    }
  | { type: "operation.remove_roster_agent"; agent_id: string };

/**
 * Build one contracts-valid roster command: the action plus the envelope and
 * the user actor. Parsed through the runtime's own union, so an invalid
 * action (say, a foreign-pack add or a cost increase without approval) throws
 * HERE — never a malformed POST.
 */
export function buildOperationRosterCommand(
  action: OperationRosterAction,
  envelope: OperationCommandEnvelope,
): Record<string, unknown> {
  const parsed =
    action.type === "operation.add_roster_agent"
      ? AddRosterAgentCommand.parse({ ...action, ...envelope, actor: AGENT_SETTINGS_USER_ACTOR })
      : RemoveRosterAgentCommand.parse({
          ...action,
          ...envelope,
          actor: AGENT_SETTINGS_USER_ACTOR,
        });
  return parsed;
}

/**
 * The client-side D36 classification for an add command. The web app's
 * candidates come from the workspace's seeded Agent roster (GET /v1/agents),
 * which is exactly the pinned pack's membership — so same_pack is a true
 * claim. Per-Agent cost metadata arrives with the provider/credits slices;
 * until then the UI claims no cost increase and NEVER silently proceeds: every
 * add passes the explicit confirm step (D36) and refusals render verbatim.
 */
export function samePackAddRisk(): RosterRiskClassification {
  return { same_pack: true, cost_or_access_increasing: false, requires_approval: false };
}

// ---------------------------------------------------------------------------
// Pure UI helpers (thread addressing, D7 cards, roster candidates)
// ---------------------------------------------------------------------------

/**
 * The candidates for the add affordance: the workspace's seeded Agents minus
 * the current roster members. Same-pack by construction (the workspace roster
 * IS the pinned pack's seeded membership); the add command still carries the
 * Operation's pinned pack and the runtime re-verifies everything (D36).
 */
export function candidateAgentsForOperation<T extends { agent_id: string }>(
  identities: T[],
  rosterAgentIds: string[],
): T[] {
  const roster = new Set(rosterAgentIds);
  return identities.filter((identity) => !roster.has(identity.agent_id));
}

/**
 * D7 event type labels — the human card title per category. All 11 D7
 * categories, verbatim keys; the card renders label + payload summary + sender.
 */
export const OPERATION_EVENT_LABELS: Record<OperationCollaborationEventType["type"], string> = {
  TaskProposed: "Task proposed",
  TaskAccepted: "Task accepted",
  TaskDelegated: "Task delegated",
  ProgressReported: "Progress reported",
  ArtifactPublished: "Artifact published",
  ApprovalRequested: "Approval requested",
  QuestionRaised: "Question raised",
  TaskBlocked: "Task blocked",
  TaskFailed: "Task failed",
  TaskCompleted: "Task completed",
  HandoffRequested: "Handoff requested",
};

/** The card's payload summary: the natural-language payload field, else the ref. */
export function collaborationEventSummary(event: OperationCollaborationEventType): string {
  switch (event.type) {
    case "TaskProposed":
    case "TaskDelegated":
      return event.payload.task_description;
    case "TaskAccepted":
      return event.payload.proposal_event_id;
    case "ProgressReported":
      return event.payload.progress_text;
    case "ArtifactPublished":
      return event.payload.artifact_ref;
    case "ApprovalRequested":
      return event.payload.approval_request_ref;
    case "QuestionRaised":
      return event.payload.question_text;
    case "TaskBlocked":
      return event.payload.blocked_reason;
    case "TaskFailed":
      return event.payload.failure_class;
    case "TaskCompleted":
      return event.payload.completion_summary;
    case "HandoffRequested":
      return event.payload.handoff_reason;
  }
}
