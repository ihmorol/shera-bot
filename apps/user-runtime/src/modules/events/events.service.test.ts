/**
 * Events (journal) service tests (S07; AC3, G2).
 *
 * Aggregate transition tests live with their module (modules/conversations);
 * here the JOURNAL behavior is under test: strictly monotonic per-stream
 * sequences, idempotent duplicate event_id, typed validation failures, and
 * workspace-scoped stream allocation.
 */
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService, EventsServiceError } from "./events.service.ts";
import type { AppendEventInput } from "./events.types.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

function newService(): {
  service: EventsService;
  journal: EventJournalRepository;
  tx: SqliteTransactions;
  conn: SqliteConnection;
} {
  // The connection is tracked so its handle (and the WAL sidecars it owns) is
  // released before cleanup deletes the directory — Windows locks open files,
  // so an unclosed handle made rmSync throw EPERM and failed this suite on a
  // platform where every assertion had actually passed.
  const dir = makeTempDir("shera-runtime-events-");
  const conn = trackConnection(openDatabase(join(dir, "runtime.db")));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  return { service: new EventsService(journal, tx), journal, tx, conn };
}

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

function createdEvent(overrides: Partial<AppendEventInput<"conversation.created">> = {}) {
  return {
    event_id: overrides.event_id ?? `evt-${Math.random().toString(36).slice(2)}`,
    stream_id: overrides.stream_id ?? "conversation:journal-check",
    type: "conversation.created" as const,
    payload: {
      conversation_id: "journal-check",
      workspace_id: WS_A,
      title: "journal flow",
      ...(overrides.payload ?? {}),
    },
    workspace_id: WS_A,
    correlation_id: "corr-journal",
    ...overrides,
  };
}

// Releases every tracked handle, then deletes every tracked temp directory
// (retrying Windows' short-lived locks). Individual tests still close their own
// connection in `finally` so a failing test cannot leak into the next one.
afterAll(async () => {
  await cleanupTempResources();
});

describe("events journal service (AC3 — monotonic sequences, idempotent event_id)", () => {
  it("allocates strictly monotonic per-stream sequences, scoped to the workspace", () => {
    const { service, journal, conn } = newService();
    try {
      const first = service.appendEvent(createdEvent({ event_id: "seq-1" }));
      const second = service.appendEvent(createdEvent({ event_id: "seq-2" }));
      const third = service.appendEvent(createdEvent({ event_id: "seq-3" }));

      const stream = journal.listStream("conversation:journal-check", WS_A, conn.db);
      expect(stream.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(first.sequence).toBe(1);
      expect(second.sequence).toBe(2);
      expect(third.sequence).toBe(3);
    } finally {
      conn.close();
    }
  });

  it("allocates the same stream independently per workspace (journal PK is workspace-scoped)", () => {
    const { service, journal, conn } = newService();
    try {
      service.appendEvent(createdEvent({ event_id: "ws-a-1" }));
      service.appendEvent(createdEvent({ event_id: "ws-a-2" }));
      const twinFirst = service.appendEvent(
        createdEvent({ event_id: "ws-b-1", workspace_id: WS_B }),
      );
      // The same stream id in workspace B starts its own sequence space.
      expect(twinFirst.sequence).toBe(1);
      expect(journal.countStream("conversation:journal-check", WS_A, conn.db)).toBe(2);
      expect(journal.countStream("conversation:journal-check", WS_B, conn.db)).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("ignores a duplicate event_id and returns the original event unchanged", () => {
    const { service, journal, conn } = newService();
    try {
      const input = createdEvent({ event_id: "dup-event-1" });
      const first = service.appendEvent(input);
      const second = service.appendEvent(input);

      expect(second.event_id).toBe(first.event_id);
      expect(second.sequence).toBe(first.sequence);
      expect(second.occurred_at).toBe(first.occurred_at);
      expect(journal.countStream("conversation:journal-check", WS_A, conn.db)).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("treats the same event_id in two workspaces as independent rows (UNIQUE is workspace-scoped, C-3)", () => {
    const { service, journal, conn } = newService();
    try {
      const inA = service.appendEvent(createdEvent({ event_id: "shared-event-1" }));
      const inB = service.appendEvent(
        createdEvent({ event_id: "shared-event-1", workspace_id: WS_B }),
      );

      // Both rows exist — one per workspace, each with its own stream
      // sequence space (the row column is the scoping authority, E12).
      expect(inA.sequence).toBe(1);
      expect(inB.sequence).toBe(1);
      expect(journal.findById(WS_A, "shared-event-1", conn.db)?.workspace_id).toBe(WS_A);
      expect(journal.findById(WS_B, "shared-event-1", conn.db)?.workspace_id).toBe(WS_B);
      expect(journal.countStream("conversation:journal-check", WS_A, conn.db)).toBe(1);
      expect(journal.countStream("conversation:journal-check", WS_B, conn.db)).toBe(1);

      // The idempotent no-op stays scoped: repeating in A returns A's
      // original and leaves B's row untouched.
      const repeat = service.appendEvent(createdEvent({ event_id: "shared-event-1" }));
      expect(repeat.event_id).toBe(inA.event_id);
      expect(repeat.workspace_id).toBe(WS_A);
      expect(journal.countStream("conversation:journal-check", WS_B, conn.db)).toBe(1);
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

  it("surfaces typed failures as EventsServiceError instances", () => {
    const { service } = newService();
    try {
      service.appendEvent({
        event_id: "typed-err-1",
        stream_id: "conversation:typed-err",
        type: "conversation.created",
        payload: { conversation_id: "typed-err", workspace_id: WS_A, title: "" },
        workspace_id: WS_A,
        correlation_id: "corr-g2-3",
      });
      expect.unreachable("invalid payload must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EventsServiceError);
      expect((error as EventsServiceError).code).toBe("EVENT_PAYLOAD_INVALID");
      expect((error as EventsServiceError).category).toBe("validation");
    }
  });
});
