import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../lib/fixtures";
import {
  advanceLiveThread,
  assembleLiveTimeline,
  INITIAL_LIVE_STATE,
  type LiveThreadState,
} from "../lib/runtime-live";
import type { RuntimeEvent } from "../lib/runtime-client";

/**
 * The live thread state machine (S09 chunk 2): optimistic sends reconcile
 * with the authoritative journal by idempotency key (NEVER two visible
 * messages), transient reply deltas render through the streaming bubble only,
 * reconnect replays land as the §6.2 replayed batch with the marker, and the
 * cursor advances only as events are applied.
 */

const CONVERSATION = "conv-1";

function messageEvent(overrides: {
  sequence: number;
  correlationId: string;
  messageId?: string;
  kind?: "user" | "agent";
  text?: string;
  occurredAt?: string;
}): RuntimeEvent {
  return {
    event_id: `evt_${overrides.sequence}`,
    stream_id: `conversation:${CONVERSATION}`,
    sequence: overrides.sequence,
    type: "message.appended",
    schema_version: 1,
    payload: {
      conversation_id: CONVERSATION,
      workspace_id: "ws_account-1",
      message_id: overrides.messageId ?? `msg_${overrides.sequence}`,
      sender:
        overrides.kind === "agent"
          ? { kind: "agent", agent_id: "agent_general_assistant" }
          : { kind: "user", display_name: "Emon" },
      text: overrides.text ?? "Hello there",
    },
    workspace_id: "ws_account-1",
    occurred_at: overrides.occurredAt ?? "2026-09-30T10:00:00Z",
    correlation_id: overrides.correlationId,
  };
}

function optimisticMessage(key: string, delivery: "sending" | "sent" | "failed"): ChatMessage {
  return {
    message_id: key,
    conversation_id: CONVERSATION,
    sender: { kind: "user", display_name: "Emon" },
    text: "Hello there",
    sent_at: "2026-09-30T09:59:00Z",
    delivery,
    delivery_class: "live",
  };
}

function live(state: LiveThreadState = INITIAL_LIVE_STATE): LiveThreadState {
  return advanceLiveThread(state, { type: "subscribed" });
}

function messagesOf(
  state: LiveThreadState,
): Array<{ id: string; delivery: string; klass: string }> {
  return assembleLiveTimeline(state)
    .timeline.flatMap((item) => (item.kind === "message" ? [item.message] : []))
    .map((message) => ({
      id: message.message_id,
      delivery: message.delivery,
      klass: message.delivery_class,
    }));
}

describe("send → reconcile (D26/D23 rule 6)", () => {
  it("the optimistic copy is replaced by the authoritative event — exactly one message", () => {
    let state = live();
    state = advanceLiveThread(state, {
      type: "send_started",
      message: optimisticMessage("idem-key-1", "sending"),
    });
    expect(messagesOf(state)).toEqual([{ id: "idem-key-1", delivery: "sending", klass: "live" }]);

    state = advanceLiveThread(state, { type: "send_acked", key: "idem-key-1" });
    expect(messagesOf(state)[0]!.delivery).toBe("sent");

    // The durable event carries the SAME idempotency key as its correlation.
    const authoritative = messageEvent({ sequence: 1, correlationId: "idem-key-1" });
    state = advanceLiveThread(state, { type: "live_event", event: authoritative });
    const visible = messagesOf(state);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toEqual({ id: "msg_1", delivery: "sent", klass: "live" });
    // The cursor acknowledged the applied event.
    expect(state.cursor).toBe(1);
  });

  it("a failed send stays visibly failed until the authoritative event arrives", () => {
    let state = live();
    state = advanceLiveThread(state, {
      type: "send_started",
      message: optimisticMessage("idem-key-2", "sending"),
    });
    state = advanceLiveThread(state, { type: "send_failed", key: "idem-key-2" });
    expect(messagesOf(state)).toEqual([{ id: "idem-key-2", delivery: "failed", klass: "live" }]);

    // The retry (or a delayed server commit) still reconciles: the failed
    // optimistic copy is replaced by the durable message — never duplicated.
    state = advanceLiveThread(state, {
      type: "live_event",
      event: messageEvent({ sequence: 1, correlationId: "idem-key-2" }),
    });
    expect(messagesOf(state)).toHaveLength(1);
    expect(messagesOf(state)[0]!.id).toBe("msg_1");
  });

  it("a repeated delivery below the cursor is ignored — no duplicate application", () => {
    let state = live();
    const event = messageEvent({ sequence: 1, correlationId: "k1" });
    state = advanceLiveThread(state, { type: "live_event", event });
    state = advanceLiveThread(state, { type: "live_event", event });
    expect(messagesOf(state)).toHaveLength(1);
    expect(state.cursor).toBe(1);
  });
});

describe("reply streaming (transient deltas, durable truth)", () => {
  it("deltas render the streaming bubble; the durable reply clears it exactly once", () => {
    let state = live();
    state = advanceLiveThread(state, {
      type: "stream_text",
      streamKey: "reply-evt_1",
      agentId: "agent_general_assistant",
      text: "Here is my initi",
    });
    expect(state.stream).toEqual({
      key: "reply-evt_1",
      agentId: "agent_general_assistant",
      text: "Here is my initi",
    });

    // The durable agent reply carries the reply key as its correlation id.
    state = advanceLiveThread(state, {
      type: "live_event",
      event: messageEvent({
        sequence: 1,
        correlationId: "reply-evt_1",
        messageId: "durable_reply_1",
        kind: "agent",
        text: "Here is my initial take.",
      }),
    });
    // The bubble is gone; the durable message shows once.
    expect(state.stream).toBeNull();
    expect(messagesOf(state)).toEqual([{ id: "durable_reply_1", delivery: "sent", klass: "live" }]);
  });

  it("a delta alone never fabricates a durable message (G4)", () => {
    let state = live();
    state = advanceLiveThread(state, {
      type: "stream_text",
      streamKey: "reply-x",
      agentId: "agent_general_assistant",
      text: "Looks like a reply…",
    });
    // No journal event arrived: nothing in the thread, only the bubble.
    expect(messagesOf(state)).toHaveLength(0);
    expect(state.journalItems).toHaveLength(0);
  });
});

describe("connection lifecycle + replay (§6.2/§6.4)", () => {
  it("reconnect replays missed events as the marked replayed batch, then resumes live", () => {
    let state = live();
    state = advanceLiveThread(state, {
      type: "live_event",
      event: messageEvent({ sequence: 1, correlationId: "k1", text: "before drop" }),
    });

    // The socket drops; reading stays possible, the banner goes disconnected.
    state = advanceLiveThread(state, { type: "disconnected" });
    expect(state.phase).toBe("offline");

    state = advanceLiveThread(state, { type: "reconnecting" });
    state = advanceLiveThread(state, { type: "replay_started", total: 2 });

    // Missed events replay from the acknowledged cursor (1) — as replayed.
    const missed = [
      messageEvent({
        sequence: 2,
        correlationId: "k2",
        kind: "agent",
        text: "missed reply one",
        occurredAt: "2026-09-30T10:05:00Z",
      }),
      messageEvent({
        sequence: 3,
        correlationId: "k3",
        text: "missed turn two",
        occurredAt: "2026-09-30T10:06:00Z",
      }),
    ];
    for (const event of missed) {
      state = advanceLiveThread(state, { type: "replay_event", event, mode: "reconnect" });
    }
    state = advanceLiveThread(state, { type: "replay_complete" });

    expect(state.phase).toBe("live");
    const visible = messagesOf(state);
    expect(visible.map((message) => message.klass)).toEqual(["live", "replayed", "replayed"]);
    // The §6.2 marker closes the batch: "2 missed events replayed".
    const boundary = assembleLiveTimeline(state).replayBoundary;
    expect(boundary).toEqual({ at: "2026-09-30T10:06:00Z", count: 2 });
    expect(state.cursor).toBe(3);

    // Live delivery resumes after the replay: a new turn lands as live.
    state = advanceLiveThread(state, {
      type: "live_event",
      event: messageEvent({
        sequence: 4,
        correlationId: "k4",
        occurredAt: "2026-09-30T10:07:00Z",
      }),
    });
    expect(messagesOf(state).at(-1)!.klass).toBe("live");
  });

  it("the initial load replays from cursor 0 as live history without a marker", () => {
    let state = advanceLiveThread(INITIAL_LIVE_STATE, { type: "reconnecting" });
    state = advanceLiveThread(state, { type: "replay_started", total: 2 });
    state = advanceLiveThread(state, {
      type: "replay_event",
      mode: "initial",
      event: {
        ...messageEvent({ sequence: 1, correlationId: "seed" }),
        type: "conversation.created",
        payload: { conversation_id: CONVERSATION, workspace_id: "ws_account-1", title: "GA" },
      },
    });
    state = advanceLiveThread(state, {
      type: "replay_event",
      mode: "initial",
      event: messageEvent({ sequence: 2, correlationId: "k2" }),
    });
    state = advanceLiveThread(state, { type: "replay_complete" });

    expect(state.phase).toBe("live");
    expect(state.cursor).toBe(2);
    // Initial history is NOT a reconnect batch: no replayed rows, no marker.
    expect(assembleLiveTimeline(state).replayBoundary).toBeNull();
    expect(messagesOf(state)).toEqual([{ id: "msg_2", delivery: "sent", klass: "live" }]);
  });
});
