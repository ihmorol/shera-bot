import { CollaborationMessage } from "@shera-bot/contracts";

/**
 * MOCK DATA — D7 agent-to-agent collaboration fixtures.
 *
 * These are real `CollaborationMessage` contracts (D7 requires every field; ids
 * are data, never deduplicated by text). They stand in for the Operation
 * traffic the runtime will emit, so the thread can show who is working with whom
 * rather than only talking to the user.
 *
 * G2 note: every entry is a *typed proposal or report*, never a completed
 * action. `TaskDelegated` with `status: "proposed"` means the runtime has
 * validated nothing yet — the UI must not present it as finished work.
 */

const BASE = {
  // Matches every other fixture's workspace (runs.ts, artifacts.ts,
  // conversations.ts all use "workspace_demo").
  workspace_id: "workspace_demo",
  parent_task_id: null,
  artifact_refs: [],
  required_capabilities: [],
  confidence: null,
  unresolved_questions: [],
} as const;

/**
 * Research Paper Operation traffic.
 *
 * Conversation and task ids are REAL seeded ids, joinable to the existing
 * conversation/run fixtures. An earlier version of this file invented
 * `conversation_research_paper` and `task_run_research_paper`, which match no
 * seeded record — so `collaborationForConversation` filtered on an id nothing
 * produced and the entire surface rendered nowhere while every test stayed green.
 * `fixtures.test.ts` now asserts these ids resolve, so that cannot recur.
 *
 * Placement note: `conversation_agent_general_assistant` and
 * `conversation_agent_researcher` are the Agent direct chats, which
 * `app/app/agent/[agentId]/page.tsx` renders today. The Operation chat
 * (`conversation_op_research_paper`) is still an `EmptyState` placeholder in
 * this slice, so a message attached there is wired but not yet on screen.
 */
export const COLLABORATION_MESSAGES: CollaborationMessage[] = [
  CollaborationMessage.parse({
    ...BASE,
    task_id: "task_run_rp_sources",
    conversation_id: "conversation_agent_general_assistant",
    sender_agent: "agent_general_assistant",
    recipient_agent: "agent_researcher",
    message_type: "TaskDelegated",
    goal_or_summary:
      "Find five peer-reviewed sources from 2024 onward on spaced repetition, and extract the claim each one supports.",
    risk_class: "READ_ONLY",
    status: "proposed",
    created_at: "2026-09-19T10:02:00Z",
    idempotency_key: "collab_research_delegated_1",
  }),
  CollaborationMessage.parse({
    ...BASE,
    task_id: "task_run_rp_bibliography",
    conversation_id: "conversation_op_research_paper",
    sender_agent: "agent_researcher",
    recipient_agent: "agent_citation_manager",
    message_type: "TaskProposed",
    goal_or_summary:
      "Index the five collected sources and flag any that duplicate an entry already in the bibliography.",
    risk_class: "READ_ONLY",
    status: "proposed",
    created_at: "2026-09-20T10:26:00Z",
    idempotency_key: "collab_citation_proposed_1",
  }),
  CollaborationMessage.parse({
    ...BASE,
    task_id: "task_run_rp_sources",
    conversation_id: "conversation_agent_researcher",
    sender_agent: "agent_researcher",
    recipient_agent: "agent_general_assistant",
    message_type: "QuestionRaised",
    goal_or_summary:
      "Two candidate sources disagree on effect size. I need a decision before drafting the methods section.",
    risk_class: "READ_ONLY",
    status: "proposed",
    unresolved_questions: [
      "Which effect size should the methods section report?",
      "Should the weaker study be cited as a counterexample or dropped?",
    ],
    created_at: "2026-09-20T10:41:00Z",
    idempotency_key: "collab_research_question_1",
  }),
];

export function collaborationForConversation(conversationId: string): CollaborationMessage[] {
  return COLLABORATION_MESSAGES.filter((message) => message.conversation_id === conversationId);
}
