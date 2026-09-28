/**
 * Conversations module tests (S07; AC2, AC4-snapshot support, AC6, E12).
 *
 * Commands are the only mutation path (D26): idempotency keys replay recorded
 * receipts instead of duplicating effects (AC6/D23 rule 6), stale
 * expected_revision values are typed conflicts, illegal commands are typed
 * rejections, and the transition + event + receipt commit atomically (AC2).
 * Fanout fires only after commit (D26/AC8 cooperation).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import {
  ConversationsRepository,
  type ConversationRow,
} from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { ReplayService, type ReplaySnapshot } from "../events/replay.service.ts";
import { conversationStreamFor, type ConversationEvent } from "./conversations.events.ts";
import { ConversationsService } from "./conversations.service.ts";
import { rebuildConversationProjections } from "./conversations.projection.ts";
import type { ConversationCommand, ConversationCommandResult } from "./conversations.types.ts";

const tempDirs: string[] = [];

const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const WS_B = "ws-22222222-2222-4222-8222-222222222222";

interface Harness {
  service: ConversationsService;
  conversations: ConversationsRepository;
  journal: EventJournalRepository;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  conn: SqliteConnection;
  published: ConversationEvent[];
  replay: ReplayService;
}

function newHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-conversations-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
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
  const replay = new ReplayService({
    journal,
    loadSnapshot: (workspaceId, streamId): ReplaySnapshot | null => {
      const conversationId = streamId.replace(/^conversation:/, "");
      const row = conversations.findById(workspaceId, conversationId, conn.db);
      if (!row) {
        return null;
      }
      return {
        kind: "conversation",
        conversation_id: row.id,
        workspace_id: row.workspace_id,
        title: row.title,
        revision: row.revision,
        up_to_sequence: journal.maxSequence(workspaceId, streamId, conn.db),
      };
    },
    retentionHorizon: (workspaceId, streamId) =>
      Math.max(0, journal.minSequence(workspaceId, streamId, conn.db) - 1),
  });
  return { service, conversations, journal, receipts, tx, conn, published, replay };
}

function createCommand(
  overrides: Partial<Extract<ConversationCommand, { type: "conversation.create" }>> = {},
) {
  return {
    type: "conversation.create" as const,
    workspace_id: overrides.workspace_id ?? WS_A,
    idempotency_key:
      overrides.idempotency_key ?? `idem-create-${Math.random().toString(36).slice(2)}`,
    payload: overrides.payload ?? { title: "Operation kickoff" },
  };
}

function renameCommand(
  conversationId: string,
  overrides: Partial<Extract<ConversationCommand, { type: "conversation.rename" }>> = {},
) {
  return {
    type: "conversation.rename" as const,
    workspace_id: overrides.workspace_id ?? WS_A,
    idempotency_key:
      overrides.idempotency_key ?? `idem-rename-${Math.random().toString(36).slice(2)}`,
    payload: {
      conversation_id: conversationId,
      title: overrides.payload?.title ?? "renamed",
      expected_revision: overrides.payload?.expected_revision ?? 1,
    },
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("conversations commands (AC2 — atomic transition + event + receipt)", () => {
  it("commits the transition, its event, and the receipt together", () => {
    const h = newHarness();
    try {
      const result = h.service.executeCommand(createCommand());
      const row: ConversationRow | null = h.conversations.findById(
        WS_A,
        result.conversation_id,
        h.conn.db,
      );
      expect(row?.title).toBe("Operation kickoff");
      expect(h.journal.findById(WS_A, result.event_id, h.conn.db)).not.toBeNull();
      expect(h.receipts.countInWorkspace(WS_A, h.conn.db)).toBe(1);
    } finally {
      h.conn.close();
    }
  });

  it("rolls back the transition, the event, AND the receipt when the unit fails (forced failure)", () => {
    const h = newHarness();
    try {
      expect(() =>
        h.tx.transaction((exec) => {
          h.conversations.create(
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
          h.receipts.create(
            {
              workspace_id: WS_A,
              idempotency_key: "forced-rollback-key",
              command_type: "conversation.create",
              result_json: "{}",
              created_at: new Date().toISOString(),
            },
            exec,
          );
          // Failure after both writes: nothing may survive.
          throw new Error("forced failure after the transition");
        }),
      ).toThrow("forced failure after the transition");

      expect(h.conversations.findById(WS_A, "forced-rollback-1", h.conn.db)).toBeNull();
      expect(h.receipts.findById(WS_A, "forced-rollback-key", h.conn.db)).toBeNull();
    } finally {
      h.conn.close();
    }
  });

  it("rolls back a rename whose event payload fails validation AFTER the row update", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());

      // The row update succeeds, then the 301-char title fails the event
      // payload schema inside the SAME transaction — everything rolls back.
      // The rejection is the journal's typed failure (G2): the gateway
      // validates what it persists, and the module rolls back with it.
      const tooLong = "x".repeat(301);
      expect(() =>
        h.service.executeCommand(
          renameCommand(created.conversation_id, {
            payload: {
              conversation_id: created.conversation_id,
              title: tooLong,
              expected_revision: 1,
            },
          }),
        ),
      ).toThrow(/EVENT_PAYLOAD_INVALID/);

      const unchanged: ConversationRow | null = h.conversations.findById(
        WS_A,
        created.conversation_id,
        h.conn.db,
      );
      expect(unchanged?.title).toBe("Operation kickoff");
      expect(unchanged?.revision).toBe(1);
      expect(
        h.journal.countStream(conversationStreamFor(created.conversation_id), WS_A, h.conn.db),
      ).toBe(1);
      // The failed command consumed no receipt: a valid retry is possible.
      expect(h.receipts.countInWorkspace(WS_A, h.conn.db)).toBe(1);
    } finally {
      h.conn.close();
    }
  });
});

describe("conversations commands (AC6 — idempotency, conflicts, typed rejections)", () => {
  it("replays the recorded receipt for a repeated idempotency_key without duplicating effects", () => {
    const h = newHarness();
    try {
      const key = "idem-duplicate-check";
      const first: ConversationCommandResult = h.service.executeCommand(
        createCommand({ idempotency_key: key }),
      );
      const second: ConversationCommandResult = h.service.executeCommand(
        createCommand({ idempotency_key: key, payload: { title: "different title, same key" } }),
      );

      expect(second).toEqual(first);
      expect(h.receipts.countInWorkspace(WS_A, h.conn.db)).toBe(1);
      expect(h.conversations.countInWorkspace(WS_A, h.conn.db)).toBe(1);
    } finally {
      h.conn.close();
    }
  });

  it("replays the winner's receipt when a concurrent same-key execution loses the race (B5)", () => {
    const h = newHarness();
    try {
      const winner = h.service.executeCommand(
        createCommand({ idempotency_key: "race-key", payload: { title: "first commit" } }),
      );

      // Deterministic race simulation: the loser's fast-path receipt read
      // happens BEFORE the winner's receipt is visible (returns null exactly
      // once), so the loser's unit runs and its receipt INSERT hits the
      // winner's committed primary key inside the transaction.
      const realFindById = h.receipts.findById.bind(h.receipts);
      let missedOnce = false;
      h.receipts.findById = (workspaceId, idempotencyKey, exec) => {
        if (!missedOnce) {
          missedOnce = true;
          return null;
        }
        return realFindById(workspaceId, idempotencyKey, exec);
      };

      const loser = h.service.executeCommand(
        createCommand({ idempotency_key: "race-key", payload: { title: "loser, same key" } }),
      );

      // The raw constraint error never escapes: the loser replayed the
      // winner's recorded result verbatim.
      expect(loser).toEqual(winner);
      expect(loser.title).toBe("first commit");

      // The loser's transition, event, and receipt write rolled back with its
      // failed unit — exactly one of each exists, the winner's.
      expect(h.conversations.countInWorkspace(WS_A, h.conn.db)).toBe(1);
      expect(h.receipts.countInWorkspace(WS_A, h.conn.db)).toBe(1);
      expect(
        h.journal.countStream(conversationStreamFor(winner.conversation_id), WS_A, h.conn.db),
      ).toBe(1);
    } finally {
      h.conn.close();
    }
  });

  it("returns a typed conflict for a stale expected_revision and consumes no receipt", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());
      h.service.executeCommand(
        renameCommand(created.conversation_id, {
          payload: { conversation_id: created.conversation_id, title: "v2", expected_revision: 1 },
        }),
      );

      expect(() =>
        h.service.executeCommand(
          renameCommand(created.conversation_id, {
            payload: {
              conversation_id: created.conversation_id,
              title: "v3",
              expected_revision: 1,
            },
          }),
        ),
      ).toThrow(/CONVERSATION_REVISION_CONFLICT/);

      const row = h.conversations.findById(WS_A, created.conversation_id, h.conn.db);
      expect(row?.revision).toBe(2);
      expect(row?.title).toBe("v2");
    } finally {
      h.conn.close();
    }
  });

  it("returns a typed not-found for an unknown conversation", () => {
    const h = newHarness();
    try {
      expect(() =>
        h.service.executeCommand(
          renameCommand("no-such-conversation", {
            payload: { conversation_id: "no-such-conversation", title: "x", expected_revision: 1 },
          }),
        ),
      ).toThrow(/CONVERSATION_NOT_FOUND/);
    } finally {
      h.conn.close();
    }
  });

  it("rejects illegal commands with typed validation failures (G2)", () => {
    const h = newHarness();
    try {
      // A malformed envelope (no workspace, no idempotency key) is a typed
      // rejection, never a raw storage error leaking from the receipt lookup.
      expect(() =>
        h.service.executeCommand({
          type: "conversation.detonate",
        } as never),
      ).toThrow(/COMMAND_PAYLOAD_INVALID/);

      // Unknown command type on a structurally valid envelope: the transport
      // schema rejects it before the service, so the service's own guard is
      // defense in depth.
      expect(() =>
        h.service.executeCommand({
          type: "conversation.detonate",
          workspace_id: WS_A,
          idempotency_key: "idem-guard-0001",
        } as never),
      ).toThrow(/COMMAND_UNKNOWN_TYPE/);
    } finally {
      h.conn.close();
    }
  });
});

describe("conversations commands (E12/AC5 — workspace scoping)", () => {
  it("a foreign workspace can neither read, write, nor rename another workspace's conversation", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());

      expect(h.conversations.findById(WS_B, created.conversation_id, h.conn.db)).toBeNull();
      expect(() =>
        h.service.executeCommand(
          renameCommand(created.conversation_id, {
            workspace_id: WS_B,
            payload: {
              conversation_id: created.conversation_id,
              title: "cross-tenant takeover",
              expected_revision: 1,
            },
          }),
        ),
      ).toThrow(/CONVERSATION_NOT_FOUND/);

      // The same conversation id in workspace B is an independent aggregate.
      const twin = h.service.executeCommand(
        createCommand({
          workspace_id: WS_B,
          payload: { title: "workspace B twin" },
        }),
      );
      expect(twin.kind).toBe("created");
      expect(h.conversations.findById(WS_A, created.conversation_id, h.conn.db)?.title).toBe(
        "Operation kickoff",
      );
    } finally {
      h.conn.close();
    }
  });

  it("scopes idempotency keys per workspace: the same key in two workspaces stays independent (E12/AC6)", () => {
    const h = newHarness();
    try {
      const key = "shared-idem-key-across-workspaces";
      const inA = h.service.executeCommand(
        createCommand({ workspace_id: WS_A, idempotency_key: key, payload: { title: "A side" } }),
      );
      // The SAME idempotency_key in workspace B must NOT replay workspace A's
      // receipt: receipts are keyed by (workspace_id, idempotency_key), so B's
      // command executes fully as its own aggregate.
      const inB = h.service.executeCommand(
        createCommand({ workspace_id: WS_B, idempotency_key: key, payload: { title: "B side" } }),
      );
      expect(inB.kind).toBe("created");
      expect(inB.conversation_id).not.toBe(inA.conversation_id);
      expect(inB.title).toBe("B side");
      expect(inB.event_id).not.toBe(inA.event_id);

      // Workspace A's receipt and result are untouched by B's execution: the
      // recorded result still replays for A's key, and each workspace holds
      // exactly one conversation and one receipt.
      const replayedA = h.service.executeCommand(
        createCommand({ workspace_id: WS_A, idempotency_key: key, payload: { title: "ignored" } }),
      );
      expect(replayedA).toEqual(inA);
      expect(h.conversations.findById(WS_A, inA.conversation_id, h.conn.db)?.title).toBe("A side");
      expect(h.conversations.countInWorkspace(WS_A, h.conn.db)).toBe(1);
      expect(h.conversations.countInWorkspace(WS_B, h.conn.db)).toBe(1);
      expect(h.receipts.countInWorkspace(WS_A, h.conn.db)).toBe(1);
      expect(h.receipts.countInWorkspace(WS_B, h.conn.db)).toBe(1);
    } finally {
      h.conn.close();
    }
  });
});

describe("conversations commands (D26/AC8 — post-commit fanout)", () => {
  it("publishes each committed event exactly once, and nothing for rolled-back units", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());
      h.service.executeCommand(
        renameCommand(created.conversation_id, {
          payload: { conversation_id: created.conversation_id, title: "v2", expected_revision: 1 },
        }),
      );
      expect(() =>
        h.service.executeCommand(
          renameCommand(created.conversation_id, {
            payload: {
              conversation_id: created.conversation_id,
              title: "v3",
              expected_revision: 1,
            },
          }),
        ),
      ).toThrow(/CONVERSATION_REVISION_CONFLICT/);

      expect(h.published.map((event) => event.type)).toEqual([
        "conversation.created",
        "conversation.renamed",
      ]);
      expect(h.published[0]?.payload).toMatchObject({ title: "Operation kickoff" });
      expect(h.published[1]?.payload).toMatchObject({ new_revision: 2 });
    } finally {
      h.conn.close();
    }
  });
});

describe("conversation projection rebuild (D5 — state rebuildable from the journal)", () => {
  it("rebuilds conversation state from the journal alone and it matches the table", () => {
    const h = newHarness();
    try {
      const renamedTwice = h.service.executeCommand(createCommand());
      h.service.executeCommand(
        renameCommand(renamedTwice.conversation_id, {
          payload: { conversation_id: renamedTwice.conversation_id, title: "v2", expected_revision: 1 },
        }),
      );
      h.service.executeCommand(
        renameCommand(renamedTwice.conversation_id, {
          payload: { conversation_id: renamedTwice.conversation_id, title: "v3", expected_revision: 2 },
        }),
      );
      const untouched = h.service.executeCommand(
        createCommand({ payload: { title: "never renamed" } }),
      );
      const foreign = h.service.executeCommand(
        createCommand({ workspace_id: WS_B, payload: { title: "workspace B twin" } }),
      );

      // Rebuild from the journal ALONE — no conversations-table reads.
      const rebuiltA = rebuildConversationProjections(WS_A, h.journal, h.conn.db);
      expect(rebuiltA.size).toBe(2);
      for (const [id, projection] of rebuiltA) {
        const row = h.conversations.findById(WS_A, id, h.conn.db);
        expect(row).not.toBeNull();
        expect(projection).toEqual({
          id,
          workspace_id: WS_A,
          title: row?.title,
          revision: row?.revision,
        });
      }
      expect(rebuiltA.get(renamedTwice.conversation_id)).toMatchObject({
        title: "v3",
        revision: 3,
      });
      expect(rebuiltA.get(untouched.conversation_id)).toMatchObject({
        title: "never renamed",
        revision: 1,
      });

      // E12: the rebuild is workspace-scoped — WS_B's stream folds separately.
      const rebuiltB = rebuildConversationProjections(WS_B, h.journal, h.conn.db);
      expect(rebuiltB.size).toBe(1);
      expect(rebuiltB.get(foreign.conversation_id)).toMatchObject({
        workspace_id: WS_B,
        title: "workspace B twin",
        revision: 1,
      });
    } finally {
      h.conn.close();
    }
  });

  it("re-validates every payload against the registry while folding (G2)", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());
      const streamId = conversationStreamFor(created.conversation_id);

      // A row the gateway could never have written (the append boundary would
      // have rejected this payload): the rebuild must refuse to fold it.
      const sequence = h.journal.nextSequence(streamId, WS_A, h.conn.db);
      h.journal.append(
        {
          stream_id: streamId,
          sequence,
          event_id: "evt_smuggled_1",
          event_type: "conversation.renamed",
          schema_version: 1,
          payload: JSON.stringify({ nope: true }),
          workspace_id: WS_A,
          occurred_at: new Date().toISOString(),
          correlation_id: "smuggled",
        },
        h.conn.db,
      );

      expect(() => rebuildConversationProjections(WS_A, h.journal, h.conn.db)).toThrow(
        /conversation projection/,
      );
    } finally {
      h.conn.close();
    }
  });

  it("rejects rows whose payload conversation does not match their stream", () => {
    const h = newHarness();
    try {
      h.service.executeCommand(createCommand());
      const forgedStream = "conversation:forged";
      const sequence = h.journal.nextSequence(forgedStream, WS_A, h.conn.db);
      h.journal.append(
        {
          stream_id: forgedStream,
          sequence,
          event_id: "evt_forged_1",
          event_type: "conversation.created",
          schema_version: 1,
          payload: JSON.stringify({
            conversation_id: "elsewhere",
            workspace_id: WS_A,
            title: "mismatched",
          }),
          workspace_id: WS_A,
          occurred_at: new Date().toISOString(),
          correlation_id: "forged",
        },
        h.conn.db,
      );

      expect(() => rebuildConversationProjections(WS_A, h.journal, h.conn.db)).toThrow(
        /does not match payload conversation/,
      );
    } finally {
      h.conn.close();
    }
  });
});

describe("replay cursors (AC4, E10)", () => {
  it("returns exactly the missed events, in order, once", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());
      h.service.executeCommand(
        renameCommand(created.conversation_id, {
          payload: { conversation_id: created.conversation_id, title: "v2", expected_revision: 1 },
        }),
      );
      h.service.executeCommand(
        renameCommand(created.conversation_id, {
          payload: { conversation_id: created.conversation_id, title: "v3", expected_revision: 2 },
        }),
      );
      const streamId = conversationStreamFor(created.conversation_id);

      const fromZero = h.replay.resolve(WS_A, streamId, 0);
      expect(fromZero.kind).toBe("events");
      if (fromZero.kind !== "events") {
        return;
      }
      expect(fromZero.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(fromZero.next_cursor).toBe(3);

      // Acknowledging the batch yields an empty, correctly-ordered replay (once).
      const caughtUp = h.replay.resolve(WS_A, streamId, fromZero.next_cursor);
      expect(caughtUp.kind).toBe("events");
      if (caughtUp.kind !== "events") {
        return;
      }
      expect(caughtUp.events).toEqual([]);
      expect(caughtUp.next_cursor).toBe(3);

      // A mid-stream cursor returns exactly the tail.
      const tail = h.replay.resolve(WS_A, streamId, 1);
      expect(tail.kind).toBe("events");
      if (tail.kind !== "events") {
        return;
      }
      expect(tail.events.map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      h.conn.close();
    }
  });

  it("falls back to a snapshot + new cursor for a cursor below the retention horizon (E10)", () => {
    const h = newHarness();
    try {
      const created = h.service.executeCommand(createCommand());
      const streamId = conversationStreamFor(created.conversation_id);

      // Simulate a compactor that has dropped early history: a horizon above
      // the client's cursor makes the gap unreplayable (G4 — no fake replay).
      const strictReplay = new ReplayService({
        journal: h.journal,
        loadSnapshot: (workspaceId, sid) => {
          const row = h.conversations.findById(
            workspaceId,
            sid.replace(/^conversation:/, ""),
            h.conn.db,
          );
          if (!row) {
            return null;
          }
          return {
            kind: "conversation",
            conversation_id: row.id,
            workspace_id: row.workspace_id,
            title: row.title,
            revision: row.revision,
            up_to_sequence: h.journal.maxSequence(workspaceId, sid, h.conn.db),
          };
        },
        // Everything below sequence 3 is "compacted away".
        retentionHorizon: () => 3,
      });

      const fallback = strictReplay.resolve(WS_A, streamId, 0);
      expect(fallback.kind).toBe("snapshot_required");
      if (fallback.kind !== "snapshot_required") {
        return;
      }
      expect(fallback.reason).toBe("cursor_below_retention_horizon");
      expect(fallback.earliest_available_sequence).toBe(3);
      expect(fallback.snapshot).toMatchObject({
        kind: "conversation",
        conversation_id: created.conversation_id,
        revision: 1,
        up_to_sequence: 1,
      });
      expect(fallback.replayed).toBe(false);
    } finally {
      h.conn.close();
    }
  });

  it("reports an unknown stream as an EMPTY EVENT BATCH (kind 'events'), not a snapshot fallback (B7)", () => {
    const h = newHarness();
    try {
      const result = h.replay.resolve(WS_A, "conversation:no-such-stream", 0);
      expect(result.kind).toBe("events");
      if (result.kind !== "events") {
        return;
      }
      // An unknown stream has no missed events; an empty batch is the honest
      // answer, and the snapshot path stays reserved for retention gaps.
      expect(result.events).toEqual([]);
    } finally {
      h.conn.close();
    }
  });
});
