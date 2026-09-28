/**
 * Events service tests (S07; AC2, AC3, E12).
 *
 * AC2: a state transition and its event append commit atomically — a forced
 * failure after the transition rolls back BOTH. AC3: per-stream sequences are
 * strictly monotonic and a duplicate event_id is an idempotent no-op that
 * returns the ORIGINAL event. E12: every path is workspace-scoped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ConversationsRepository,
  type ConversationRow,
} from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService, EventsServiceError } from "./events.service.ts";

const tempDirs: string[] = [];

function newService(): {
  service: EventsService;
  conversations: ConversationsRepository;
  journal: EventJournalRepository;
  tx: SqliteTransactions;
  conn: SqliteConnection;
} {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-events-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const conversations = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  return {
    service: new EventsService(journal, conversations, tx),
    conversations,
    journal,
    tx,
    conn,
  };
}

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("events service (AC2 — atomic transition + event append)", () => {
  it("commits the transition and its event together", () => {
    const { service, conversations, journal, conn } = newService();
    try {
      const outcome = service.createConversation({
        workspace_id: WS_A,
        title: "Operation kickoff",
        correlation_id: "corr-ac2-1",
      });
      expect(conversations.findById(WS_A, outcome.conversation.id, conn.db)).not.toBeNull();
      expect(journal.findById(WS_A, outcome.event.event_id, conn.db)).not.toBeNull();
      expect(outcome.conversation.revision).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("rolls back BOTH the transition and the event when a failure follows the transition (forced failure)", () => {
    const { conversations, journal, tx, conn } = newService();
    try {
      expect(() =>
        tx.transaction((exec) => {
          conversations.create(
            {
              id: "forced-rollback-1",
              workspace_id: WS_A,
              title: "about to disappear",
              revision: 1,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            exec,
          );
          journal.append(
            {
              stream_id: "conversation:forced-rollback-1",
              sequence: 1,
              event_id: "forced-rollback-event-1",
              event_type: "conversation.created",
              schema_version: 1,
              payload: JSON.stringify({
                conversation_id: "forced-rollback-1",
                workspace_id: WS_A,
                title: "about to disappear",
              }),
              workspace_id: WS_A,
              occurred_at: new Date().toISOString(),
              correlation_id: "corr-ac2-2",
            },
            exec,
          );
          // The failure happens AFTER both writes: nothing may survive.
          throw new Error("forced failure after the transition");
        }),
      ).toThrow("forced failure after the transition");

      expect(conversations.findById(WS_A, "forced-rollback-1", conn.db)).toBeNull();
      expect(journal.findById(WS_A, "forced-rollback-event-1", conn.db)).toBeNull();
      expect(journal.listStream("conversation:forced-rollback-1", WS_A, conn.db)).toEqual([]);
    } finally {
      conn.close();
    }
  });

  it("rolls back a rename transition when its event payload fails validation after the row update", () => {
    const { service, conversations, journal, conn } = newService();
    try {
      const created = service.createConversation({
        workspace_id: WS_A,
        title: "original title",
        correlation_id: "corr-ac2-3",
      });

      // 301-char title: the row update succeeds, then the event payload fails
      // schema validation inside the SAME transaction — both must roll back.
      const tooLong = "x".repeat(301);
      expect(() =>
        service.renameConversation({
          workspace_id: WS_A,
          conversation_id: created.conversation.id,
          title: tooLong,
          expected_revision: 1,
          correlation_id: "corr-ac2-4",
        }),
      ).toThrow(EventsServiceError);

      const unchanged: ConversationRow | null = conversations.findById(
        WS_A,
        created.conversation.id,
        conn.db,
      );
      expect(unchanged?.title).toBe("original title");
      expect(unchanged?.revision).toBe(1);
      expect(journal.countStream(`conversation:${created.conversation.id}`, WS_A, conn.db)).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe("events service (AC3 — monotonic sequences, idempotent event_id)", () => {
  it("allocates strictly monotonic per-stream sequences", () => {
    const { service, journal, conn } = newService();
    try {
      const created = service.createConversation({
        workspace_id: WS_A,
        title: "first",
        correlation_id: "corr-ac3-1",
      });
      const first = service.appendEvent({
        event_id: "seq-check-1",
        stream_id: `conversation:${created.conversation.id}`,
        type: "conversation.renamed",
        payload: {
          conversation_id: created.conversation.id,
          workspace_id: WS_A,
          title: "second",
          previous_revision: 1,
          new_revision: 2,
        },
        workspace_id: WS_A,
        correlation_id: "corr-ac3-1",
      });
      const second = service.appendEvent({
        event_id: "seq-check-2",
        stream_id: `conversation:${created.conversation.id}`,
        type: "conversation.renamed",
        payload: {
          conversation_id: created.conversation.id,
          workspace_id: WS_A,
          title: "third",
          previous_revision: 2,
          new_revision: 3,
        },
        workspace_id: WS_A,
        correlation_id: "corr-ac3-1",
      });

      const stream = journal.listStream(`conversation:${created.conversation.id}`, WS_A, conn.db);
      expect(stream.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(first.sequence).toBe(2);
      expect(second.sequence).toBe(3);
    } finally {
      conn.close();
    }
  });

  it("ignores a duplicate event_id and returns the original event unchanged", () => {
    const { service, journal, conn } = newService();
    try {
      const input = {
        event_id: "dup-event-1",
        stream_id: "conversation:dup-check",
        type: "conversation.created" as const,
        payload: {
          conversation_id: "dup-check",
          workspace_id: WS_A,
          title: "only once",
        },
        workspace_id: WS_A,
        correlation_id: "corr-ac3-2",
      };
      const first = service.appendEvent(input);
      const second = service.appendEvent(input);

      expect(second.event_id).toBe(first.event_id);
      expect(second.sequence).toBe(first.sequence);
      expect(second.occurred_at).toBe(first.occurred_at);
      expect(journal.countStream("conversation:dup-check", WS_A, conn.db)).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("rejects an unknown event type and an invalid payload with typed failures (G2)", () => {
    const { service } = newService();
    expect(() =>
      service.appendEvent({
        event_id: "unknown-type-1",
        stream_id: "conversation:unknown",
        // Deliberate unknown type outside the EVENT_TYPES registry.
        type: "conversation.teleported" as never,
        payload: {} as never,
        workspace_id: WS_A,
        correlation_id: "corr-g2-1",
      }),
    ).toThrow(/EVENT_UNKNOWN_TYPE/);

    expect(() =>
      service.appendEvent({
        event_id: "bad-payload-1",
        stream_id: "conversation:bad-payload",
        type: "conversation.created",
        payload: {
          conversation_id: "bad-payload",
          workspace_id: WS_A,
          title: "",
        },
        workspace_id: WS_A,
        correlation_id: "corr-g2-2",
      }),
    ).toThrow(/EVENT_PAYLOAD_INVALID/);
  });
});

describe("events service (E12/AC5 — workspace scoping)", () => {
  it("a foreign workspace can neither read nor write another workspace's rows", () => {
    const { service, conversations, journal, conn } = newService();
    try {
      const created = service.createConversation({
        workspace_id: WS_A,
        title: "workspace A private",
        correlation_id: "corr-e12-1",
      });

      expect(conversations.findById(WS_B, created.conversation.id, conn.db)).toBeNull();
      expect(conversations.list(WS_B, conn.db)).toEqual([]);
      expect(journal.findById(WS_B, created.event.event_id, conn.db)).toBeNull();
      expect(journal.listStream(`conversation:${created.conversation.id}`, WS_B, conn.db)).toEqual(
        [],
      );

      expect(() =>
        service.renameConversation({
          workspace_id: WS_B,
          conversation_id: created.conversation.id,
          title: "cross-tenant takeover",
          expected_revision: 1,
          correlation_id: "corr-e12-2",
        }),
      ).toThrow(/CONVERSATION_NOT_FOUND/);

      // The same conversation id in workspace B is an independent row.
      const twin = service.createConversation({
        workspace_id: WS_B,
        conversation_id: created.conversation.id,
        title: "workspace B twin",
        correlation_id: "corr-e12-3",
      });
      expect(twin.conversation.workspace_id).toBe(WS_B);
      expect(conversations.findById(WS_A, created.conversation.id, conn.db)?.title).toBe(
        "workspace A private",
      );
    } finally {
      conn.close();
    }
  });
});
