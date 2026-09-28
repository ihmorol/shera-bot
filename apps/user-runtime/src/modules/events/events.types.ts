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
