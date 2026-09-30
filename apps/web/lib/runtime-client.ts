import { z } from "zod";

import { TypedHttpError, UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the container's local API (S09 chunk 1), reached
 * through the same-origin proxy (/api/runtime/* → RUNTIME_LOCAL_API_URL,
 * strict two-path allowlist). This is the REAL conversation backing: the
 * General Assistant direct chat reads and writes real container-local SQLite
 * rows through exactly the two S07 surfaces —
 *
 *   POST /v1/conversations/commands            (D26: commands are the only
 *                                               mutation path, idempotent by
 *                                               idempotency_key, D23 rule 6)
 *   GET  /v1/conversations/:id/events?workspace_id=&last_acknowledged_sequence=
 *                                              (cursor replay, AC4)
 *
 * There is no conversation-list endpoint in this slice, so the direct chat
 * resolves its conversation with a FIXED idempotency seed key: the first call
 * creates the conversation row; every later call replays the recorded receipt
 * upstream and returns the SAME conversation_id. That is the S07 receipt
 * contract doing its job, not a client-side cache.
 *
 * Chunk-1 boundary (honest): this client reads journal events and creates the
 * conversation; message sends and the live socket stream are chunk 2/3. The
 * fixture layer (lib/fixtures) remains the demo state for a not-ready
 * container, as shipped in S08.
 *
 * Failures are the S07 SheraError bodies through the shared typed-error
 * parser; the local API is unauthenticated in this prototype slice (recorded
 * S07 posture — the authenticated transport is a later chunk).
 */

export class RuntimeApiError extends TypedHttpError {
  constructor(sheraError: TypedHttpError["sheraError"]) {
    super(sheraError);
    this.name = "RuntimeApiError";
  }
}

function toRuntimeError(payload: unknown): RuntimeApiError {
  const typed = typedErrorFromPayload(payload);
  return typed instanceof RuntimeApiError ? typed : new RuntimeApiError(typed.sheraError);
}

/**
 * The General Assistant direct chat's idempotency seed key. Fixed per chat
 * identity (D39: one direct conversation per Agent) so re-entry never creates
 * a second conversation — the receipt replay returns the same row. Bump the
 * key only with a recorded decision; bumping re-seeds a NEW conversation.
 */
export const GA_DIRECT_CHAT_SEED_KEY = "s09-ga-direct-chat-seed-v1";

/** The real conversation title mirrors the pack Agent identity. */
export const GA_DIRECT_CHAT_TITLE = "General Assistant";

/** Loose event envelope: the mapper consumes type + time (+ renamed title). */
const RuntimeEventEnvelope = z.strictObject({
  event_id: z.string(),
  stream_id: z.string(),
  sequence: z.number().int().min(0),
  type: z.string(),
  schema_version: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
  workspace_id: z.string(),
  occurred_at: z.string(),
  correlation_id: z.string(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventEnvelope>;

const ConversationCommandResult = z.strictObject({
  kind: z.enum(["created", "renamed"]),
  conversation_id: z.string(),
  title: z.string(),
  revision: z.number().int().positive(),
  event_id: z.string(),
});
export type ConversationCommandResult = z.infer<typeof ConversationCommandResult>;

const ReplayEventsResult = z.strictObject({
  kind: z.literal("events"),
  stream_id: z.string(),
  workspace_id: z.string(),
  events: z.array(RuntimeEventEnvelope),
  next_cursor: z.number().int().min(0),
  replayed: z.literal(true),
});

const ReplaySnapshotResult = z.strictObject({
  kind: z.literal("snapshot_required"),
  stream_id: z.string(),
  workspace_id: z.string(),
  reason: z.enum(["cursor_below_retention_horizon", "unknown_stream"]),
  earliest_available_sequence: z.number().int().min(0),
  next_cursor: z.number().int().min(0),
  replayed: z.literal(false),
});

const ReplayResult = z.discriminatedUnion("kind", [ReplayEventsResult, ReplaySnapshotResult]);

async function requestRuntime<T>(
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toRuntimeError(payload);
  }
  try {
    return parse(payload);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    // A 2xx body that fails its contract is a server drift, not user error.
    throw toRuntimeError(null);
  }
}

/**
 * Resolve (or on first ever use, create) the General Assistant direct chat's
 * REAL conversation row. Idempotent upstream: the same workspace + seed key
 * replays the recorded receipt, so the same conversation_id returns every
 * time.
 */
export function ensureGaConversation(workspaceId: string): Promise<ConversationCommandResult> {
  return requestRuntime(
    "/api/runtime/v1/conversations/commands",
    (payload) => ConversationCommandResult.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        type: "conversation.create",
        workspace_id: workspaceId,
        idempotency_key: GA_DIRECT_CHAT_SEED_KEY,
        payload: { title: GA_DIRECT_CHAT_TITLE },
      }),
    },
  );
}

/**
 * Read a conversation's journal back from cursor 0 (full replay; the live
 * socket and cursor acknowledgement are chunk 2/3). The result is the S07
 * ReplayService union verbatim — a snapshot fallback surfaces as its own
 * honest kind, never as fabricated history.
 */
export function fetchConversationEvents(
  conversationId: string,
  workspaceId: string,
  lastAcknowledgedSequence = 0,
): Promise<z.infer<typeof ReplayResult>> {
  const query = new URLSearchParams({
    workspace_id: workspaceId,
    last_acknowledged_sequence: String(lastAcknowledgedSequence),
  });
  return requestRuntime(
    `/api/runtime/v1/conversations/${encodeURIComponent(conversationId)}/events?${query.toString()}`,
    (payload) => ReplayResult.parse(payload),
  );
}
