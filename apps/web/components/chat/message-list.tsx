"use client";

import { AlertCircle, Check, Clock } from "lucide-react";
import { Fragment, useRef, type ReactNode, type RefObject } from "react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ArtifactCard, ReplayBoundary, RunCard, ToolCallCard } from "@/components/chat/cards";
import { renderCollaborationSummary } from "@/lib/collaboration";
import { agentById } from "@/lib/fixtures";
import type { TimelineItem } from "@/lib/thread-layout";
import { timeLabel } from "@/lib/thread-layout";
import { cn } from "@/lib/utils";

/**
 * The S3/S4 message list (UI_DESIGN §5): user bubbles (right, status ticks),
 * Agent messages with full sender attribution — avatar + name + role, per
 * PRD §21.5 — system notices, day separators, the §6.2 replayed-batch marker
 * with a subtle left border on replayed rows, and jump-to-unread. Presenta-
 * tional only: items arrive already ordered by lib/thread-layout.
 */

function DaySeparatorRow({ label }: { label: string }) {
  return (
    <li className="my-4 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

function DeliveryTick({
  delivery,
  at,
  messageId,
  onRetry,
}: {
  delivery: "sending" | "sent" | "failed";
  at: string;
  messageId?: string;
  onRetry?: ((messageId: string) => void) | undefined;
}) {
  return (
    <span className="mt-1 flex items-center justify-end gap-1 font-mono text-[11px] text-muted">
      {timeLabel(at)}
      {delivery === "sending" ? (
        <>
          <Clock className="size-3" aria-hidden="true" />
          <span>Sending…</span>
        </>
      ) : null}
      {delivery === "sent" ? (
        <>
          <Check className="size-3" aria-hidden="true" />
          <span>Sent</span>
        </>
      ) : null}
      {delivery === "failed" ? (
        <>
          <AlertCircle className="size-3 text-failed" aria-hidden="true" />
          <span className="text-failed">Failed</span>
          {onRetry && messageId ? (
            <button
              type="button"
              onClick={() => onRetry(messageId)}
              className="rounded px-1 text-sky underline underline-offset-2"
            >
              Retry
            </button>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

function MessageRow({
  item,
  anchorRef,
  onRetry,
}: {
  item: Extract<TimelineItem, { kind: "message" }>;
  /** Attached only on the jump-to-unread anchor message (§S3). */
  anchorRef?: RefObject<HTMLLIElement | null> | undefined;
  onRetry?: ((messageId: string) => void) | undefined;
}): ReactNode {
  const { message } = item;
  const replayed = message.delivery_class === "replayed";

  if (message.sender.kind === "system") {
    return (
      <li ref={anchorRef} className="flex justify-center">
        <p
          className={cn(
            "max-w-[80%] text-center text-[13px] text-muted",
            replayed && "border-l-2 border-line-accent pl-3",
          )}
        >
          {message.text}
        </p>
      </li>
    );
  }

  if (message.sender.kind === "user") {
    return (
      <li
        ref={anchorRef}
        className={cn("flex flex-col items-end", replayed && "border-l-2 border-line-accent pl-3")}
      >
        <div className="max-w-[78%] rounded-2xl rounded-br-sm bg-surface-elevated px-4 py-2.5 text-base">
          <p className="whitespace-pre-wrap">{message.text}</p>
        </div>
        <DeliveryTick
          delivery={message.delivery}
          at={message.sent_at}
          messageId={message.message_id}
          onRetry={onRetry}
        />
      </li>
    );
  }

  // Agent message — full attribution (§21.5): avatar + name + role, resolved
  // from the contract-typed pack (D39: one identity record per Agent).
  const agent = agentById(message.sender.agent_id);
  return (
    <li
      ref={anchorRef}
      className={cn("flex flex-col items-start", replayed && "border-l-2 border-line-accent pl-3")}
    >
      {/* min-w-0 max-w-full: inside the items-start column this row would
          otherwise size to max-content and let the nowrap role line overflow
          the 360px min breakpoint (§2.2). */}
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <AgentAvatar
          agent={
            agent ?? {
              agent_id: message.sender.agent_id,
              display_name: message.sender.agent_id,
            }
          }
          size="sm"
        />
        <span className="text-sm font-medium text-text">
          {agent?.display_name ?? message.sender.agent_id}
        </span>
        {agent ? (
          <span className="min-w-0 truncate text-xs text-muted">{agent.role_description}</span>
        ) : null}
      </div>
      <div className="ml-8 max-w-[78%] rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-2.5 text-base">
        <p className="whitespace-pre-wrap">
          {/* §2.3: Agent messages announce the sender ("Researcher said:"). */}
          <span className="sr-only">{agent?.display_name ?? message.sender.agent_id} said: </span>
          {message.text}
        </p>
        <p className="mt-1 text-right font-mono text-[11px] text-muted">
          {timeLabel(message.sent_at)}
        </p>
      </div>
    </li>
  );
}

/**
 * Stable React key per timeline item: record ids where the record carries
 * one (message/event/artifact/run), kind + timestamp for the synthetic rows
 * (day separators, seeded system notices, replay boundaries — unique per
 * timestamp in the fixture corpus). Index keys would re-mount rows whenever
 * a replay flush or local send shifts the ordering.
 */
function timelineKey(item: TimelineItem): string {
  switch (item.kind) {
    case "message":
      return `message-${item.message.message_id}`;
    case "tool_card":
      return `tool_card-${item.event.event_id}`;
    case "artifact":
      return `artifact-${item.artifact.artifact_id}`;
    case "run":
      return `run-${item.run.task_id}`;
    case "collaboration":
      // D23 rule 6: the idempotency key is the identity, never the prose.
      return `collaboration-${item.message.idempotency_key}`;
    case "system":
      return `system-${item.at}`;
    case "replay_boundary":
      return `replay_boundary-${item.at}-${item.count}`;
    case "day_separator":
      return `day_separator-${item.at}`;
  }
}

export function MessageList({
  items,
  jumpTargetId,
  unreadCount,
  onRetry,
  streamingSlot,
}: {
  items: readonly TimelineItem[];
  /** Anchor message id for jump-to-unread (null = nothing unread). */
  jumpTargetId: string | null;
  unreadCount: number;
  onRetry?: ((messageId: string) => void) | undefined;
  /** Live row rendered after the timeline — the §6.1 demo stream message. */
  streamingSlot?: ReactNode | undefined;
}) {
  const unreadAnchorRef = useRef<HTMLLIElement | null>(null);

  const scrollToUnread = () => {
    unreadAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <ol className="flex flex-col gap-3 px-4 py-6 lg:px-6" aria-label="Conversation messages">
      {items.map((item) => {
        const key = timelineKey(item);
        const isAnchor =
          item.kind === "message" &&
          jumpTargetId !== null &&
          item.message.message_id === jumpTargetId;

        if (isAnchor && unreadCount > 0) {
          return (
            <Fragment key={key}>
              <li className="flex justify-center">
                <button
                  type="button"
                  onClick={scrollToUnread}
                  className="rounded-full border border-line-accent bg-surface px-3 py-1 font-mono text-[11px] text-sky transition-colors hover:bg-surface-elevated"
                >
                  Jump to unread · {unreadCount} new
                </button>
              </li>
              <MessageRow item={item} anchorRef={unreadAnchorRef} onRetry={onRetry} />
            </Fragment>
          );
        }

        switch (item.kind) {
          case "day_separator":
            return <DaySeparatorRow key={key} label={item.label} />;
          case "message":
            return <MessageRow key={key} item={item} onRetry={onRetry} />;
          case "tool_card":
            return (
              <li key={key} className="flex justify-start">
                <ToolCallCard event={item.event} />
              </li>
            );
          case "artifact":
            return (
              <li key={key} className="flex justify-start">
                <ArtifactCard artifact={item.artifact} />
              </li>
            );
          case "run":
            return (
              <li key={key} className="flex justify-start">
                <RunCard run={item.run} />
              </li>
            );
          case "collaboration":
            // D7 agent-to-agent traffic, in the same ordered thread. The row is a
            // proposal/report, never a completed action (G2/G4), and it names
            // both Agents so the handoff is legible at a glance (§21.5).
            return (
              <li key={key} className="flex justify-start">
                {renderCollaborationSummary({ message: item.message })}
              </li>
            );
          case "system":
            return (
              <li key={key} className="flex justify-center">
                <p className="max-w-[80%] text-center text-[13px] text-muted">{item.text}</p>
              </li>
            );
          case "replay_boundary":
            return <ReplayBoundary key={key} count={item.count} />;
        }
      })}
      {streamingSlot ? <li key="streaming">{streamingSlot}</li> : null}
    </ol>
  );
}
