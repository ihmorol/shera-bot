import { useEffect, useReducer, useRef } from "react";

import { compareThreadItems, ChatMessage, type ThreadItem } from "@/lib/fixtures";
import type { RuntimeEvent } from "@/lib/runtime-client";
import { sendConversationMessage } from "@/lib/runtime-client";
import { systemTextForEvent } from "@/lib/runtime-thread";
import { SNAPSHOT_REQUIRED_MESSAGE } from "@/lib/runtime-data";
import { STREAM_THROTTLE_MS } from "@/lib/streaming";
import { insertDaySeparators, type TimelineItem } from "@/lib/thread-layout";
import { RuntimeSocket } from "@/lib/ws-socket";

/**
 * The live thread state machine (S09 chunk 2) — pure reducer at the heart of
 * the real-mode conversation surface.
 *
 * SEND (D26/D23 rule 6): every send carries a generated idempotency key. The
 * optimistic copy uses that key as its message id; the runtime stamps the
 * durable journal event's correlation_id with the same key. Reconciliation
 * therefore NEVER produces two visible messages: when the authoritative event
 * arrives (live or replayed), the optimistic copy with the matching key is
 * removed and the journal copy takes over. A failed send stays visibly failed
 * (§2.4 ticks) and retry re-sends the SAME key — safe even when the first
 * attempt committed, because the receipt replays.
 *
 * STREAMING (§6.1): reply deltas are TRANSIENT frames — they render through
 * the streaming bubble (throttled by the hook) and never create durable
 * content. The durable agent message arriving clears the bubble, so the
 * reply is visible exactly once.
 *
 * REPLAY (§6.2/§6.4): reconnect replays missed durable events from the last
 * acknowledged sequence; they enter the thread as a replayed batch closed by
 * the "N missed events replayed" marker — never silently as live. The cursor
 * advances only as events are applied (acknowledged after render).
 *
 * Deltas are the ONLY state-less content here: without a durable event,
 * nothing in this reducer fabricates an assistant message (G4).
 */

export type LivePhase = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveStreamState {
  /** The reply identity — the durable reply's idempotency key. */
  key: string;
  agentId: string;
  /** Full visible text so far (hook-throttled to the §6.1 30fps budget). */
  text: string;
}

export interface LiveThreadState {
  phase: LivePhase;
  /** Last acknowledged sequence — drives replay.request on reconnect. */
  cursor: number;
  /** Durable thread items derived ONLY from journal events. */
  journalItems: ThreadItem[];
  /** Sends that have not been reconciled with the journal yet. */
  optimistic: ChatMessage[];
  /** The active streaming reply bubble (transient deltas), if any. */
  stream: LiveStreamState | null;
  /** Replay progress while reconnecting (§6.4). */
  replay: { done: number; total: number } | null;
  /** A typed transport-level failure worth a §2.4 error surface (redacted). */
  error: string | null;
}

export const INITIAL_LIVE_STATE: LiveThreadState = {
  phase: "connecting",
  cursor: 0,
  journalItems: [],
  optimistic: [],
  stream: null,
  replay: null,
  error: null,
};

export type LiveThreadEvent =
  | { type: "connecting" }
  | { type: "subscribed" }
  | { type: "disconnected" }
  | { type: "reconnecting" }
  | { type: "replay_started"; total: number }
  | { type: "replay_event"; event: RuntimeEvent; mode: "initial" | "reconnect" }
  | { type: "replay_complete" }
  | { type: "live_event"; event: RuntimeEvent }
  | { type: "stream_text"; streamKey: string; agentId: string; text: string }
  | { type: "send_started"; message: ChatMessage }
  | { type: "send_acked"; key: string }
  | { type: "send_failed"; key: string }
  | { type: "transport_error"; message: string };

function messageFromEvent(event: RuntimeEvent, deliveryClass: "live" | "replayed"): ChatMessage {
  const payload = event.payload as {
    conversation_id: string;
    message_id: string;
    sender: { kind: string; display_name?: string; agent_id?: string };
    text: string;
  };
  const sender =
    payload.sender.kind === "agent"
      ? { kind: "agent" as const, agent_id: payload.sender.agent_id ?? "agent_unknown" }
      : { kind: "user" as const, display_name: payload.sender.display_name ?? "You" };
  return ChatMessage.parse({
    message_id: payload.message_id,
    conversation_id: payload.conversation_id,
    sender,
    text: payload.text,
    sent_at: event.occurred_at,
    delivery: "sent",
    delivery_class: deliveryClass,
  });
}

/** Apply one durable journal event to the thread; returns the next state. */
function applyJournalEvent(
  state: LiveThreadState,
  event: RuntimeEvent,
  deliveryClass: "live" | "replayed",
): LiveThreadState {
  // Exactly-once application: a repeated delivery below the cursor is noise.
  if (event.sequence <= state.cursor) {
    return state;
  }

  const optimistic = event.correlation_id
    ? state.optimistic.filter((message) => message.message_id !== event.correlation_id)
    : state.optimistic;

  // The durable reply reconciles the transient bubble: the reply is now
  // visible exactly once — as the journal message.
  const stream = state.stream && state.stream.key === event.correlation_id ? null : state.stream;

  let journalItems = state.journalItems;
  if (event.type === "message.appended") {
    const message = messageFromEvent(event, deliveryClass);
    journalItems = [...journalItems, { kind: "message", at: message.sent_at, message }];
  } else {
    journalItems = [
      ...journalItems,
      { kind: "system", at: event.occurred_at, text: systemTextForEvent(event) },
    ];
  }

  return { ...state, cursor: event.sequence, journalItems, optimistic, stream };
}

export function advanceLiveThread(state: LiveThreadState, event: LiveThreadEvent): LiveThreadState {
  switch (event.type) {
    case "connecting":
      return { ...state, phase: "connecting" };
    case "subscribed":
      return { ...state, phase: "live", replay: null, error: null };
    case "disconnected":
      return { ...state, phase: "offline" };
    case "reconnecting":
      return { ...state, phase: "reconnecting", replay: null };
    case "replay_started":
      return { ...state, replay: { done: 0, total: event.total } };
    case "replay_event":
      // Initial history (cursor 0 on first connect) is live-class and carries
      // NO batch marker; only a RECONNECT replay renders as the §6.2 batch.
      return applyJournalEvent(
        state,
        event.event,
        event.mode === "reconnect" ? "replayed" : "live",
      );
    case "replay_complete":
      return { ...state, phase: "live", replay: null };
    case "live_event":
      return applyJournalEvent(state, event.event, "live");
    case "stream_text":
      // The hook flushes buffered deltas on the §6.1 throttle budget; the
      // reducer only mirrors the visible text.
      return {
        ...state,
        stream: { key: event.streamKey, agentId: event.agentId, text: event.text },
      };
    case "send_started":
      // A retry re-dispatches the same key: replace the existing optimistic
      // copy so a retried send never appears twice.
      return {
        ...state,
        optimistic: [
          ...state.optimistic.filter((message) => message.message_id !== event.message.message_id),
          event.message,
        ],
      };
    case "send_acked":
      return {
        ...state,
        optimistic: state.optimistic.map((message) =>
          message.message_id === event.key ? { ...message, delivery: "sent" as const } : message,
        ),
      };
    case "send_failed":
      return {
        ...state,
        optimistic: state.optimistic.map((message) =>
          message.message_id === event.key ? { ...message, delivery: "failed" as const } : message,
        ),
      };
    case "transport_error":
      // Redacted safe copy only (D23 rule 4) — the thread stays readable.
      return { ...state, error: event.message };
  }
}

/** How many of the applied replay events were messages (marker semantics §6.2). */
export interface LiveTimeline {
  timeline: TimelineItem[];
  /** The §6.2 reconnect batch boundary marker ("N missed events replayed"). */
  replayBoundary: { at: string; count: number } | null;
}

/**
 * Assemble the rendered timeline: durable items + the optimistic sends
 * (always live, this browser), sorted by the single ordering, then day
 * separators. The replay boundary marker is computed here from the durable
 * items so the marker sits exactly at the seam of the reconnect batch.
 */
export function assembleLiveTimeline(state: LiveThreadState): LiveTimeline {
  const items: ThreadItem[] = [
    ...state.journalItems,
    ...state.optimistic.map<ThreadItem>((message) => ({
      kind: "message",
      at: message.sent_at,
      message,
    })),
  ].sort(compareThreadItems);

  // The last contiguous replayed batch closes with the boundary marker.
  let boundary: LiveTimeline["replayBoundary"] = null;
  let markerIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message" && item.message.delivery_class === "replayed") {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex >= 0) {
    let count = 0;
    for (let index = markerIndex; index >= 0; index -= 1) {
      const item = items[index]!;
      if (item.kind === "message" && item.message.delivery_class === "replayed") {
        count += 1;
        continue;
      }
      break;
    }
    // The marker anchors at the LAST replayed row — it closes the batch.
    boundary = { at: items[markerIndex]!.at, count };
  }
  const withBoundary: ThreadItem[] = boundary
    ? [
        ...items.slice(0, markerIndex + 1),
        { kind: "replay_boundary", at: boundary.at, count: boundary.count },
        ...items.slice(markerIndex + 1),
      ]
    : items;
  return { timeline: insertDaySeparators(withBoundary), replayBoundary: boundary };
}

// ---------------------------------------------------------------------------

/** The conversation stream id for the WS gateway rooms and replay requests. */
export function conversationStreamId(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** Map the live phase onto the §6.4 banner states (connecting shows no banner). */
export function connectionStateOf(phase: LivePhase): "connected" | "disconnected" | "reconnecting" {
  switch (phase) {
    case "offline":
      return "disconnected";
    case "reconnecting":
      return "reconnecting";
    default:
      return "connected";
  }
}

export interface UseLiveConversationArgs {
  /** The runtime WS base URL (NEXT_PUBLIC_RUNTIME_WS_URL); null disables live. */
  wsUrl: string | null;
  workspaceId: string;
  conversationId: string;
  /** Sender attribution for the user's own turns (from the S02 session). */
  displayName: string;
  /** Attribution for the streaming reply bubble (the conversation's Agent). */
  agentId: string;
  enabled: boolean;
}

export interface LiveConversation {
  /** §6.4 banner state driven by the REAL socket lifecycle. */
  connectionState: "connected" | "disconnected" | "reconnecting";
  replay: { done: number; total: number } | undefined;
  timeline: TimelineItem[];
  stream: LiveStreamState | null;
  loading: boolean;
  error: string | null;
  /** Send one turn: optimistic render + idempotent typed command (§6.3). */
  sendMessage(text: string): void;
  /** Retry a failed send with the SAME idempotency key (receipt replay). */
  retry(key: string): void;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 3000;

/**
 * The live conversation hook (S09 chunk 2): RuntimeSocket + the live-thread
 * reducer, wired to REAL socket lifecycle. Subscribes to the conversation's
 * stream, loads history via replay.request from the applied cursor, applies
 * live events, reconciles sends, and drives the §6.4 banner machine from the
 * real connection state — never the demo script. Deltas buffer in a ref and
 * flush on the §6.1 33ms budget, so DOM updates stay within ~30fps.
 */
export function useLiveConversation(args: UseLiveConversationArgs): LiveConversation {
  const [state, dispatch] = useReducer(advanceLiveThread, INITIAL_LIVE_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const deltaBufferRef = useRef<{ key: string; text: string } | null>(null);

  const { wsUrl, workspaceId, conversationId, agentId, enabled } = args;
  const streamId = conversationStreamId(conversationId);

  useEffect(() => {
    if (!enabled || !wsUrl) {
      return;
    }
    let cancelled = false;
    let socket: RuntimeSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const flushDeltas = () => {
      const buffered = deltaBufferRef.current;
      if (buffered) {
        deltaBufferRef.current = null;
        dispatch({
          type: "stream_text",
          streamKey: buffered.key,
          agentId,
          text: buffered.text,
        });
      }
    };
    const flushInterval = window.setInterval(flushDeltas, STREAM_THROTTLE_MS);

    const connect = () => {
      const isReconnect = reconnectAttempt > 0;
      if (isReconnect) {
        dispatch({ type: "reconnecting" });
      }
      void (async () => {
        try {
          const opened = await RuntimeSocket.open(wsUrl);
          if (cancelled) {
            opened.close();
            return;
          }
          socket = opened;
          await socket.request("stream.subscribe", { workspace_id: workspaceId, stream_id: streamId });

          // Durable history from the applied cursor — initial load (cursor 0)
          // renders live-class; a RECONNECT replay renders the §6.2 batch.
          const replay = await socket.request("replay.request", {
            workspace_id: workspaceId,
            stream_id: streamId,
            last_acknowledged_sequence: stateRef.current.cursor,
          });
          if (cancelled) {
            return;
          }
          const replayResult = replay as { kind?: string; events?: unknown[] } | null;
          if (replayResult && replayResult.kind === "events" && Array.isArray(replayResult.events)) {
            dispatch({ type: "replay_started", total: replayResult.events.length });
            for (const event of replayResult.events) {
              if (cancelled) {
                return;
              }
              dispatch({
                type: "replay_event",
                event: event as RuntimeEvent,
                mode: isReconnect ? "reconnect" : "initial",
              });
            }
          } else {
            // E10 snapshot fallback / unknown stream: honest typed surface.
            dispatch({ type: "transport_error", message: SNAPSHOT_REQUIRED_MESSAGE });
          }
          dispatch({ type: "replay_complete" });
          reconnectAttempt = 0;

          // Live fanout: committed journal events + transient delta frames.
          socket.onEvent((name, payload) => {
            if (name === "stream.event" && payload && typeof payload === "object") {
              dispatch({ type: "live_event", event: payload as RuntimeEvent });
              return;
            }
            if (name === "stream.frame" && payload && typeof payload === "object") {
              const frame = payload as { frame?: string; stream_key?: string; text_delta?: string };
              if (frame.frame === "message.delta" && typeof frame.stream_key === "string") {
                const previous = deltaBufferRef.current;
                const next =
                  previous && previous.key === frame.stream_key
                    ? previous.text + (frame.text_delta ?? "")
                    : (frame.text_delta ?? "");
                deltaBufferRef.current = { key: frame.stream_key, text: next };
              }
            }
          });
          socket.onClose(() => {
            if (cancelled) {
              return;
            }
            flushDeltas();
            dispatch({ type: "disconnected" });
            const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
            reconnectAttempt += 1;
            reconnectTimer = window.setTimeout(connect, delay);
          });
        } catch {
          if (cancelled) {
            return;
          }
          dispatch({ type: "disconnected" });
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        }
      })();
    };

    connect();
    return () => {
      cancelled = true;
      window.clearInterval(flushInterval);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
    // The conversation identity + connection configuration own the lifecycle;
    // attribution strings are stable per surface and listed as dependencies.
  }, [enabled, wsUrl, workspaceId, conversationId, streamId, agentId]);

  const send = (key: string, text: string) => {
    const message = ChatMessage.parse({
      message_id: key,
      conversation_id: conversationId,
      sender: { kind: "user", display_name: args.displayName },
      text,
      sent_at: new Date().toISOString(),
      delivery: "sending",
    });
    dispatch({ type: "send_started", message });
    void sendConversationMessage({
      workspaceId,
      conversationId,
      text,
      displayName: args.displayName,
      idempotencyKey: key,
    })
      .then(() => dispatch({ type: "send_acked", key }))
      .catch(() => dispatch({ type: "send_failed", key }));
  };

  return {
    connectionState: connectionStateOf(state.phase),
    replay: state.replay ?? undefined,
    timeline: assembleLiveTimeline(state).timeline,
    stream: state.stream,
    loading: state.phase === "connecting" && state.journalItems.length === 0,
    error: state.error,
    sendMessage: (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      send(`msg-${crypto.randomUUID()}`, trimmed);
    },
    retry: (key: string) => {
      const original = stateRef.current.optimistic.find(
        (message) => message.message_id === key,
      );
      if (original) {
        send(key, original.text);
      }
    },
  };
}
