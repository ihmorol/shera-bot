import { z } from "zod";

import { Id } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * Typed browser client for the S28 schedules & watchers surface (issue #29;
 * PRD §8, E5, AC9, AC10, G2, G3), through the same-origin runtime proxy
 * exactly like every other client (lib/runtime-client.ts).
 *
 * Truthfulness shape (AC9): every read returns the runtime scheduler's OWN
 * record — state, pause reason, last firing, next occurrence, recent
 * firings. This client computes nothing and falls back to nothing (G4): an
 * absent scheduler is an error state, never a fixture. The webhook secret,
 * when a create form offers one, crosses exactly once (accepted in the
 * create body; the stored view carries only its digest — G3).
 */

const FiringView = z.strictObject({
  idempotency_key: z.string().min(1),
  run_id: z.string().nullable(),
  outcome: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).nullable(),
  fired_at: z.string().min(1),
});
export type TriggerFiringView = z.infer<typeof FiringView>;

export const TRIGGER_KINDS = [
  "schedule",
  "file_watch",
  "git_watch",
  "webhook",
  "task_completion",
  "condition",
  "external_event",
] as const;

export const TriggerViewSchema = z.strictObject({
  trigger_id: Id,
  name: z.string().min(1).max(200),
  kind: z.enum(TRIGGER_KINDS),
  target_operation_id: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  catch_up_policy: z.enum(["catch_up", "skip"]),
  state: z.enum(["active", "paused"]),
  pause_reason: z.string().nullable(),
  last_fired_at: z.string().nullable(),
  last_occurrence_at: z.string().nullable(),
  next_occurrence_at: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  recent_firings: z.array(FiringView),
});
export type TriggerView = z.infer<typeof TriggerViewSchema>;

const ListResponse = z.strictObject({ triggers: z.array(TriggerViewSchema) });
const CreateResponse = z.strictObject({
  trigger_id: Id,
  next_occurrence_at: z.string().nullable(),
});
const EditResponse = z.strictObject({ next_occurrence_at: z.string().nullable() });
const MutateResponse = z.strictObject({ trigger_id: Id, state: z.enum(["active", "paused"]) });

export async function fetchTriggers(workspaceId: string): Promise<TriggerView[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/schedules?${query.toString()}`,
    (payload) => ListResponse.parse(payload).triggers,
  );
}

export interface CreateTriggerInput {
  workspace_id: string;
  kind: TriggerView["kind"];
  name: string;
  target_operation_id: string;
  config: Record<string, unknown>;
  catch_up_policy: "catch_up" | "skip";
}

export async function createTrigger(
  input: CreateTriggerInput,
): Promise<{ trigger_id: string; next_occurrence_at: string | null }> {
  return requestRuntime("/api/runtime/v1/schedules", (payload) => CreateResponse.parse(payload), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface EditTriggerBody {
  name?: string;
  config?: Record<string, unknown>;
  catch_up_policy?: "catch_up" | "skip";
}

export async function editTrigger(
  workspaceId: string,
  triggerId: string,
  body: EditTriggerBody,
): Promise<{ next_occurrence_at: string | null }> {
  return requestRuntime(
    `/api/runtime/v1/schedules/${triggerId}/edit`,
    (payload) => EditResponse.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, ...body, actor: TRIGGER_ACTOR }),
    },
  ).then((parsed) => parsed as { next_occurrence_at: string | null });
}

/** The acting principal the browser asserts for trigger mutations — the
 * session user, rebuilt server-side (the S20 decision convention: the
 * browser never asserts an identity beyond naming the actor shape). */
const TRIGGER_ACTOR = { type: "user", id: "session-user" } as const;

export async function pauseTrigger(
  workspaceId: string,
  triggerId: string,
): Promise<{ trigger_id: string; state: "active" | "paused" }> {
  return requestRuntime(
    `/api/runtime/v1/schedules/${triggerId}/pause`,
    (payload) => MutateResponse.parse(payload),
    { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, actor: TRIGGER_ACTOR }) },
  ).then((parsed) => ({ trigger_id: parsed.trigger_id, state: parsed.state }));
}

export async function resumeTrigger(
  workspaceId: string,
  triggerId: string,
): Promise<{ trigger_id: string; state: "active" | "paused" }> {
  return requestRuntime(
    `/api/runtime/v1/schedules/${triggerId}/resume`,
    (payload) => MutateResponse.parse(payload),
    { method: "POST", body: JSON.stringify({ workspace_id: workspaceId, actor: TRIGGER_ACTOR }) },
  ).then((parsed) => ({ trigger_id: parsed.trigger_id, state: parsed.state }));
}

export async function fetchFirings(
  workspaceId: string,
  triggerId: string,
): Promise<TriggerFiringView[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/schedules/${triggerId}/firings?${query.toString()}`,
    (payload) => z.array(FiringView).parse(payload),
  );
}
