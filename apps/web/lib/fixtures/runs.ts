import { TaskRun, type RunState } from "@shera-bot/contracts";

import type { ConversationState } from "./conversations";
import { conversationIdForAgent } from "./conversations";
import { STUDENT_PACK } from "./pack";

/**
 * MOCK DATA — §9 #3 run fixtures. Coverage required by §9: RUNNING (with
 * streaming), WAITING_FOR_APPROVAL (external-write example), RETRYING (2 of 3
 * attempts), SUCCEEDED with artifacts, FAILED, PAUSED, RECOVERY_REQUIRED.
 * Typed with the real `TaskRun` contract; the D8 state vocabulary comes from
 * the contract, never invented here.
 */
const A = conversationIdForAgent;

const PACK_SNAPSHOT = {
  pack_id: STUDENT_PACK.pack_id,
  pack_version: STUDENT_PACK.version,
  pack_hash: STUDENT_PACK.manifest_hash,
};

const STUDENT_PACK_OPERATION_HASH = STUDENT_PACK.operations[0]?.content_hash ?? "";

export const RUNS: TaskRun[] = [
  TaskRun.parse({
    task_id: "task_run_ga_summary",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_general_assistant"),
    created_from: {
      trigger_event_type: "tool.proposed",
      trigger_event_id: "event_ga_web_search_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_general_assistant"],
    provider_snapshot: { provider_id: "provider_platform", model: "platform-default" },
    state: "RUNNING",
    version: 3,
    retry_count: 0,
    created_at: "2026-09-20T10:13:00Z",
    updated_at: "2026-09-20T10:15:30Z",
  }),
  TaskRun.parse({
    // §9: the external-write example pauses for approval (D30 ladder; the
    // approval dialog itself lands with the S8 slice — this card is a
    // waiting-state indicator, never a granted state, G2).
    task_id: "task_run_tutor_backup",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_programming_tutor"),
    created_from: {
      trigger_event_type: "approval.requested",
      trigger_event_id: "event_tutor_approval_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_programming_tutor"],
    provider_snapshot: { provider_id: "provider_platform", model: "platform-default" },
    state: "WAITING_FOR_APPROVAL",
    version: 5,
    retry_count: 0,
    created_at: "2026-09-20T13:55:00Z",
    updated_at: "2026-09-20T14:02:00Z",
  }),
  // §9 #2: the pack-defined Operation chat carries three runs in different states.
  TaskRun.parse({
    task_id: "task_run_rp_outline",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_research_paper",
    operation_id: "operation_chat_research_paper",
    created_from: {
      trigger_event_type: "operation.confirmed",
      trigger_event_id: "event_rp_confirm_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    operation_snapshot: {
      operation_id: "operation_research_paper",
      version: "1.0.0",
      hash: STUDENT_PACK_OPERATION_HASH,
    },
    roster: ["agent_general_assistant", "agent_researcher", "agent_citation_manager"],
    provider_snapshot: { provider_id: "provider_platform", model: "platform-default" },
    state: "RUNNING",
    version: 4,
    retry_count: 0,
    created_at: "2026-09-20T15:32:00Z",
    updated_at: "2026-09-20T15:40:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_rp_sources",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_research_paper",
    operation_id: "operation_chat_research_paper",
    created_from: {
      trigger_event_type: "operation.confirmed",
      trigger_event_id: "event_rp_confirm_2",
    },
    pack_snapshot: PACK_SNAPSHOT,
    operation_snapshot: {
      operation_id: "operation_research_paper",
      version: "1.0.0",
      hash: STUDENT_PACK_OPERATION_HASH,
    },
    roster: ["agent_general_assistant", "agent_researcher"],
    state: "RETRYING",
    version: 6,
    retry_count: 2,
    created_at: "2026-09-19T10:00:00Z",
    updated_at: "2026-09-19T10:26:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_rp_bibliography",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_research_paper",
    operation_id: "operation_chat_research_paper",
    created_from: {
      trigger_event_type: "operation.confirmed",
      trigger_event_id: "event_rp_confirm_3",
    },
    pack_snapshot: PACK_SNAPSHOT,
    operation_snapshot: {
      operation_id: "operation_research_paper",
      version: "1.0.0",
      hash: STUDENT_PACK_OPERATION_HASH,
    },
    roster: ["agent_general_assistant", "agent_citation_manager"],
    state: "SUCCEEDED",
    version: 7,
    retry_count: 0,
    created_at: "2026-09-18T09:00:00Z",
    updated_at: "2026-09-18T09:41:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_adhoc_glossary",
    workspace_id: "workspace_demo",
    conversation_id: "conversation_op_adhoc_terms",
    operation_id: "operation_chat_adhoc_terms",
    created_from: {
      trigger_event_type: "delegation.proposed",
      trigger_event_id: "event_adhoc_delegation_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_researcher", "agent_developer"],
    state: "FAILED",
    version: 4,
    retry_count: 3,
    created_at: "2026-09-20T11:05:00Z",
    updated_at: "2026-09-20T11:47:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_planner_schedule",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_study_planner"),
    created_from: {
      trigger_event_type: "trigger.scheduled",
      trigger_event_id: "event_planner_schedule_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_study_planner"],
    state: "PAUSED",
    version: 3,
    retry_count: 0,
    pause_reason: "insufficient_credits",
    created_at: "2026-09-19T18:00:00Z",
    updated_at: "2026-09-19T18:12:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_dev_recover",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_developer"),
    created_from: {
      trigger_event_type: "tool.proposed",
      trigger_event_id: "event_dev_tool_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_developer"],
    state: "RECOVERY_REQUIRED",
    version: 5,
    retry_count: 1,
    created_at: "2026-09-19T14:00:00Z",
    updated_at: "2026-09-19T14:20:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_res_digest",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_researcher"),
    created_from: {
      trigger_event_type: "tool.proposed",
      trigger_event_id: "event_res_digest_trigger",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_researcher"],
    state: "SUCCEEDED",
    version: 2,
    retry_count: 0,
    created_at: "2026-09-20T09:30:00Z",
    updated_at: "2026-09-20T09:45:00Z",
  }),
  TaskRun.parse({
    task_id: "task_run_cm_style_check",
    workspace_id: "workspace_demo",
    conversation_id: A("agent_citation_manager"),
    created_from: {
      trigger_event_type: "tool.proposed",
      trigger_event_id: "event_cm_tool_1",
    },
    pack_snapshot: PACK_SNAPSHOT,
    roster: ["agent_citation_manager"],
    state: "SUCCEEDED",
    version: 2,
    retry_count: 0,
    created_at: "2026-09-17T09:00:00Z",
    updated_at: "2026-09-17T09:06:00Z",
  }),
];

/**
 * Sidebar state derivation (PRD §4.1 five states). Active (non-terminal)
 * runs drive attention states honestly; PAUSED and RECOVERY_REQUIRED both
 * need the user, so they surface under the failed dot. Unread is a
 * conversation property, not a run property — it wins only when no run is
 * in an attention state.
 */
export function sidebarStateFor(
  conversationId: string,
  unreadCount: number,
  runs: readonly TaskRun[] = RUNS,
): ConversationState {
  const conversationRuns = runs.filter((run) => run.conversation_id === conversationId);

  if (conversationRuns.some((run) => run.state === "WAITING_FOR_APPROVAL")) {
    return "approval_required";
  }
  const activeStates: ReadonlySet<RunState> = new Set([
    "RUNNING",
    "RETRYING",
    "WAITING_FOR_AGENT",
    "WAITING_FOR_RESOURCE",
    "CANCELLING",
    "CREATED",
    "PLANNED",
    "QUEUED",
  ]);
  if (conversationRuns.some((run) => activeStates.has(run.state))) {
    return "running";
  }
  const attentionStates: ReadonlySet<RunState> = new Set(["FAILED", "PAUSED", "RECOVERY_REQUIRED"]);
  if (conversationRuns.some((run) => attentionStates.has(run.state))) {
    return "failed";
  }
  if (unreadCount > 0) {
    return "unread";
  }
  return "quiet";
}

/**
 * Presence for the S3 header and sidebar avatars (D32 on-demand sessions): a
 * session counts as active only while work is actually executing. A run
 * paused for approval, credits, or recovery is not executing — the session
 * hibernates and the pause shows up as its own state marker instead (G2:
 * nothing renders an agent action as done, and a pause is never shown as
 * progress).
 */
const EXECUTING_STATES: ReadonlySet<RunState> = new Set([
  "RUNNING",
  "RETRYING",
  "WAITING_FOR_AGENT",
  "WAITING_FOR_RESOURCE",
  "CANCELLING",
]);

export function sessionPresenceFor(
  conversationId: string,
  runs: readonly TaskRun[] = RUNS,
): "active" | "hibernating" {
  const executing = runs.some(
    (run) => run.conversation_id === conversationId && EXECUTING_STATES.has(run.state),
  );
  return executing ? "active" : "hibernating";
}
