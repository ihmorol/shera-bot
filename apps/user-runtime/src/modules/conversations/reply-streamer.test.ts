/**
 * ScriptedReplyStreamer tests (S09 chunk 2) — the deterministic reply producer
 * for the mock/E2E path, and the G2/D34 regression at the FULL composed
 * runtime level: a conversation turn produces transient deltas + ONE durable
 * agent reply and NEVER a task run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { conversationStreamFor, type ConversationEvent } from "./conversations.events.ts";
import { ConversationsService } from "./conversations.service.ts";
import {
  ScriptedReplyStreamer,
  DEFAULT_SCRIPTED_REPLY,
  MESSAGE_DELTA_FRAME,
  splitReplyChunks,
  type MessageDeltaFrame,
} from "./reply-streamer.ts";

const tempDirs: string[] = [];
const WS_A = "ws-11111111-1111-4111-8111-111111111111";

interface SteppedTimer {
  fn: () => void;
  cancelled: boolean;
}

interface Harness {
  service: ConversationsService;
  journal: EventJournalRepository;
  receipts: CommandReceiptsRepository;
  frames: Array<{ workspace_id: string; stream_id: string; payload: unknown }>;
  streamer: ScriptedReplyStreamer;
  /** Run every live scheduled callback once (one "interval tick"). */
  tick(): void;
}

function newHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-reply-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const conversations = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);
  const frames: Harness["frames"] = [];
  const service = new ConversationsService({ journal: events, conversations, receipts, tx });

  // A stepped scheduler: tests drive the interval ticks manually, so the
  // scripted stream is fully deterministic (no real timers).
  const timers: SteppedTimer[] = [];

  const streamer = new ScriptedReplyStreamer({
    conversations: service,
    broadcastFrame: (workspace_id, stream_id, payload) =>
      frames.push({ workspace_id, stream_id, payload }),
    options: DEFAULT_SCRIPTED_REPLY,
    schedule: (fn) => {
      const timer: SteppedTimer = { fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  return {
    service,
    journal,
    receipts,
    frames,
    streamer,
    tick() {
      for (const timer of [...timers]) {
        if (!timer.cancelled) {
          timer.fn();
        }
      }
    },
  };
}

function createConversation(h: Harness): string {
  const created = h.service.executeCommand({
    type: "conversation.create",
    workspace_id: WS_A,
    idempotency_key: `idem-create-${Math.random().toString(36).slice(2)}`,
    payload: { title: "General Assistant" },
  });
  return created.conversation_id;
}

function sendUserMessage(h: Harness, conversationId: string, text = "Outline a plan, please.") {
  return h.service.executeCommand({
    type: "message.send",
    workspace_id: WS_A,
    idempotency_key: `idem-user-${Math.random().toString(36).slice(2)}`,
    payload: {
      conversation_id: conversationId,
      text,
      sender: { kind: "user", display_name: "Emon" },
    },
  });
}

function userEventOf(h: Harness, conversationId: string): ConversationEvent {
  const row = h.journal
    .listStream(conversationStreamFor(conversationId), WS_A)
    .find((candidate) => candidate.event_type === "message.appended")!;
  return {
    event_id: row.event_id,
    stream_id: row.stream_id,
    sequence: row.sequence,
    type: "message.appended",
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload),
    workspace_id: row.workspace_id,
    occurred_at: row.occurred_at,
    correlation_id: row.correlation_id,
  };
}

function agentMessagesOf(h: Harness, conversationId: string) {
  return h.journal
    .listStream(conversationStreamFor(conversationId), WS_A)
    .filter((row) => row.event_type === "message.appended")
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => (payload["sender"] as Record<string, string>)["kind"] === "agent");
}

afterAll(async () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ScriptedReplyStreamer (stepped timers — fully deterministic)", () => {
  it("streams transient deltas, then lands ONE durable agent reply via the command path", () => {
    const h = newHarness();
    const conversationId = createConversation(h);
    sendUserMessage(h, conversationId);
    const userEvent = userEventOf(h, conversationId);

    h.streamer.handleCommittedEvent(userEvent);

    // One frame per word-chunk tick, then the durable reply on the closing tick.
    const chunkCount = splitReplyChunks(DEFAULT_SCRIPTED_REPLY.replyText).length;
    for (let tick = 0; tick < chunkCount; tick += 1) {
      h.tick();
      expect(h.frames.length).toBe(tick + 1);
    }
    const deltas = h.frames.map((frame) => frame.payload as MessageDeltaFrame);
    expect(deltas.every((delta) => delta.frame === MESSAGE_DELTA_FRAME)).toBe(true);
    expect(deltas.every((delta) => delta.stream_key === `reply-${userEvent.event_id}`)).toBe(true);
    // Deltas concatenate byte-stably to the scripted reply text.
    expect(deltas.map((delta) => delta.text_delta).join("")).toBe(DEFAULT_SCRIPTED_REPLY.replyText);
    // Every frame went to the conversation's own stream room.
    expect(
      h.frames.every((frame) => frame.stream_id === conversationStreamFor(conversationId)),
    ).toBe(true);

    h.tick(); // the closing tick appends the durable reply

    const agentMessages = agentMessagesOf(h, conversationId);
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toMatchObject({
      sender: { kind: "agent", agent_id: DEFAULT_SCRIPTED_REPLY.agentId },
      text: DEFAULT_SCRIPTED_REPLY.replyText,
    });
    // The reply's receipt exists and replays idempotently.
    expect(h.receipts.findById(WS_A, `reply-${userEvent.event_id}`)).not.toBeNull();
    // After the reply lands, no further frames are emitted.
    const frameCount = h.frames.length;
    h.tick();
    expect(h.frames.length).toBe(frameCount);

    // G2/D34: no task streams, no task events, anywhere in the journal.
    const streams = h.journal.listWorkspaceStreams(WS_A);
    expect(streams.every((streamId) => streamId.startsWith("conversation:"))).toBe(true);
    for (const streamId of streams) {
      for (const row of h.journal.listStream(streamId, WS_A)) {
        expect(row.event_type.startsWith("task.")).toBe(false);
      }
    }
  });

  it("never reacts to its own agent replies and ignores non-message events", () => {
    const h = newHarness();
    const conversationId = createConversation(h);
    sendUserMessage(h, conversationId);

    const userRow = h.journal
      .listStream(conversationStreamFor(conversationId), WS_A)
      .find((row) => row.event_type === "message.appended")!;
    const userPayload = JSON.parse(userRow.payload) as Record<string, unknown>;
    const agentEvent = {
      event_id: userRow.event_id,
      stream_id: userRow.stream_id,
      sequence: userRow.sequence,
      type: "message.appended",
      schema_version: 1,
      payload: {
        ...userPayload,
        sender: { kind: "agent", agent_id: DEFAULT_SCRIPTED_REPLY.agentId },
      },
      workspace_id: WS_A,
      occurred_at: userRow.occurred_at,
      correlation_id: userRow.correlation_id,
    } as ConversationEvent;

    h.streamer.handleCommittedEvent(agentEvent);
    h.streamer.handleCommittedEvent({
      event_id: "evt_created",
      stream_id: "conversation:conv_x",
      sequence: 1,
      type: "conversation.created",
      schema_version: 1,
      payload: { conversation_id: "conv_x", workspace_id: WS_A, title: "T" },
      workspace_id: WS_A,
      occurred_at: "2026-09-30T00:00:00.000Z",
      correlation_id: "corr",
    });
    h.tick();
    h.tick();

    expect(h.frames).toHaveLength(0);
    expect(agentMessagesOf(h, conversationId)).toHaveLength(0);
  });

  it("a redelivered user event never duplicates the reply stream", () => {
    const h = newHarness();
    const conversationId = createConversation(h);
    sendUserMessage(h, conversationId);
    const userEvent = userEventOf(h, conversationId);

    h.streamer.handleCommittedEvent(userEvent);
    h.streamer.handleCommittedEvent(userEvent); // redelivery of the same hook

    const chunkCount = splitReplyChunks(DEFAULT_SCRIPTED_REPLY.replyText).length;
    for (let tick = 0; tick <= chunkCount; tick += 1) {
      h.tick();
    }
    // Exactly one frame per chunk (not doubled) and exactly one reply.
    expect(h.frames.length).toBe(chunkCount);
    expect(agentMessagesOf(h, conversationId)).toHaveLength(1);
  });
});

describe("compose-level scripted replies (full runtime, real HTTP + real timers)", () => {
  it("a turn over HTTP produces a durable reply and never a task event on the stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-runtime-reply-compose-"));
    tempDirs.push(dir);
    const { composeRuntime, DEFAULT_WORKSPACE_ID } =
      await import("../../transport/local-api/compose.ts");
    const composed = composeRuntime({
      dbPath: join(dir, "runtime.db"),
      workspaceId: DEFAULT_WORKSPACE_ID,
      scriptedReplies: { ...DEFAULT_SCRIPTED_REPLY, deltaIntervalMs: 5 },
    });
    const server: Server = createServer(composed.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const post = async (body: unknown) =>
      (
        await fetch(`${origin}/v1/conversations/commands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json() as Promise<Record<string, unknown>>;

    const readEvents = async (conversationId: string) => {
      const response = await fetch(
        `${origin}/v1/conversations/${conversationId}/events?workspace_id=${DEFAULT_WORKSPACE_ID}&last_acknowledged_sequence=0`,
      );
      return (await response.json()) as {
        kind: string;
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      };
    };

    try {
      const created = (await post({
        type: "conversation.create",
        workspace_id: DEFAULT_WORKSPACE_ID,
        idempotency_key: "reply-compose-seed-1",
        payload: { title: "General Assistant" },
      })) as { conversation_id: string };
      const conversationId = created.conversation_id;

      await post({
        type: "message.send",
        workspace_id: DEFAULT_WORKSPACE_ID,
        idempotency_key: "reply-compose-msg-1",
        payload: {
          conversation_id: conversationId,
          text: "Plan my week, please.",
          sender: { kind: "user", display_name: "Emon" },
        },
      });

      // Poll the replay endpoint (the same surface the client reads) until the
      // scripted reply lands, bounded by a generous deadline.
      const deadline = Date.now() + 5000;
      let agentMessage: { type: string; payload: Record<string, unknown> } | undefined;
      while (Date.now() < deadline) {
        const replay = await readEvents(conversationId);
        agentMessage = replay.events.find(
          (event) =>
            event.type === "message.appended" &&
            (event.payload["sender"] as Record<string, string>)["kind"] === "agent",
        );
        if (agentMessage) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(agentMessage).toBeDefined();
      expect((agentMessage!.payload["sender"] as Record<string, string>)["agent_id"]).toBe(
        DEFAULT_SCRIPTED_REPLY.agentId,
      );
      expect(agentMessage!.payload["text"]).toBe(DEFAULT_SCRIPTED_REPLY.replyText);

      // G2/D34 at the composed level: the conversation stream carries only
      // conversation lifecycle + message events — never task events.
      const replay = await readEvents(conversationId);
      expect(replay.events.every((event) => !event.type.startsWith("task."))).toBe(true);
    } finally {
      await composed.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
