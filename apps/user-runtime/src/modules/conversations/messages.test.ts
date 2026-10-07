/**
 * Message send tests (S09 chunk 2; D26, D23 rule 6, G2/D34 regression).
 *
 * A conversation turn is an idempotent typed command that APPENDS to the
 * conversation's stream — nothing more. The receipt replays the same message
 * forever (double-send → exactly one durable message, asserted at the
 * DATABASE level), and a plain conversation turn creates NO task run: no
 * task.* events, no task streams, anywhere in the journal (G2/D34 — Agents
 * propose, the runtime executes; a user chat message is neither).
 */
import { join } from "node:path";

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
import { rebuildConversationProjections } from "./conversations.projection.ts";
import type { ConversationCommand } from "./conversations.types.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const KEY = "idem-msg-send-1";

interface Harness {
  service: ConversationsService;
  journal: EventJournalRepository;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  published: ConversationEvent[];
}

function newHarness(): Harness {
  // Tracked so the connection handle is closed before cleanup deletes the
  // directory: on Windows an open DatabaseSync (plus its WAL sidecars) locks the
  // tree and rmSync throws EPERM — which failed this suite on Windows even
  // though every assertion passed.
  const dir = makeTempDir("shera-runtime-messages-");
  const conn = trackConnection(openDatabase(join(dir, "runtime.db")));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const conversations = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);
  const published: ConversationEvent[] = [];
  const service = new ConversationsService({
    journal: events,
    conversations,
    receipts,
    tx,
    publish: (event) => published.push(event),
  });
  return { service, journal, receipts, tx, published };
}

function createConversation(service: ConversationsService): string {
  const created = service.executeCommand({
    type: "conversation.create",
    workspace_id: WS_A,
    idempotency_key: `idem-create-${Math.random().toString(36).slice(2)}`,
    payload: { title: "General Assistant" },
  });
  return created.conversation_id;
}

function sendCommand(conversationId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message.send",
    workspace_id: WS_A,
    idempotency_key: KEY,
    payload: {
      conversation_id: conversationId,
      text: "Morning — can you outline a plan for my thesis chapter?",
      sender: { kind: "user", display_name: "Emon" },
    },
    ...overrides,
  } as const;
}

// Closes every tracked handle, then removes every tracked temp directory.
afterAll(async () => {
  await cleanupTempResources();
});

describe("message.send (D26: one idempotent command per turn)", () => {
  it("appends exactly one durable message event and returns the identity", () => {
    const h = newHarness();
    const conversationId = createConversation(h.service);

    const result = h.service.executeCommand(
      sendCommand(conversationId) as unknown as ConversationCommand,
    );
    expect(result).toMatchObject({
      kind: "message_sent",
      conversation_id: conversationId,
      revision: 1,
    });

    const rows = h.journal.listStream(conversationStreamFor(conversationId), WS_A);
    expect(rows).toHaveLength(2);
    const message = rows.find((row) => row.event_type === "message.appended");
    expect(message).toBeDefined();
    const payload = JSON.parse(message!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      conversation_id: conversationId,
      workspace_id: WS_A,
      message_id: result.kind === "message_sent" ? result.message_id : "",
      sender: { kind: "user", display_name: "Emon" },
      text: "Morning — can you outline a plan for my thesis chapter?",
    });
    // The correlation id IS the idempotency key — the client's dedupe identity.
    expect(message!.correlation_id).toBe(KEY);
    // Fanout fired after commit for the message event.
    expect(h.published.some((event) => event.type === "message.appended")).toBe(true);
  });

  it("a repeated idempotency key replays the receipt — one message at the DATABASE level", () => {
    const h = newHarness();
    const conversationId = createConversation(h.service);
    const first = h.service.executeCommand(
      sendCommand(conversationId) as unknown as ConversationCommand,
    );
    const second = h.service.executeCommand(
      sendCommand(conversationId) as unknown as ConversationCommand,
    );

    expect(second).toEqual(first);
    // DB assertions: one message row, one receipt row — no duplicates anywhere.
    const rows = h.journal.listStream(conversationStreamFor(conversationId), WS_A);
    expect(rows.filter((row) => row.event_type === "message.appended")).toHaveLength(1);
    expect(h.receipts.findById(WS_A, KEY)).not.toBeNull();
    const streamRows = h.journal.listStream(conversationStreamFor(conversationId), WS_A);
    expect(streamRows).toHaveLength(2);
    // No second fanout for the replayed receipt.
    expect(h.published.filter((event) => event.type === "message.appended")).toHaveLength(1);
  });

  it("a different idempotency key appends a second real message", () => {
    const h = newHarness();
    const conversationId = createConversation(h.service);
    h.service.executeCommand(sendCommand(conversationId) as unknown as ConversationCommand);
    h.service.executeCommand(
      sendCommand(conversationId, {
        idempotency_key: "idem-msg-send-2",
      }) as unknown as ConversationCommand,
    );
    const rows = h.journal.listStream(conversationStreamFor(conversationId), WS_A);
    expect(rows.filter((row) => row.event_type === "message.appended")).toHaveLength(2);
  });

  it("rejects a send to an unknown conversation with a typed state error and no effects", () => {
    const h = newHarness();
    expect(() =>
      h.service.executeCommand(sendCommand("conv_missing") as unknown as ConversationCommand),
    ).toThrowError(/CONVERSATION_NOT_FOUND/);
    expect(h.journal.listWorkspaceStreams(WS_A)).toHaveLength(0);
    expect(h.receipts.findById(WS_A, KEY)).toBeNull();
  });

  it("leaves the conversation aggregate untouched and rebuildable (projection fold)", () => {
    const h = newHarness();
    const conversationId = createConversation(h.service);
    h.service.executeCommand(sendCommand(conversationId) as unknown as ConversationCommand);
    h.service.executeCommand(
      sendCommand(conversationId, {
        idempotency_key: "idem-msg-send-3",
      }) as unknown as ConversationCommand,
    );

    const projections = rebuildConversationProjections(WS_A, h.journal);
    expect(projections.get(conversationId)).toEqual({
      id: conversationId,
      workspace_id: WS_A,
      title: "General Assistant",
      revision: 1,
    });
  });
});

describe("G2/D34 regression: a plain conversation turn is not a task run", () => {
  it("creates NO task.* events and NO task streams anywhere in the journal", () => {
    const h = newHarness();
    const conversationId = createConversation(h.service);
    h.service.executeCommand(sendCommand(conversationId) as unknown as ConversationCommand);
    h.service.executeCommand(
      sendCommand(conversationId, {
        idempotency_key: "idem-msg-send-4",
      }) as unknown as ConversationCommand,
    );

    const streams = h.journal.listWorkspaceStreams(WS_A);
    // Only the conversation stream exists — no task:<id> streams at all.
    expect(streams.every((streamId) => streamId.startsWith("conversation:"))).toBe(true);
    for (const streamId of streams) {
      for (const row of h.journal.listStream(streamId, WS_A)) {
        expect(row.event_type.startsWith("task.")).toBe(false);
      }
    }
  });
});
