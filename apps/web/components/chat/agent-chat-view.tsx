"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@shera-bot/contracts";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Composer } from "@/components/chat/composer";
import { EmptyThread, ThreadSkeleton } from "@/components/chat/thread-states";
import { MessageList } from "@/components/chat/message-list";
import { ErrorState } from "@/components/shell/states";
import {
  ChatMessage,
  sessionPresenceFor,
  type ConversationSummary,
  type SessionPresence,
  type ThreadItem,
} from "@/lib/fixtures";
import { firstUnreadMessageId, insertDaySeparators, withSentMessages } from "@/lib/thread-layout";
import { cn } from "@/lib/utils";

/**
 * S3 Agent direct chat (UI_DESIGN §4 S3, PRD §4.2): persistent conversation
 * with one fixed-role Agent. The header carries identity + role + presence
 * (D32 on-demand session) and the provider/model override placeholder; the
 * thread renders the seeded §9 fixtures with full sender attribution; the
 * composer demo appends to LOCAL FIXTURE STATE only — there is no runtime
 * call and no fabricated reply (G2: an absent runtime is never rendered as
 * an Agent action).
 */
const LOCAL_USER_NAME = "Emon";
/** §6.3 ack target ≈500 ms — the demo settles a local send after this. */
const LOCAL_ACK_MS = 500;

export type ChatSurfaceState = "ready" | "loading" | "error";

function PresencePill({ presence }: { presence: SessionPresence }) {
  return (
    <span
      className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted sm:flex"
      title="On-demand session — it wakes when work starts and hibernates when idle (D32)"
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", presence === "active" ? "bg-live" : "bg-muted")}
      />
      {presence === "active" ? "session active" : "hibernating"}
    </span>
  );
}

export function AgentChatView({
  agent,
  conversation,
  thread,
  surfaceState = "ready",
  safeErrorMessage = "This conversation could not be loaded.",
}: {
  agent: Agent;
  conversation: ConversationSummary;
  thread: ThreadItem[];
  /** §2.4 surface state; the demo runs "ready", the others are wired + tested. */
  surfaceState?: ChatSurfaceState;
  /** Redacted message for the error surface (D23 rule 4). */
  safeErrorMessage?: string;
}) {
  const [sent, setSent] = useState<ChatMessage[]>([]);
  const timersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  const presence = sessionPresenceFor(conversation.conversation_id);

  const timeline = useMemo(
    () => insertDaySeparators(withSentMessages(thread, sent)),
    [thread, sent],
  );
  const jumpTargetId = useMemo(
    () => firstUnreadMessageId(thread, conversation.unread_count),
    [thread, conversation.unread_count],
  );

  const settleAfterAck = (messageId: string) => {
    const timer = window.setTimeout(() => {
      setSent((prev) =>
        prev.map((message) =>
          message.message_id === messageId ? { ...message, delivery: "sent" } : message,
        ),
      );
    }, LOCAL_ACK_MS);
    timersRef.current.push(timer);
  };

  const handleSend = (text: string) => {
    const messageId = `msg_local_${Date.now()}_${sent.length}`;
    const message = ChatMessage.parse({
      message_id: messageId,
      conversation_id: conversation.conversation_id,
      sender: { kind: "user", display_name: LOCAL_USER_NAME },
      text,
      sent_at: new Date().toISOString(),
      delivery: "sending",
    });
    setSent((prev) => [...prev, message]);
    settleAfterAck(messageId);
  };

  const handleRetry = (messageId: string) => {
    setSent((prev) =>
      prev.map((message) =>
        message.message_id === messageId ? { ...message, delivery: "sending" } : message,
      ),
    );
    settleAfterAck(messageId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: identity + role + presence + provider/model placeholder (§S3) */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 lg:px-6">
        <AgentAvatar
          agentId={agent.agent_id}
          name={agent.display_name}
          size="lg"
          presence={presence}
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            {agent.display_name}
          </h1>
          <p className="truncate text-xs text-muted">{agent.role_description}</p>
        </div>
        <PresencePill presence={presence} />
        <button
          type="button"
          disabled
          title="Provider and model overrides arrive with the settings pass (demo)"
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted opacity-70"
        >
          Platform default
        </button>
      </header>

      {surfaceState === "loading" ? (
        <ThreadSkeleton />
      ) : surfaceState === "error" ? (
        <ErrorState safeMessage={safeErrorMessage} onRetry={() => undefined} />
      ) : timeline.length === 0 ? (
        <EmptyThread agentName={agent.display_name} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MessageList
            items={timeline}
            jumpTargetId={jumpTargetId}
            unreadCount={conversation.unread_count}
            onRetry={handleRetry}
          />
        </div>
      )}

      <Composer agentName={agent.display_name} onSend={handleSend} />
    </div>
  );
}
