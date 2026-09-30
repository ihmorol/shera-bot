import type { Agent, Operation, OperationDefinition } from "@shera-bot/contracts";

import type { ConversationState, ConversationSummary } from "./conversations";
import {
  CONVERSATIONS,
  OPERATION_INSTANCES,
  conversationForAgent,
  rosterSubtitle,
} from "./conversations";
import { RUNS, attentionVariantFor, sidebarStateFor } from "./runs";
import { STUDENT_PACK } from "./pack";

/**
 * MOCK DATA barrel — everything the UI consumes from the fixture layer, with
 * the sidebar model assembled from honest derived states (runs + unread).
 * Import UI data from here, never from the individual fixture modules.
 */
export { STUDENT_PACK, agentById, operationDefinitionById, toolInfoById } from "./pack";
export {
  CONVERSATIONS,
  ConversationState,
  ConversationSummary,
  OPERATION_INSTANCES,
  conversationById,
  conversationForAgent,
  operationInstanceById,
  rosterSubtitle,
} from "./conversations";
export { RUNS, sidebarStateFor, sessionPresenceFor } from "./runs";
export {
  EVENT_GA_WEB_SEARCH,
  EVENT_TUTOR_APPROVAL,
  FIXTURE_EVENTS,
  ingestEvents,
  sortBySequence,
} from "./events";
export { FIXTURE_ARTIFACTS, artifactsForTask } from "./artifacts";
export { MESSAGES, messagesForConversation, ChatMessage } from "./messages";
export { buildThread, compareThreadItems, type ThreadItem } from "./threads";
export { DEMO_STREAM, FixtureStream, splitStreamChunks } from "./streaming";

/** Presence type for S3 headers and sidebar avatars (D32 on-demand sessions). */
export type SessionPresence = "active" | "hibernating";

/**
 * Route slug for a fixture entity id ("operation_research_paper" →
 * "research-paper", "agent_general_assistant" → "general-assistant"),
 * matching the chunk-1 navigation seed. The fixtures test asserts the
 * derived slugs resolve to the navigation-seeded routes.
 */
export function entitySlug(entityId: string): string {
  return entityId.replace(/^(agent|operation)_/, "").replace(/_/g, "-");
}

/**
 * §2.1 status-palette refinement for the failed sidebar state: red is kept
 * for genuinely FAILED runs ("error"); PAUSED/RECOVERY_REQUIRED are
 * attention/review-requested states and render amber ("review") — a pause
 * is never an error.
 */
export type AttentionVariant = "error" | "review" | undefined;

export interface SidebarAgentEntry {
  agent: Agent;
  conversation: ConversationSummary;
  state: ConversationState;
  /** Runs waiting on an approval decision (drives the amber badge count). */
  approvalCount: number;
  /** Why the failed state fired — picks red vs amber per §2.1. */
  attention: AttentionVariant;
}

export interface SidebarOperationEntry {
  operation: Operation;
  conversation: ConversationSummary;
  subtitle: string;
  state: ConversationState;
  approvalCount: number;
  attention: AttentionVariant;
}

export interface SidebarTemplateEntry {
  definition: OperationDefinition;
}

export interface SidebarModel {
  agents: SidebarAgentEntry[];
  templates: SidebarTemplateEntry[];
  operationChats: SidebarOperationEntry[];
}

/**
 * The §3.2 sidebar model: the six pack Agents as persistent direct chats
 * (AC3), the pack-defined Operation templates (launch → preview, D30), and
 * the active Operation chats group. States derive from run fixtures —
 * approval_required means a run is WAITING_FOR_APPROVAL (a pause for a
 * decision), never a granted state (G2).
 */
export function sidebarModel(): SidebarModel {
  const approvalCount = (conversationId: string) =>
    RUNS.filter(
      (run) => run.conversation_id === conversationId && run.state === "WAITING_FOR_APPROVAL",
    ).length;

  const agents = STUDENT_PACK.agents.map((agent) => {
    const conversation = conversationForAgent(agent.agent_id);
    if (!conversation) {
      throw new Error(`fixture missing direct chat for ${agent.agent_id}`);
    }
    return {
      agent,
      conversation,
      state: sidebarStateFor(conversation.conversation_id, conversation.unread_count),
      approvalCount: approvalCount(conversation.conversation_id),
      attention: attentionVariantFor(conversation.conversation_id),
    };
  });

  const operationChats = OPERATION_INSTANCES.map((operation) => {
    const conversation = CONVERSATIONS.find(
      (candidate) => candidate.conversation_id === operation.conversation_id,
    );
    if (!conversation) {
      throw new Error(`fixture missing chat for ${operation.operation_id}`);
    }
    return {
      operation,
      conversation,
      subtitle: rosterSubtitle(operation),
      state: sidebarStateFor(conversation.conversation_id, conversation.unread_count),
      approvalCount: approvalCount(conversation.conversation_id),
      attention: attentionVariantFor(conversation.conversation_id),
    };
  });

  return {
    agents,
    templates: STUDENT_PACK.operations.map((definition) => ({ definition })),
    operationChats,
  };
}
