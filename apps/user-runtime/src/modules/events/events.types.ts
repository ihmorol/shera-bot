/**
 * Event module domain types (S07; D23 module shape).
 *
 * The event journal is append-only. Payloads are Zod-validated at the append
 * boundary (the gateway validates what it persists — G2); stored payloads are
 * immutable JSON. Schema versions are explicit per event type so later
 * slices evolve payloads without rewriting history.
 */
import { z } from "zod";

import {
  EVENT_ENVELOPES as CONTRACT_EVENT_ENVELOPES,
  type EventType as ContractEventType,
} from "@shera-bot/contracts";

/** Streams: the aggregate instance an event belongs to (per-stream sequences). */
export const ConversationStreamPrefix = "conversation" as const;

export const ConversationCreatedPayload = z.strictObject({
  conversation_id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string().min(1).max(300),
});
export type ConversationCreatedPayload = z.infer<typeof ConversationCreatedPayload>;

export const ConversationRenamedPayload = z.strictObject({
  conversation_id: z.string().min(1),
  workspace_id: z.string().min(1),
  title: z.string().min(1).max(300),
  previous_revision: z.number().int().positive(),
  new_revision: z.number().int().positive(),
});
export type ConversationRenamedPayload = z.infer<typeof ConversationRenamedPayload>;

/**
 * Who authored a conversation message (S09). The local API is the container's
 * trusted loopback surface in this slice — the principal-to-sender binding
 * arrives with the authenticated transport (same posture as workspace_id,
 * recorded S07/S09).
 */
export const MessageSender = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), display_name: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("agent"), agent_id: z.string().min(1).max(200) }),
]);
export type MessageSender = z.infer<typeof MessageSender>;

/** One durable conversation message (S09 chunk 2; the stream IS the history). */
export const MessageAppendedPayload = z.strictObject({
  conversation_id: z.string().min(1),
  workspace_id: z.string().min(1),
  /** Stable identity of the message for UI reconciliation (D26). */
  message_id: z.string().min(1),
  sender: MessageSender,
  text: z.string().min(1).max(4000),
});
export type MessageAppendedPayload = z.infer<typeof MessageAppendedPayload>;

/**
 * Agent session supervision events (S12; D32 layer 2, D14). Journaled on
 * `session:<workspace_id>:<agent_id>` streams: on-demand starts (with the
 * measured start latency), crashes, supervised restarts, protocol failures,
 * idle hibernations, and the terminal failed state. G3: payloads carry the
 * typed error code and a BOUNDED detail string — never secrets and never raw
 * child stderr dumps (stderr goes to the supervisor's redacted, bounded sink).
 */
export const SessionCrashCause = z.enum(["unexpected_exit", "fatal_frame", "hang"]);
export type SessionCrashCause = z.infer<typeof SessionCrashCause>;

export const SessionRestartReason = z.enum(["crash", "hang", "protocol_violation", "idle_resume"]);
export type SessionRestartReason = z.infer<typeof SessionRestartReason>;

export const SessionFailedReason = z.enum(["restart_limit", "protocol_violation_limit"]);
export type SessionFailedReason = z.infer<typeof SessionFailedReason>;

export const SessionStartedPayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  /**
   * Measured on-demand start latency (ms) — from the address that began the
   * start attempt (context fetch + spawn + handshake) to the child's ready.
   * A duration integer; carries no child internals (G3).
   */
  start_latency_ms: z.number().int().nonnegative(),
});
export type SessionStartedPayload = z.infer<typeof SessionStartedPayload>;

export const SessionHibernatePayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  /** How long the session had been idle when it hibernated. */
  idle_ms: z.number().int().nonnegative(),
});
export type SessionHibernatePayload = z.infer<typeof SessionHibernatePayload>;

export const SessionCrashedPayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  cause: SessionCrashCause,
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type SessionCrashedPayload = z.infer<typeof SessionCrashedPayload>;

export const SessionRestartedPayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  reason: SessionRestartReason,
  /** The child incarnation this restart replaced, when there was one. */
  previous_session_id: z.string().nullable(),
});
export type SessionRestartedPayload = z.infer<typeof SessionRestartedPayload>;

export const SessionProtocolFailurePayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  /** The typed PiProtocolError code (e.g. PROTOCOL_VIOLATION). */
  code: z.string().min(1),
  /** The violation reason for ProtocolViolationError; null otherwise. */
  reason: z.string().nullable(),
  /** Bounded typed detail (max 200 chars); never raw child output. */
  detail: z.string().max(200).nullable(),
});
export type SessionProtocolFailurePayload = z.infer<typeof SessionProtocolFailurePayload>;

export const SessionFailedPayload = z.strictObject({
  session_id: z.string().min(1),
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1),
  reason: SessionFailedReason,
});
export type SessionFailedPayload = z.infer<typeof SessionFailedPayload>;

/**
 * Task worker supervision events (S16 chunk 1; D32 layer 3, D33, D10).
 * Journaled on the RUN's stream (stream_id = the run_id — the S13 run-stream
 * semantics: run-scoped history carries one gapless per-run cursor). Progress
 * and checkpoints are persisted HERE and on the task_workers row — never only
 * in the worker process's memory (D10), so a recovery slice can reconstruct
 * the run from durable state alone. G3: payloads carry bounded typed fields —
 * never secrets, never raw child stderr dumps (stderr goes to the
 * supervisor's redacted, bounded sink).
 */
export const WorkerCrashCause = z.enum([
  "unexpected_exit",
  "hang",
  "protocol_violation",
  "worker_error",
  "handshake_timeout",
]);
export type WorkerCrashCause = z.infer<typeof WorkerCrashCause>;

export const WorkerStopReason = z.enum(["requested", "shutdown"]);
export type WorkerStopReason = z.infer<typeof WorkerStopReason>;

export const WorkerStartedPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  /** The child process id observed on the hello handshake. */
  pid: z.number().int().positive(),
  /** Measured spawn→ready latency (ms); carries no child internals (G3). */
  start_latency_ms: z.number().int().nonnegative(),
});
export type WorkerStartedPayload = z.infer<typeof WorkerStartedPayload>;

export const WorkerProgressPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  percent: z.number().int().min(0).max(100),
  text: z.string().max(500),
});
export type WorkerProgressPayload = z.infer<typeof WorkerProgressPayload>;

/** The opaque D33 checkpoint payload is persisted verbatim (runtime-owned JSON). */
export const WorkerCheckpointPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  checkpoint: z.record(z.string(), z.unknown()),
});
export type WorkerCheckpointPayload = z.infer<typeof WorkerCheckpointPayload>;

export const WorkerCrashedPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  cause: WorkerCrashCause,
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  /** The worker-reported failure class for worker_error; null otherwise. */
  error_class: z.string().max(100).nullable(),
  /** The last persisted progress percent when one was seen; null otherwise. */
  last_percent: z.number().int().min(0).max(100).nullable(),
});
export type WorkerCrashedPayload = z.infer<typeof WorkerCrashedPayload>;

export const WorkerCompletedPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  summary: z.string().max(2_000),
});
export type WorkerCompletedPayload = z.infer<typeof WorkerCompletedPayload>;

export const WorkerStoppedPayload = z.strictObject({
  worker_id: z.string().min(1),
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  reason: WorkerStopReason,
});
export type WorkerStoppedPayload = z.infer<typeof WorkerStoppedPayload>;

/**
 * The D26 task-execution vocabulary (S07; D51 seam) journaled on `task:<id>`
 * streams. The journal row stores the FULL contract envelope as its payload —
 * the envelope IS the durable D26 event — so each registry entry validates the
 * whole envelope. WHERE VALIDATION ACTUALLY HAPPENS (G2): at APPEND
 * (events.service validates every payload against its registry entry) and at
 * PROJECTION REBUILD (conversations.projection.ts re-validates every payload
 * it folds). replay.service does NOT re-validate payloads today — it trusts
 * rows the append boundary already validated. The embedded per-stream
 * sequence equals the row's sequence: the writer allocates it first, then
 * builds the envelope with it.
 */
const TASK_EVENT_REGISTRY = Object.fromEntries(
  (Object.keys(CONTRACT_EVENT_ENVELOPES) as ContractEventType[]).map((type) => [
    type,
    { schema_version: 1, payload: CONTRACT_EVENT_ENVELOPES[type] },
  ]),
) as {
  [T in ContractEventType]: {
    schema_version: number;
    payload: (typeof CONTRACT_EVENT_ENVELOPES)[T];
  };
};

export const EVENT_TYPES = {
  "conversation.created": { schema_version: 1, payload: ConversationCreatedPayload },
  "conversation.renamed": { schema_version: 1, payload: ConversationRenamedPayload },
  "message.appended": { schema_version: 1, payload: MessageAppendedPayload },
  "session.started": { schema_version: 1, payload: SessionStartedPayload },
  "session.hibernate": { schema_version: 1, payload: SessionHibernatePayload },
  "session.crashed": { schema_version: 1, payload: SessionCrashedPayload },
  "session.restarted": { schema_version: 1, payload: SessionRestartedPayload },
  "session.protocol_failure": { schema_version: 1, payload: SessionProtocolFailurePayload },
  "session.failed": { schema_version: 1, payload: SessionFailedPayload },
  "worker.started": { schema_version: 1, payload: WorkerStartedPayload },
  "worker.progress": { schema_version: 1, payload: WorkerProgressPayload },
  "worker.checkpoint": { schema_version: 1, payload: WorkerCheckpointPayload },
  "worker.crashed": { schema_version: 1, payload: WorkerCrashedPayload },
  "worker.completed": { schema_version: 1, payload: WorkerCompletedPayload },
  "worker.stopped": { schema_version: 1, payload: WorkerStoppedPayload },
  ...TASK_EVENT_REGISTRY,
} as const;

export type EventType = keyof typeof EVENT_TYPES;

export type EventPayloadOf<T extends EventType> = z.infer<(typeof EVENT_TYPES)[T]["payload"]>;

/** The persisted envelope — mirrors the event_journal row one-to-one. */
export interface EventEnvelope<T extends EventType = EventType> {
  event_id: string;
  stream_id: string;
  sequence: number;
  type: T;
  schema_version: number;
  payload: EventPayloadOf<T>;
  workspace_id: string;
  occurred_at: string;
  correlation_id: string;
}

/** Input for appending an event; sequence is allocated by the service, never supplied. */
export interface AppendEventInput<T extends EventType = EventType> {
  event_id: string;
  stream_id: string;
  type: T;
  payload: EventPayloadOf<T>;
  workspace_id: string;
  correlation_id: string;
}
