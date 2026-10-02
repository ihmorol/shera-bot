import { ArrowRight, CircleHelp, Handshake, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { CollaborationMessage, CollaborationMessageType } from "@shera-bot/contracts";

import { agentById } from "@/lib/fixtures";
import { cn } from "@/lib/utils";

/**
 * Agent-to-agent communication surface (D7 `CollaborationMessage`, G2).
 *
 * The typed collaboration protocol has been in the contracts since S02 and had
 * **no UI surface at all**. In a product whose premise is Agents collaborating in
 * Operations, the user could see Agents talking to *them* but never saw Agents
 * talking to *each other* — the delegation, the question, the blocker, and the
 * handoff were all invisible.
 *
 * Invariants this module holds (each pinned by `test/collaboration-surface`):
 *
 * - **Typed, never inferred (G2/D7).** The label comes from the closed
 *   `COLLABORATION_MESSAGE_TYPES` enum. `goal_or_summary` is explanatory payload
 *   only and is NEVER parsed to decide what a message means — D7 says so
 *   explicitly, and this is the single most important rule on this surface.
 * - **Proposals are not executions (G2/G4).** A `proposed` message renders as
 *   pending. Rendering it as finished work would be a fake-completion bug.
 * - **Data, not prose, for identity.** Sender/recipient are Agent ids resolved
 *   against the pack; an unknown id degrades to the raw id rather than crashing.
 */

/** Human labels for the closed D7 enum, keyed exhaustively by its type. */
export const COLLABORATION_LABELS: Record<CollaborationMessageType, string> = {
  TaskProposed: "Proposed a task",
  TaskAccepted: "Accepted the task",
  TaskDelegated: "Delegated work",
  ProgressReported: "Reported progress",
  ArtifactPublished: "Published an artifact",
  ApprovalRequested: "Requested approval",
  QuestionRaised: "Asked a question",
  TaskBlocked: "Reported a blocker",
  TaskFailed: "Reported a failure",
  TaskCompleted: "Completed the task",
  HandoffRequested: "Requested a handoff",
};

/**
 * Status copy for a collaboration message. `proposed` deliberately reads
 * "Proposed" and never "Completed": the runtime has validated nothing yet.
 */
export const COLLABORATION_STATUS_LABELS = {
  proposed: "Proposed",
  accepted: "Accepted",
  declined: "Declined",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
} as const satisfies Record<CollaborationMessage["status"], string>;

/** Structural view of a message for rendering and for tests. */
export interface CollaborationDescription {
  kind: "delegation" | "broadcast";
  from: string;
  to: string | null;
  label: string;
  status: CollaborationMessage["status"];
}

/**
 * Describe a typed collaboration message. Pure — no rendering, no side effects.
 *
 * A null `recipient_agent` is D7's "Operation broadcast", not a malformed record.
 */
export function describeCollaboration(
  message: Pick<
    CollaborationMessage,
    "sender_agent" | "recipient_agent" | "message_type" | "status"
  >,
): CollaborationDescription {
  return {
    kind: message.recipient_agent ? "delegation" : "broadcast",
    from: message.sender_agent,
    to: message.recipient_agent,
    label: COLLABORATION_LABELS[message.message_type],
    status: message.status,
  };
}

/** Display name for an Agent id, degrading to the raw id when unknown. */
function agentName(agentId: string): string {
  return agentById(agentId)?.display_name ?? agentId;
}

/** Icon per message type — a shape cue so the row is not distinguished by text alone. */
function iconFor(type: CollaborationMessageType): ReactNode {
  const props = { className: "size-3.5 shrink-0", "aria-hidden": true } as const;
  switch (type) {
    case "QuestionRaised":
      return <CircleHelp {...props} />;
    case "TaskBlocked":
    case "TaskFailed":
      return <TriangleAlert {...props} />;
    case "HandoffRequested":
    case "TaskDelegated":
      return <Handshake {...props} />;
    default:
      return <ArrowRight {...props} />;
  }
}

/** Token classes per status — §2.1: never color-alone, always paired with the label. */
function statusClass(status: CollaborationMessage["status"]): string {
  switch (status) {
    case "completed":
      return "text-live";
    case "failed":
      return "text-failed";
    case "declined":
      return "text-approval";
    default:
      return "text-muted";
  }
}

/**
 * Render one agent-to-agent message as a compact handoff row.
 *
 * Accessibility (§2.3): the row is NOT `aria-hidden` — it carries the only
 * account of who is talking to whom, so it must be announced. The sender and
 * recipient names appear as text, and the status is a word as well as a color.
 */
export function renderCollaborationSummary({
  message,
}: {
  message: CollaborationMessage;
}): ReactNode {
  const described = describeCollaboration(message);
  const fromName = agentName(described.from);
  const toName = described.to ? agentName(described.to) : null;

  return (
    <div
      data-collaboration-message=""
      data-message-type={message.message_type}
      data-status={message.status}
      className="my-1 flex w-full max-w-xl flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="text-muted">{iconFor(message.message_type)}</span>
        <span className="font-medium text-text">{fromName}</span>
        {toName ? (
          <>
            <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden="true" />
            <span className="truncate font-medium text-text">{toName}</span>
          </>
        ) : (
          // D7: a null recipient is an Operation broadcast, not a broken record.
          <span className="text-muted">broadcast to the Operation</span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.08em]",
            statusClass(message.status),
          )}
        >
          {COLLABORATION_STATUS_LABELS[message.status]}
        </span>
      </div>
      <p className="text-[13px] text-muted">
        <span className="text-text">{described.label}.</span> {message.goal_or_summary}
      </p>
      {message.unresolved_questions.length > 0 ? (
        // An open question is what a user most needs to see: a subordinate run
        // must raise a question rather than invent an answer (G2).
        <ul className="list-inside list-disc text-[12px] text-approval">
          {message.unresolved_questions.map((question) => (
            <li key={question}>{question}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
