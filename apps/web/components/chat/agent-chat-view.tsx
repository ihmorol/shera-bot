"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "@shera-bot/contracts";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Composer } from "@/components/chat/composer";
import { EmptyThread, ThreadSkeleton } from "@/components/chat/thread-states";
import { MessageList } from "@/components/chat/message-list";
import { StreamingMessage } from "@/components/chat/streaming-message";
import { ConnectionBanner } from "@/components/shell/connection-banner";
import { ErrorState } from "@/components/shell/states";
import {
  ChatMessage,
  DEMO_STREAM,
  sessionPresenceFor,
  type ConversationSummary,
  type FixtureStream,
  type SessionPresence,
  type ThreadItem,
} from "@/lib/fixtures";
import type { ConnectionState } from "@/lib/connection";
import { STREAM_THROTTLE_MS, streamFrameAt } from "@/lib/streaming";
import {
  firstUnreadMessageId,
  flushReplayed,
  insertDaySeparators,
  withSentMessages,
} from "@/lib/thread-layout";
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

/**
 * §6.1 demo streaming driver: one interval at the throttle budget flushes
 * state, so DOM updates never exceed ~30fps no matter how fast the scripted
 * chunks arrive. DEMO STREAMING — the chunks come from the fixture stream;
 * the real runtime later replaces this with the message_delta socket.
 */
function useScriptedStream(stream: FixtureStream | null) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (!stream || stopped) {
      return;
    }
    const interval = window.setInterval(() => {
      setElapsedMs((ms) => ms + STREAM_THROTTLE_MS);
    }, STREAM_THROTTLE_MS);
    return () => window.clearInterval(interval);
  }, [stream, stopped]);

  const frame = stream ? streamFrameAt(stream.chunks, elapsedMs, stream.chunk_cadence_ms) : null;
  return { frame, stopped, stop: () => setStopped(true) };
}

function PresencePill({ presence }: { presence: SessionPresence }) {
  const label = presence === "active" ? "session active" : "hibernating";
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted"
      title="On-demand session — it wakes when work starts and hibernates when idle (D32)"
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", presence === "active" ? "bg-live" : "bg-muted")}
      />
      {/* Below md the pill collapses to the dot + screen-reader label so the
          Agent name keeps width priority at 360px (§2.2 min breakpoint). */}
      <span className="sr-only md:not-sr-only">{label}</span>
    </span>
  );
}

export function AgentChatView({
  agent,
  conversation,
  thread,
  surfaceState = "ready",
  safeErrorMessage = "This conversation could not be loaded.",
  connectionState = "connected",
  replay,
  pendingReplay,
}: {
  agent: Agent;
  conversation: ConversationSummary;
  thread: ThreadItem[];
  /** §2.4 surface state; the demo runs "ready", the others are wired + tested. */
  surfaceState?: ChatSurfaceState;
  /** Redacted message for the error surface (D23 rule 4). */
  safeErrorMessage?: string;
  /**
   * §6.4 connection lifecycle (scripted demo / later the real socket). While
   * disconnected the banner shows and reading stays possible; while
   * reconnecting it shows replay progress; on connected the queued replay
   * flushes into the thread as a replayed batch (§6.2 marker).
   */
  connectionState?: ConnectionState;
  /** Replay progress shown on the reconnecting banner (§6.4). */
  replay?: { done: number; total: number } | undefined;
  /** Missed messages queued for the cursor replay (§6.2 handoff). */
  pendingReplay?: ChatMessage[] | undefined;
}) {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
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

  // §6.1 demo streaming: the scripted stream runs only in its own conversation
  // (the General Assistant chat) and is labeled as demo streaming in the UI.
  const demoStream =
    DEMO_STREAM.conversation_id === conversation.conversation_id ? DEMO_STREAM : null;
  const {
    frame: streamFrame,
    stopped: streamStopped,
    stop: stopStream,
  } = useScriptedStream(demoStream);

  // Once the demo stream completes, its fixture text becomes a normal Agent
  // message in the local thread (never before, and only in this browser).
  const [streamedMessage, setStreamedMessage] = useState<ChatMessage | null>(null);
  useEffect(() => {
    if (demoStream && streamFrame?.done && !streamStopped && !streamedMessage) {
      setStreamedMessage(
        ChatMessage.parse({
          message_id: demoStream.message_id,
          conversation_id: demoStream.conversation_id,
          sender: { kind: "agent", agent_id: demoStream.agent_id },
          text: streamFrame.visibleText,
          sent_at: new Date().toISOString(),
          delivery: "sent",
          delivery_class: "live",
        }),
      );
    }
  }, [demoStream, streamFrame, streamStopped, streamedMessage]);

  // §6.2 handoff: queued replayed messages render only while the connection
  // is (back) in the connected state, closed by the batch boundary marker.
  const replayed = connectionState === "connected" ? (pendingReplay ?? []) : [];
  const localAll = streamedMessage ? [...localMessages, streamedMessage] : localMessages;
  const timeline = useMemo(
    () => insertDaySeparators(flushReplayed(withSentMessages(thread, localAll), replayed)),
    [thread, localAll, replayed],
  );
  const jumpTargetId = useMemo(
    () => firstUnreadMessageId(thread, conversation.unread_count),
    [thread, conversation.unread_count],
  );

  const settleAfterAck = (messageId: string) => {
    const timer = window.setTimeout(() => {
      setLocalMessages((prev) =>
        prev.map((message) =>
          message.message_id === messageId ? { ...message, delivery: "sent" } : message,
        ),
      );
    }, LOCAL_ACK_MS);
    timersRef.current.push(timer);
  };

  const handleSend = (text: string) => {
    const messageId = `msg_local_${Date.now()}_${localMessages.length}`;
    const message = ChatMessage.parse({
      message_id: messageId,
      conversation_id: conversation.conversation_id,
      sender: { kind: "user", display_name: LOCAL_USER_NAME },
      text,
      sent_at: new Date().toISOString(),
      delivery: "sending",
    });
    setLocalMessages((prev) => [...prev, message]);
    settleAfterAck(messageId);
  };

  const handleRetry = (messageId: string) => {
    setLocalMessages((prev) =>
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
        {/* Model placeholder collapses away below md — the identity (name +
            role) keeps width priority at the 360px min breakpoint (§2.2). */}
        <button
          type="button"
          disabled
          title="Provider and model overrides arrive with the settings pass (demo)"
          className="hidden shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted opacity-70 md:block"
        >
          Platform default
        </button>
      </header>

      {/* §6.4 banner: a strip above the thread — reading stays possible while
          disconnected; it never blocks or overlays the conversation. */}
      {connectionState !== "connected" ? (
        <ConnectionBanner state={connectionState} replay={replay} />
      ) : null}

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
            streamingSlot={
              demoStream && streamFrame && !streamedMessage ? (
                <StreamingMessage
                  agentId={demoStream.agent_id}
                  visibleText={streamFrame.visibleText}
                  done={streamFrame.done}
                  stopped={streamStopped}
                  onStop={stopStream}
                />
              ) : undefined
            }
          />
        </div>
      )}

      <Composer agentName={agent.display_name} onSend={handleSend} />
    </div>
  );
}
