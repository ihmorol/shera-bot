import { z } from "zod";

import { Id } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * Typed browser client for the S29 memory surface (issue #30; PRD §11, D37,
 * AC27, G3/G6), through the same-origin runtime proxy exactly like every
 * other client (lib/runtime-client.ts).
 *
 * Truthfulness shape (D37/AC27): every read returns the runtime's OWN memory
 * record — the per-scope breakdown, the publication queue, the auto-memory
 * settings, the version histories. This client computes nothing and falls
 * back to nothing (G4): an absent memory surface is an error state, never a
 * fixture. Secrets are never stored by the runtime (the write-time scan), so
 * nothing here can render one (G3).
 */

export const MEMORY_SCOPES = [
  "account",
  "workspace",
  "operation",
  "task",
  "agent_private",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

const VersionView = z.strictObject({
  version: z.number().int().min(1),
  summary: z.string(),
  content: z.string(),
  sensitivity: z.enum(["normal", "sensitive"]),
  source_refs: z.array(z.string()),
  confidence: z.number(),
  change_kind: z.enum(["created", "edited", "published", "restored", "auto_updated"]),
  changed_by: z.string(),
  created_at: z.string(),
});
export type MemoryVersionView = z.infer<typeof VersionView>;

export const MemoryEntryViewSchema = z.strictObject({
  memory_id: Id,
  workspace_id: z.string(),
  scope: z.enum(MEMORY_SCOPES),
  owner_agent_id: z.string().nullable(),
  operation_id: z.string().nullable(),
  task_id: z.string().nullable(),
  summary: z.string(),
  content: z.string(),
  sensitivity: z.enum(["normal", "sensitive"]),
  publication: z.strictObject({
    published: z.boolean(),
    published_into_operation_id: z.string().nullable(),
    published_at: z.string().nullable(),
  }),
  origin: z.enum(["user", "automatic"]),
  created_by: z.string(),
  source_refs: z.array(z.string()),
  confidence: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
  versions: z.array(VersionView),
});
export type MemoryEntryView = z.infer<typeof MemoryEntryViewSchema>;

const PublicationRequestView = z.strictObject({
  request_id: z.string(),
  memory_id: z.string(),
  operation_id: z.string(),
  requested_by: z.string(),
  status: z.enum(["pending", "approved", "dismissed"]),
  created_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
});
export type MemoryPublicationRequestView = z.infer<typeof PublicationRequestView>;

export const MemoryUserViewSchema = z.strictObject({
  workspace_id: z.string(),
  scopes: z.record(z.enum(MEMORY_SCOPES), z.array(MemoryEntryViewSchema)),
  publication_queue: z.array(PublicationRequestView),
  auto_memory: z.strictObject({
    global_enabled: z.boolean(),
    agents: z.array(z.strictObject({ agent_id: z.string(), enabled: z.boolean() })),
  }),
});
export type MemoryUserView = z.infer<typeof MemoryUserViewSchema>;

const UserViewResponse = MemoryUserViewSchema;

/** The acting principal the browser asserts for memory commands — the
 * session user, rebuilt server-side (the S20 decision convention: the
 * browser never asserts an identity beyond naming the actor shape). */
export const MEMORY_ACTOR = { type: "user", id: "session-user" } as const;

export async function fetchMemoryView(workspaceId: string): Promise<MemoryUserView> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(`/api/runtime/v1/memory?${query.toString()}`, (payload) =>
    UserViewResponse.parse(payload),
  );
}

export type MemoryCommandBody = Record<string, unknown> & { type: string };

/** The edit payload: the entry's fields; the command type and id ride from the hook. */
export interface MemoryEditBody {
  summary: string;
  content: string;
  sensitivity: "normal" | "sensitive";
  source_refs: string[];
  confidence: number;
  expires_at: string | null;
}

export async function submitMemoryCommand(
  workspaceId: string,
  body: MemoryCommandBody,
): Promise<unknown> {
  return requestRuntime("/api/runtime/v1/memory/commands", (payload) => payload, {
    method: "POST",
    body: JSON.stringify({ workspace_id: workspaceId, actor: MEMORY_ACTOR, ...body }),
  });
}

export function memoryScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case "account":
      return "Account";
    case "workspace":
      return "Workspace";
    case "operation":
      return "Operation";
    case "task":
      return "Task";
    case "agent_private":
      return "Agent-private";
  }
}
