import type { TypedExecutionEvent } from "@shera-bot/contracts";

/**
 * MOCK DATA — §6.2 fixture events. The envelopes are the real
 * `TypedExecutionEvent` contracts (D26: eleven strict fields; duplicates are
 * ignored by `event_id`). `ingestEvents` is the UI-side ingestion path: it is
 * the dedupe + ordering seam the real runtime stream will plug into later.
 */

/** D26: duplicate `event_id`s are ignored — first occurrence wins (D23 rule 6 keeps keys data). */
export function ingestEvents(
  knownEventIds: ReadonlySet<string>,
  incoming: readonly TypedExecutionEvent[],
): { accepted: TypedExecutionEvent[]; duplicateCount: number } {
  const seen = new Set(knownEventIds);
  const accepted: TypedExecutionEvent[] = [];
  let duplicateCount = 0;
  for (const event of incoming) {
    if (seen.has(event.event_id)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(event.event_id);
    accepted.push(event);
  }
  return { accepted, duplicateCount };
}

/** D26 streams are per-task; sequence is 1-based and gapless per stream. */
export function sortBySequence(events: readonly TypedExecutionEvent[]): TypedExecutionEvent[] {
  return [...events].sort(
    (a, b) => a.stream_id.localeCompare(b.stream_id) || a.sequence - b.sequence,
  );
}

const BASE = {
  event_version: 1,
  redaction_class: "public",
} as const;

/** The General Assistant proposed a read-only web search (D35: runs automatically once validated). */
export const EVENT_GA_WEB_SEARCH: TypedExecutionEvent = {
  ...BASE,
  event_id: "event_ga_web_search_1",
  stream_id: "task:task_run_ga_summary",
  sequence: 1,
  event_type: "tool.proposed",
  actor: { type: "agent", id: "agent_general_assistant" },
  task_id: "task_run_ga_summary",
  conversation_id: "conversation_agent_general_assistant",
  occurred_at: "2026-09-20T10:13:00Z",
  payload: {
    tool_id: "tool_web_search",
    tool_version: "1.4.0",
    args_digest: `sha256:${"a".repeat(64)}`,
    proposal_summary:
      "Search for recent (2024–2026) peer-reviewed papers on spaced-repetition study methods to extend the methods section.",
  },
};

/** The Programming Tutor hit an external write — the run pauses for approval (D9/D35). */
export const EVENT_TUTOR_APPROVAL: TypedExecutionEvent = {
  ...BASE,
  event_id: "event_tutor_approval_1",
  stream_id: "task:task_run_tutor_backup",
  sequence: 2,
  event_type: "approval.requested",
  actor: { type: "agent", id: "agent_programming_tutor" },
  task_id: "task_run_tutor_backup",
  conversation_id: "conversation_agent_programming_tutor",
  occurred_at: "2026-09-20T13:58:00Z",
  payload: {
    tool_id: "tool_repo_push",
    tool_version: "0.9.2",
    capability: "repository.push",
    risk_class: "EXTERNAL_WRITE",
    args_digest: `sha256:${"b".repeat(64)}`,
    resource_scope: "workspace://repo/assignment-2 branch: solution",
  },
};

/** The bibliography run published an artifact (§9: SUCCEEDED with artifacts). */
export const EVENT_RP_ARTIFACT: TypedExecutionEvent = {
  ...BASE,
  event_id: "event_rp_artifact_1",
  stream_id: "task:task_run_rp_bibliography",
  sequence: 3,
  event_type: "artifact.published",
  actor: { type: "agent", id: "agent_citation_manager" },
  task_id: "task_run_rp_bibliography",
  conversation_id: "conversation_op_research_paper",
  occurred_at: "2026-09-18T09:40:00Z",
  payload: {
    artifact_id: "artifact_bibliography_draft",
    uri: "workspace://research-paper/bibliography-draft.md",
    size_bytes: 18432,
  },
};

/** Streaming progress on the outline run (§6.1). */
export const EVENT_RP_PROGRESS: TypedExecutionEvent = {
  ...BASE,
  event_id: "event_rp_progress_1",
  stream_id: "task:task_run_rp_outline",
  sequence: 1,
  event_type: "progress.reported",
  actor: { type: "agent", id: "agent_researcher" },
  task_id: "task_run_rp_outline",
  conversation_id: "conversation_op_research_paper",
  occurred_at: "2026-09-20T15:38:00Z",
  payload: {
    agent_id: "agent_researcher",
    summary: "Outline drafted: 6 sections, 2 pending source checks.",
    fraction: 0.4,
  },
};

/** A SUCCEEDED run in the Researcher chat published a source digest artifact. */
export const EVENT_RES_DIGEST_ARTIFACT: TypedExecutionEvent = {
  ...BASE,
  event_id: "event_res_digest_1",
  stream_id: "task:task_run_res_digest",
  sequence: 1,
  event_type: "artifact.published",
  actor: { type: "agent", id: "agent_researcher" },
  task_id: "task_run_res_digest",
  conversation_id: "conversation_agent_researcher",
  occurred_at: "2026-09-20T09:45:00Z",
  payload: {
    artifact_id: "artifact_sources_digest",
    uri: "workspace://research/sources-digest.md",
    size_bytes: 9216,
  },
};

/** Fixture events in arrival order. */
export const FIXTURE_EVENTS: TypedExecutionEvent[] = [
  EVENT_RP_ARTIFACT,
  EVENT_GA_WEB_SEARCH,
  EVENT_TUTOR_APPROVAL,
  EVENT_RP_PROGRESS,
  EVENT_RES_DIGEST_ARTIFACT,
];
