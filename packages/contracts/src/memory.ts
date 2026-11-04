/**
 * MemoryEntry (S02 #10, D37): one shared user/workspace memory and one private
 * memory per Agent, with explicit scopes and an explicit publication step.
 * Agent-private memory does not leak into Operation context without
 * publication (PRD criterion 27). Secrets are rejected at the runtime boundary
 * (S29); this schema records the shape and the provenance contract.
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, WorkspaceId } from "./primitives.ts";

/** D37 scopes. */
export const MEMORY_SCOPES = [
  "account",
  "workspace",
  "operation",
  "task",
  "agent_private",
] as const;
export const MemoryScope = z.enum(MEMORY_SCOPES);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryEntry = z.strictObject({
  memory_id: Id,
  workspace_id: WorkspaceId,
  scope: MemoryScope,
  /** Owner Agent for agent_private memories; null for shared scopes. */
  owner_agent_id: Id.nullable(),
  operation_id: Id.nullable(),
  task_id: Id.nullable(),
  summary: z.string().min(1).max(500),
  content: z.string().min(1).max(20000),
  /** Sensitive memories require user approval before publication (D37). */
  sensitivity: z.enum(["normal", "sensitive"]),
  /**
   * The explicit publication flag (D37): private memories are published into
   * Operation context only through this recorded step.
   */
  publication: z.strictObject({
    published: z.boolean(),
    published_into_operation_id: Id.nullable(),
    published_at: IsoDateTime.nullable(),
  }),
  /** Provenance is preserved (D37); refs point to conversations, tasks, files. */
  source_refs: z.array(z.string().min(1).max(256)).max(100),
  confidence: z.number().min(0).max(1),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  expires_at: IsoDateTime.nullable(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/**
 * S29 (issue #30; D37, G2/G6): the typed user commands the memory surface
 * accepts. One commands envelope, one discriminated union — the runtime
 * validates every command against its schema (G2) and every acting actor is
 * bound SERVER-SIDE by the proxy's session binding (the browser client sends
 * no actor of its own choosing; the S20/S23/S28 convention).
 *
 * The command union grows with the user controls (edit/restore/forget/auto
 * toggles ride the same envelope); publication is its own decision command —
 * the D37 explicit publication step (AC27) is a USER action, never an
 * agent-side write.
 */
export const MemoryCommand = z.discriminatedUnion("type", [
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.create"),
    scope: MemoryScope,
    /** Owner Agent for agent_private memories; required exactly there. */
    owner_agent_id: Id.nullable(),
    operation_id: Id.nullable(),
    task_id: Id.nullable(),
    summary: z.string().min(1).max(500),
    content: z.string().min(1).max(20000),
    sensitivity: z.enum(["normal", "sensitive"]),
    /** D37: source references are preserved — provenance is never optional. */
    source_refs: z.array(z.string().min(1).max(256)).max(100),
    confidence: z.number().min(0).max(1),
    expires_at: IsoDateTime.nullable(),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.publish_decision"),
    memory_id: Id,
    /** The Operation the entry is published into (or withdrawn from). */
    operation_id: Id,
    decision: z.enum(["approve", "dismiss"]),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.request_publication"),
    memory_id: Id,
    /** The Operation the publication is requested into. */
    operation_id: Id,
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.edit"),
    memory_id: Id,
    summary: z.string().min(1).max(500),
    content: z.string().min(1).max(20000),
    sensitivity: z.enum(["normal", "sensitive"]),
    source_refs: z.array(z.string().min(1).max(256)).max(100),
    confidence: z.number().min(0).max(1),
    expires_at: IsoDateTime.nullable(),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.restore"),
    memory_id: Id,
    /** The version to restore (the history row is never rewritten). */
    version: z.number().int().min(1),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.forget"),
    memory_id: Id,
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.set_auto_memory"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("memory.set_agent_auto_memory"),
    agent_id: Id,
    enabled: z.boolean(),
  }),
]);
export type MemoryCommand = z.infer<typeof MemoryCommand>;
export type MemoryCreateCommand = Extract<MemoryCommand, { type: "memory.create" }>;
export type MemoryPublishDecisionCommand = Extract<
  MemoryCommand,
  { type: "memory.publish_decision" }
>;
export type MemoryRequestPublicationCommand = Extract<
  MemoryCommand,
  { type: "memory.request_publication" }
>;
