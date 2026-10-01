"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Agent } from "@shera-bot/contracts";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Composer, NO_PROVIDER_COMPOSER_COPY } from "@/components/chat/composer";
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
import {
  advanceConnection,
  DEMO_CONNECTION_CONVERSATION_ID,
  DEMO_CONNECTION_INITIAL_DELAY_MS,
  DEMO_CONNECTION_SCRIPT,
  DEMO_REPLAY_QUEUE,
  INITIAL_CONNECTION,
  type ConnectionState,
} from "@/lib/connection";
import { STREAM_THROTTLE_MS, streamFrameAt } from "@/lib/streaming";
import {
  firstUnreadMessageId,
  flushReplayed,
  insertDaySeparators,
  withSentMessages,
  type TimelineItem,
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
/** Fixture/demo user: local demo sends are attributed to the fixture user. */
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

  const frame = stream ? streamFrameAt(stream.chunks, elapsedMs, stream.chunk_cadence_ms) : null;
  const done = frame?.done ?? false;

  // The interval stops itself at completion: without the `done` gate it kept
  // flushing state at the throttle rate for the lifetime of the mount (~30fps
  // re-renders of the whole chat view long after the stream finished).
  useEffect(() => {
    if (!stream || stopped || done) {
      return;
    }
    const interval = window.setInterval(() => {
      setElapsedMs((ms) => ms + STREAM_THROTTLE_MS);
    }, STREAM_THROTTLE_MS);
    return () => window.clearInterval(interval);
  }, [stream, stopped, done]);

  return { frame, stopped, stop: () => setStopped(true) };
}

/**
 * §6.4 scripted demo driver: after a quiet period (so "connected" is visible
 * first) it fires the DEMO_CONNECTION_SCRIPT steps on timers, making the
 * banner, the replay progress, and the §6.2 handoff reachable in the running
 * demo app. No socket exists yet — the real runtime later drives the same
 * machine from connection events; tests pin the state explicitly instead.
 */
function useScriptedConnection(active: boolean) {
  const [machine, dispatch] = useReducer(advanceConnection, INITIAL_CONNECTION);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timers: number[] = [];
    let elapsed = DEMO_CONNECTION_INITIAL_DELAY_MS;
    for (const step of DEMO_CONNECTION_SCRIPT) {
      const { event, holdMs } = step;
      timers.push(window.setTimeout(() => dispatch(event), elapsed));
      elapsed += holdMs;
    }
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [active]);

  return machine;
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
  connectionState,
  replay,
  pendingReplay,
  mode = "demo",
  timelineOverride,
  liveStream,
  onRuntimeSend,
  onRuntimeRetry,
}: {
  agent: Agent;
  conversation: ConversationSummary;
  thread: ThreadItem[];
  /** §2.4 surface state; the demo runs "ready", the others are wired + tested. */
  surfaceState?: ChatSurfaceState;
  /** Redacted message for the error surface (D23 rule 4). */
  safeErrorMessage?: string | undefined;
  /**
   * §6.4 connection lifecycle. Explicit override for tests / the later real
   * socket; when omitted, the scripted demo drives the state in its own
   * conversation (connected elsewhere): disconnected shows the banner while
   * reading stays possible, reconnecting shows replay progress, and the
   * resumed connection flushes the queued missed messages as a §6.2
   * replayed batch.
   */
  connectionState?: ConnectionState;
  /** Replay progress shown on the reconnecting banner (§6.4). */
  replay?: { done: number; total: number } | undefined;
  /** Missed messages queued for the cursor replay (§6.2 handoff). */
  pendingReplay?: ChatMessage[] | undefined;
  /**
   * S09 chunk 1: "runtime" is the REAL conversation backing — the thread is
   * real journal data, the fixture demo stream never runs (G4: no fabricated
   * assistant message), the composer is disabled while no provider is
   * configured, and no local demo sends are appended. "demo" (default) keeps
   * the S08 fixture behavior for the not-ready container state.
   */
  mode?: "demo" | "runtime";
  /**
   * S09 chunk 2 (runtime live): a fully assembled timeline (ordered,
   * day-separated, replay boundary marked by the live reducer) that replaces
   * the demo merge pipeline's output. The live surface's durable items are
   * journal truth — they must not run through the fixture handoff again.
   */
  timelineOverride?: TimelineItem[] | undefined;
  /** The real reply's transient delta bubble (§6.1), if one is streaming. */
  liveStream?:
    | {
        agentId: string;
        text: string;
        announcementText: string;
      }
    | null
    | undefined;
  /**
   * S09 chunk 2: the real composer's path — the idempotent `message.send`
   * command through the live conversation (§6.3). Providing it ENABLES the
   * composer in runtime mode; without it the no-provider state stays (G4).
   */
  onRuntimeSend?: ((text: string) => void) | undefined;
  /** Retry a failed real send with the SAME idempotency key (receipt replay). */
  onRuntimeRetry?: ((messageId: string) => void) | undefined;
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

  const runtimeMode = mode === "runtime";
  /** The runtime surface with the live send path wired (chunk 2). */
  const runtimeLive = runtimeMode && onRuntimeSend !== undefined;

  // D32 session presence is not reported by the runtime in this slice — the
  // demo derives it from run fixtures, which would fabricate presence on real
  // data. Runtime mode therefore shows no presence pill (G4).
  const presence = runtimeMode ? undefined : sessionPresenceFor(conversation.conversation_id);

  // §6.1 demo streaming: the scripted stream runs only in its own conversation
  // (the General Assistant chat) and only in demo mode — on real rows nothing
  // fabricated ever streams (G4).
  const demoStream =
    !runtimeMode && DEMO_STREAM.conversation_id === conversation.conversation_id
      ? DEMO_STREAM
      : null;
  const {
    frame: streamFrame,
    stopped: streamStopped,
    stop: stopStream,
  } = useScriptedStream(demoStream);

  // Once the demo stream completes, its fixture text IS a normal Agent
  // message in the local thread (never before, and only in this browser).
  // Derived during render — no state, no effect: the react-hooks
  // set-state-in-effect rule (and React's own guidance) both reject
  // syncing derived data through setState-in-effect, and the derived
  // message is fully determined by the completed frame + fixture stamp.
  const streamedMessage = useMemo(() => {
    if (!demoStream || !streamFrame?.done || streamStopped) {
      return null;
    }
    return ChatMessage.parse({
      message_id: demoStream.message_id,
      conversation_id: demoStream.conversation_id,
      sender: { kind: "agent", agent_id: demoStream.agent_id },
      text: streamFrame.visibleText,
      sent_at: demoStream.completed_sent_at,
      delivery: "sent",
      delivery_class: "live",
    });
  }, [demoStream, streamFrame, streamStopped]);

  // §6.4 demo: the scripted connection lifecycle runs only in its own
  // conversation (the General Assistant chat) and only when the caller did
  // not pin the state explicitly (tests / later the real socket).
  const scriptedConnection =
    connectionState === undefined &&
    conversation.conversation_id === DEMO_CONNECTION_CONVERSATION_ID;
  const connectionMachine = useScriptedConnection(scriptedConnection);
  const connection = connectionState ?? connectionMachine.state;
  const replayProgress =
    replay ??
    (connectionState === undefined && connectionMachine.state === "reconnecting"
      ? { done: connectionMachine.replayDone, total: connectionMachine.replayTotal }
      : undefined);
  const replayQueue = useMemo(
    () => pendingReplay ?? (scriptedConnection ? DEMO_REPLAY_QUEUE : undefined),
    [pendingReplay, scriptedConnection],
  );

  // §6.2 handoff: queued replayed messages render only while the connection
  // is (back) in the connected state, closed by the batch boundary marker.
  // Both inputs are memoized so their identities stay stable across renders —
  // otherwise the timeline memo below re-sorts the thread on every render.
  const localAll = useMemo(
    () => (streamedMessage ? [...localMessages, streamedMessage] : localMessages),
    [streamedMessage, localMessages],
  );
  const replayed = useMemo(
    () => (connection === "connected" ? (replayQueue ?? []) : []),
    [connection, replayQueue],
  );
  const timeline = useMemo(
    () => insertDaySeparators(flushReplayed(withSentMessages(thread, localAll), replayed)),
    [thread, localAll, replayed],
  );
  // Runtime live: the reducer-assembled timeline (journal truth + optimistic
  // sends + the §6.2 marker) replaces the demo merge pipeline's output.
  const renderedTimeline = timelineOverride ?? timeline;
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
    // Runtime mode: the real send path — the idempotent command through the
    // live conversation (§6.3). Without the live send prop the composer stays
    // disabled and this guard keeps demo-only appends out of real data (G4).
    if (runtimeMode) {
      onRuntimeSend?.(text);
      return;
    }
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
    // Runtime live: retry re-dispatches the SAME idempotency key — the
    // receipt replay makes it safe even if the first attempt committed (D26).
    if (runtimeLive) {
      onRuntimeRetry?.(messageId);
      return;
    }
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
        {presence ? (
          <AgentAvatar
            agentId={agent.agent_id}
            name={agent.display_name}
            size="lg"
            presence={presence}
          />
        ) : (
          <AgentAvatar agentId={agent.agent_id} name={agent.display_name} size="lg" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            {agent.display_name}
          </h1>
          <p className="truncate text-xs text-muted">{agent.role_description}</p>
        </div>
        {presence ? <PresencePill presence={presence} /> : null}
        {/* Model placeholder collapses away below md — the identity (name +
            role) keeps width priority at the 360px min breakpoint (§2.2). */}
        <button
          type="button"
          disabled
          title={
            runtimeMode
              ? "Provider and model overrides arrive with the settings pass"
              : "Provider and model overrides arrive with the settings pass (demo)"
          }
          className="hidden shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-muted opacity-70 md:block"
        >
          Platform default
        </button>
      </header>

      {/* §6.4 banner: a strip above the thread — reading stays possible while
          disconnected; it never blocks or overlays the conversation. */}
      {connection !== "connected" ? (
        <ConnectionBanner state={connection} replay={replayProgress} />
      ) : null}

      {surfaceState === "loading" ? (
        <ThreadSkeleton />
      ) : surfaceState === "error" ? (
        <ErrorState safeMessage={safeErrorMessage} onRetry={() => undefined} />
      ) : renderedTimeline.length === 0 ? (
        <EmptyThread agentName={agent.display_name} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MessageList
            items={renderedTimeline}
            jumpTargetId={jumpTargetId}
            unreadCount={conversation.unread_count}
            onRetry={handleRetry}
            streamingSlot={
              demoStream && streamFrame && !streamedMessage ? (
                <StreamingMessage
                  agentId={demoStream.agent_id}
                  visibleText={streamFrame.visibleText}
                  announcementText={streamFrame.announcementText}
                  done={streamFrame.done}
                  stopped={streamStopped}
                  onStop={stopStream}
                />
              ) : liveStream ? (
                <StreamingMessage
                  agentId={liveStream.agentId}
                  visibleText={liveStream.text}
                  announcementText={liveStream.announcementText}
                  done={false}
                  stopped={false}
                  onStop={() => undefined}
                  variant="live"
                />
              ) : undefined
            }
          />
        </div>
      )}

      {runtimeLive ? (
        // S09 chunk 2: the real composer — every send is the idempotent
        // message.send command (§6.3); replies are journal events, never a
        // local fabrication (G4).
        <Composer agentName={agent.display_name} onSend={handleSend} />
      ) : runtimeMode ? (
        // G4 / D17: with no provider configured for the container the composer
        // is a clear configuration state — never a fake send, never a
        // fabricated reply. Provider reporting lands with the settings slice.
        <Composer
          agentName={agent.display_name}
          onSend={handleSend}
          disabled
          disabledReason={NO_PROVIDER_COMPOSER_COPY}
        />
      ) : (
        <Composer agentName={agent.display_name} onSend={handleSend} />
      )}
    </div>
  );
}
