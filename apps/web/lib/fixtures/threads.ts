import type { ArtifactRef, TaskRun, TypedExecutionEvent } from "@shera-bot/contracts";

import { artifactsForTask } from "./artifacts";
import { FIXTURE_EVENTS } from "./events";
import { messagesForConversation, type ChatMessage } from "./messages";
import { RUNS } from "./runs";

/**
 * MOCK DATA — thread assembly for the chat view. Messages, typed events, and
 * run fixtures merge into one ordered item list; §6.2 replayed batches are
 * grouped and closed with the batch-boundary marker ("N missed events
 * replayed"), never silently interleaved as live.
 */
export type ThreadItem =
  | { kind: "message"; at: string; message: ChatMessage }
  | {
      kind: "tool_card";
      at: string;
      event: TypedExecutionEvent;
      /** G2: fixture proposals are pending a runtime decision, never "executed". */
      status: "proposed" | "pausing_for_approval";
    }
  | { kind: "artifact"; at: string; artifact: ArtifactRef }
  | { kind: "run"; at: string; run: TaskRun }
  | { kind: "system"; at: string; text: string }
  | { kind: "replay_boundary"; at: string; count: number };

const KIND_RANK: Record<ThreadItem["kind"], number> = {
  message: 0,
  tool_card: 1,
  run: 2,
  artifact: 3,
  system: 4,
  replay_boundary: 5,
};

/** Single ordering definition for thread items (time, then kind rank). */
export function compareThreadItems(a: ThreadItem, b: ThreadItem): number {
  return a.at.localeCompare(b.at) || KIND_RANK[a.kind] - KIND_RANK[b.kind];
}

function sortItems(items: ThreadItem[]): ThreadItem[] {
  return items.sort(compareThreadItems);
}

/**
 * Build the seeded thread for a conversation. Card items derive strictly from
 * typed fixtures (events, runs, artifact refs); nothing here fabricates a
 * runtime result.
 */
export function buildThread(conversationId: string): ThreadItem[] {
  const items: ThreadItem[] = [];

  for (const message of messagesForConversation(conversationId)) {
    items.push({ kind: "message", at: message.sent_at, message });
  }

  for (const event of FIXTURE_EVENTS) {
    if (event.conversation_id !== conversationId) {
      continue;
    }
    const at = event.occurred_at;
    if (event.event_type === "tool.proposed") {
      items.push({ kind: "tool_card", at, event, status: "proposed" });
    } else if (event.event_type === "approval.requested") {
      items.push({ kind: "tool_card", at, event, status: "pausing_for_approval" });
    } else if (event.event_type === "artifact.published") {
      const artifact = artifactsForTask(event.task_id).find(
        (candidate) => candidate.artifact_id === event.payload.artifact_id,
      );
      if (artifact) {
        items.push({ kind: "artifact", at, artifact });
      }
    }
    // progress.reported and lifecycle events render with the streaming and
    // run-timeline work (§6.1 / run timeline), not as thread cards here.
  }

  for (const run of RUNS) {
    if (run.conversation_id === conversationId) {
      items.push({ kind: "run", at: run.created_at, run });
    }
  }

  return withReplayBoundaries(sortItems(items));
}

/**
 * §6.2: after each contiguous batch of replayed messages, insert the batch
 * boundary ("N missed events replayed") at the seam where live delivery
 * resumes. Live items never render inside the batch.
 */
function withReplayBoundaries(sorted: ThreadItem[]): ThreadItem[] {
  const result: ThreadItem[] = [];
  let replayedCount = 0;
  const flushBoundary = () => {
    if (replayedCount === 0) {
      return;
    }
    const last = result[result.length - 1];
    result.push({
      kind: "replay_boundary",
      at: last?.at ?? "",
      count: replayedCount,
    });
    replayedCount = 0;
  };
  for (const item of sorted) {
    const isReplayed = item.kind === "message" && item.message.delivery_class === "replayed";
    if (isReplayed) {
      replayedCount += 1;
      result.push(item);
      continue;
    }
    flushBoundary();
    result.push(item);
  }
  flushBoundary();
  return result;
}
