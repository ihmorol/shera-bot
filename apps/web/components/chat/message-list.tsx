"use client";

import { AlertCircle, Check, Clock } from "lucide-react";
import { Fragment, useRef, type ReactNode, type RefObject } from "react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ArtifactCard, ReplayBoundary, RunCard, ToolCallCard } from "@/components/chat/cards";
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
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        {label}
      </span>
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
        className={cn(
          "flex flex-col items-end",
          replayed && "border-l-2 border-line-accent pl-3",
        )}
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
      <div className="flex items-center gap-2">
        <AgentAvatar agentId={message.sender.agent_id} name={agent?.display_name ?? "?"} size="sm" />
        <span className="text-sm font-medium text-text">
          {agent?.display_name ?? message.sender.agent_id}
        </span>
        {agent ? (
          <span className="truncate text-xs text-muted">{agent.role_description}</span>
        ) : null}
      </div>
      <div className="ml-8 max-w-[78%] rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-2.5 text-base">
        <p className="whitespace-pre-wrap">{message.text}</p>
        <p className="mt-1 text-right font-mono text-[11px] text-muted">
          {timeLabel(message.sent_at)}
        </p>
      </div>
    </li>
  );
}

export function MessageList({
  items,
  jumpTargetId,
  unreadCount,
  onRetry,
}: {
  items: readonly TimelineItem[];
  /** Anchor message id for jump-to-unread (null = nothing unread). */
  jumpTargetId: string | null;
  unreadCount: number;
  onRetry?: ((messageId: string) => void) | undefined;
}) {
  const unreadAnchorRef = useRef<HTMLLIElement | null>(null);

  const scrollToUnread = () => {
    unreadAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <ol className="flex flex-col gap-3 px-4 py-6 lg:px-6" aria-label="Conversation messages">
      {items.map((item, index) => {
        const key = `${item.kind}-${index}`;
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
                <ToolCallCard event={item.event} status={item.status} />
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
    </ol>
  );
}
