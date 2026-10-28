import { Send } from "lucide-react";
import type { ReactNode } from "react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import {
  agentIdentityFromSummary,
  collaborationEventSummary,
  OPERATION_EVENT_LABELS,
  type OperationThreadItem,
} from "@/lib/operation-api";
import { cn } from "@/lib/utils";

/**
 * Operation thread (UI_DESIGN §S4, D41/D7): the merged read model — user and
 * Agent messages with sender attribution and the visible addressing chip
 * ("To Researcher:", resolved via roster names; unaddressed renders nothing),
 * and the D7 collaboration events as attributable typed cards. TaskProposed
 * renders as a display-only proposal card: approval flows arrive in S20, so
 * the card ships no approval control rather than faking one (G2/G4).
 *
 * The composer's @-mention affordance is deliberately light (§S4): typing "@"
 * shows the roster names; picking one inserts the AGENT id token the backend
 * resolves against the roster at send time — the display name is only the
 * label, the id is the addressing.
 */

/** The sender byline verb per D7 category ("«name» proposed"). */
const EVENT_VERBS: Record<keyof typeof OPERATION_EVENT_LABELS, string> = {
  TaskProposed: "proposed",
  TaskAccepted: "accepted",
  TaskDelegated: "delegated",
  ProgressReported: "reported",
  ArtifactPublished: "published",
  ApprovalRequested: "requested approval",
  QuestionRaised: "raised a question",
  TaskBlocked: "blocked a task",
  TaskFailed: "reported a failure",
  TaskCompleted: "completed a task",
  HandoffRequested: "requested a handoff",
};

/** "To Researcher:" — ids resolved via the roster; unresolved ids stay raw. */
export function addressingLabel(addressedTo: string[], identities: AgentRosterSummary[]): string {
  const names = addressedTo.map(
    (agentId) =>
      identities.find((identity) => identity.agent_id === agentId)?.display_name ?? agentId,
  );
  return `To ${names.join(", ")}:`;
}

function AddressingChip({
  addressedTo,
  identities,
}: {
  addressedTo: string[];
  identities: AgentRosterSummary[];
}) {
  if (addressedTo.length === 0) {
    // Operation-wide: no addressing chip at all (D7 empty = broadcast).
    return null;
  }
  return (
    <span
      data-testid="addressing-chip"
      className="inline-flex max-w-full items-center rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[11px] text-muted"
    >
      <span className="truncate">{addressingLabel(addressedTo, identities)}</span>
    </span>
  );
}

function CollaborationEventCard({
  item,
  identities,
}: {
  item: Extract<OperationThreadItem, { kind: "collaboration_event" }>;
  identities: AgentRosterSummary[];
}) {
  const { event } = item;
  const isProposal = event.type === "TaskProposed";
  const senderName =
    item.sender.display_name ??
    identities.find((identity) => identity.agent_id === item.sender.agent_id)?.display_name ??
    item.sender.agent_id;
  return (
    <article
      data-testid="collaboration-event-card"
      data-collaboration-type={event.type}
      data-proposal={isProposal ? "true" : undefined}
      className={cn(
        "rounded-xl border bg-surface p-3",
        // Proposal styling: the approval accent marks the D7 proposal for what
        // it is — display-only until the S20 approval flows arrive.
        isProposal ? "border-approval" : "border-line",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-text">
          {senderName} {EVENT_VERBS[event.type]}
        </span>
        <span
          data-testid="collaboration-event-label"
          className="rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[11px] text-muted"
        >
          {OPERATION_EVENT_LABELS[event.type]}
        </span>
      </header>
      <p className="mt-1.5 text-sm text-text">{collaborationEventSummary(event)}</p>
      <p className="sr-only">{`From ${senderName}.`}</p>
    </article>
  );
}

function ThreadMessage({
  item,
  identities,
}: {
  item: Extract<OperationThreadItem, { kind: "message" }>;
  identities: AgentRosterSummary[];
}) {
  const sender = item.sender;
  const senderName =
    sender.kind === "user"
      ? sender.display_name
      : (identities.find((identity) => identity.agent_id === sender.agent_id)?.display_name ??
        sender.agent_id);
  const identity =
    sender.kind === "agent"
      ? identities.find((entry) => entry.agent_id === sender.agent_id)
      : undefined;
  return (
    <div data-testid="operation-message" data-message-id={item.message_id} className="max-w-2xl">
      <div className="flex items-center gap-2">
        {identity ? <AgentAvatar agent={agentIdentityFromSummary(identity)} size="sm" /> : null}
        <span className="text-sm font-medium text-text">{senderName}</span>
        <AddressingChip addressedTo={item.addressed_to} identities={identities} />
        <span className="sr-only">{`${senderName} said:`}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-text">{item.text}</p>
    </div>
  );
}

export function OperationThreadView({
  items,
  identities,
  state,
  safeErrorMessage,
  onRetry,
  composerValue,
  onComposerChange,
  onSend,
  sendPending,
  approvals,
  className,
}: {
  items: OperationThreadItem[];
  identities: AgentRosterSummary[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  composerValue: string;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  sendPending: boolean;
  /**
   * S20: the workspace's pending approval cards, rendered as the FIRST rows
   * of the thread — in the chat message flow where the system-notice cards
   * live (§S8). The region renders nothing when nothing is pending.
   */
  approvals?: ReactNode;
  className?: string;
}) {
  // The light @-mention affordance: a trailing @-token in the draft shows the
  // roster as name chips; picking one inserts the agent id token.
  const mentionMatch = /@([A-Za-z0-9_-]*)$/.exec(composerValue);
  const canSend = composerValue.trim().length > 0;

  return (
    <section
      data-testid="operation-thread"
      aria-label="Operation conversation"
      className={cn("flex min-h-0 flex-col", className)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-6">
        {state === "loading" ? (
          <div
            aria-busy="true"
            data-testid="operation-thread-skeleton"
            className="flex flex-col gap-4"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <div className="animate-pulse rounded bg-surface-elevated h-3 w-24" />
                <div className="animate-pulse rounded bg-surface-elevated h-3 w-72" />
              </div>
            ))}
          </div>
        ) : state === "error" ? (
          <ErrorState
            safeMessage={safeErrorMessage ?? "The Operation thread could not be loaded."}
            onRetry={onRetry}
          />
        ) : items.length === 0 ? (
          <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
            <p className="text-sm text-muted">No messages yet.</p>
            <p className="mt-1 text-sm text-muted">
              Say hello, or address an Agent directly with @ to start the work.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-5">
            {approvals}
            {items.map((item) => (
              <li
                key={
                  item.kind === "message" ? item.message_id : `${item.stream_id}:${item.sequence}`
                }
              >
                {item.kind === "message" ? (
                  <ThreadMessage item={item} identities={identities} />
                ) : (
                  <CollaborationEventCard item={item} identities={identities} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0 border-t border-line bg-surface px-4 py-3 lg:px-6">
        {mentionMatch ? (
          <div
            data-testid="mention-hint"
            className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"
          >
            <span>Mention an Agent:</span>
            {identities.map((identity) => (
              <button
                key={identity.agent_id}
                type="button"
                className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-text hover:border-line-accent border border-line"
                onClick={() =>
                  onComposerChange(
                    composerValue.replace(/@[A-Za-z0-9_-]*$/, `@${identity.agent_id} `),
                  )
                }
              >
                {identity.display_name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Message the Operation"
            value={composerValue}
            disabled={sendPending}
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && canSend && !sendPending) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={2}
            placeholder="Message the Operation — @ to address an Agent"
            className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
          />
          {canSend ? (
            <Button size="icon" aria-label="Send message" disabled={sendPending} onClick={onSend}>
              <Send aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
