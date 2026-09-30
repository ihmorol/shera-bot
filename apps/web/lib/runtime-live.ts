import { compareThreadItems, ChatMessage, type ThreadItem } from "@/lib/fixtures";
import type { RuntimeEvent } from "@/lib/runtime-client";
import { systemTextForEvent } from "@/lib/runtime-thread";
import { insertDaySeparators, type TimelineItem } from "@/lib/thread-layout";

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
}

export const INITIAL_LIVE_STATE: LiveThreadState = {
  phase: "connecting",
  cursor: 0,
  journalItems: [],
  optimistic: [],
  stream: null,
  replay: null,
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
  | { type: "send_failed"; key: string };

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
      return { ...state, phase: "live", replay: null };
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
      return { ...state, optimistic: [...state.optimistic, event.message] };
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
