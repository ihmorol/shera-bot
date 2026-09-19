/**
 * MemoryEntry (S02 #10, D37): one shared user/workspace memory and one private
 * memory per Agent, with explicit scopes and an explicit publication step.
 * Agent-private memory does not leak into Operation context without
 * publication (PRD criterion 27). Secrets are rejected at the runtime boundary
 * (S29); this schema records the shape and the provenance contract.
 */
import { z } from "zod";

import { Id, IsoDateTime, WorkspaceId } from "./primitives.ts";

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
