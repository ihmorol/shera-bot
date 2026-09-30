import { DEFAULT_COORDINATOR_SENTINEL, Operation } from "@shera-bot/contracts";
import { z } from "zod";

import { STUDENT_PACK } from "./pack";

/**
 * MOCK DATA — §9 #2 conversation fixtures: one seeded direct chat per Agent
 * plus two Operation chats (one pack-defined, one ad-hoc). Conversation
 * summaries are a UI-level shape (the S02 contracts define Operation
 * instances and events, not list rows); the Operation instances below parse
 * against the real `Operation` contract. Sidebar states are derived from the
 * seeded run fixtures — see runs.ts (`sidebarStateFor`).
 */

/**
 * Sidebar item state per PRD §4.1 / §3.2. Color is never the only signal —
 * the sidebar pairs every state dot with a count badge, icon, or label.
 * Values: unread (count pill), running (live dot), approval_required
 * (amber dot + count), failed (red dot), quiet (no marker).
 */
export const CONVERSATION_STATES = [
  "unread",
  "running",
  "approval_required",
  "failed",
  "quiet",
] as const;
export const ConversationState = z.enum(CONVERSATION_STATES);
export type ConversationState = z.infer<typeof ConversationState>;

export const ConversationSummary = z.strictObject({
  conversation_id: z.string(),
  kind: z.enum(["agent_direct", "operation"]),
  agent_id: z.string().optional(),
  operation_id: z.string().optional(),
  title: z.string(),
  /** Subtitle for Operation chats, e.g. "Ad-hoc · 2 Agents" (§3.2). */
  subtitle: z.string().optional(),
  /** Current unread count; 0 when everything is read. */
  unread_count: z.number().int().min(0),
  last_activity_at: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/** The two Operation chat instances (§9 #2; D31/D41 shape, contract-typed). */
export const OPERATION_INSTANCES: Operation[] = [
  Operation.parse({
    operation_id: "operation_chat_research_paper",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_research_paper",
    definition: {
      operation_id: "operation_research_paper",
      version: "1.0.0",
      hash: STUDENT_PACK.operations[0]?.content_hash ?? "",
    },
    title: "Research Paper",
    roster: ["agent_researcher", "agent_citation_manager"],
    coordinator: DEFAULT_COORDINATOR_SENTINEL,
    status: "active",
    created_at: "2026-09-18T08:30:00Z",
    updated_at: "2026-09-20T15:40:00Z",
  }),
  Operation.parse({
    operation_id: "operation_chat_adhoc_terms",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_adhoc_terms",
    definition: null,
    title: "Ad-hoc",
    roster: ["agent_researcher", "agent_developer"],
    coordinator: DEFAULT_COORDINATOR_SENTINEL,
    status: "active",
    created_at: "2026-09-20T11:00:00Z",
    updated_at: "2026-09-20T16:05:00Z",
  }),
];

export function conversationIdForAgent(agentId: string): string {
  return `conversation_agent_${agentId.replace("agent_", "")}`;
}

/** Per §9 #2: one seeded direct chat per Agent, plus the two Operation chats. */
export const CONVERSATIONS: ConversationSummary[] = [
  ...STUDENT_PACK.agents.map(
    (agent): ConversationSummary => ({
      conversation_id: conversationIdForAgent(agent.agent_id),
      kind: "agent_direct",
      agent_id: agent.agent_id,
      title: agent.display_name,
      unread_count: UNREAD_COUNTS[agent.agent_id] ?? 0,
      last_activity_at: LAST_ACTIVITY[agent.agent_id] ?? "2026-09-19T12:00:00Z",
    }),
  ),
  {
    conversation_id: "conversation_op_research_paper",
    kind: "operation",
    operation_id: "operation_chat_research_paper",
    title: "Research Paper",
    subtitle: "Pack-defined · 2 Agents",
    unread_count: 0,
    last_activity_at: "2026-09-20T15:40:00Z",
  },
  {
    conversation_id: "conversation_op_adhoc_terms",
    kind: "operation",
    operation_id: "operation_chat_adhoc_terms",
    title: "Ad-hoc",
    subtitle: "Ad-hoc · 2 Agents",
    unread_count: 0,
    last_activity_at: "2026-09-20T16:05:00Z",
  },
];

const UNREAD_COUNTS: Record<string, number> = {
  agent_general_assistant: 2,
  agent_researcher: 1,
};

const LAST_ACTIVITY: Record<string, string> = {
  agent_general_assistant: "2026-09-20T10:16:00Z",
  agent_researcher: "2026-09-20T09:48:00Z",
  agent_programming_tutor: "2026-09-20T14:02:00Z",
};

export function conversationById(conversationId: string): ConversationSummary | undefined {
  return CONVERSATIONS.find((conversation) => conversation.conversation_id === conversationId);
}

export function conversationForAgent(agentId: string): ConversationSummary | undefined {
  return CONVERSATIONS.find(
    (conversation) => conversation.kind === "agent_direct" && conversation.agent_id === agentId,
  );
}

export function operationInstanceById(operationId: string): Operation | undefined {
  return OPERATION_INSTANCES.find((operation) => operation.operation_id === operationId);
}

/** Ad-hoc subtitle per §3.2: "Ad-hoc · N Agents" until the user names it. */
export function rosterSubtitle(operation: Operation): string {
  if (!operation.definition) {
    return `Ad-hoc · ${operation.roster.length} Agents`;
  }
  return `Pack-defined · ${operation.roster.length} Agents`;
}
