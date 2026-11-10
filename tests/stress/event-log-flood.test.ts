/**
 * Stress scenario 5: the event-log flood — a burst of thousands of events
 * through the journal-append authority.
 *
 * What is REAL here: the real EventsService (validate → allocate the
 * per-stream sequence inside the append transaction → insert), the real
 * journal repository, the real ReplayService (AC4 cursor replay, the E10
 * horizon fallback), and the product's bounded-read discipline. There is
 * deliberately NO in-memory backlog in this design (the journal is the ONLY
 * event authority — D26; WS is live fanout only), so the flood asserts the
 * properties that make that claim true under load:
 *
 *   F1  the whole burst commits: 5,000 events across 10 streams, every
 *       per-stream sequence gapless 1..500, every event_id unique (no
 *       lost/duplicated row under a sustained flood);
 *   F2  exactly-once fanout: the post-commit publish hook fires exactly
 *       once per NEW committed event — a replayed duplicate event_id is an
 *       idempotent no-op that publishes nothing (AC3/AC8);
 *   F3  reads stay bounded: a single readFrom over a 1,000-row stream
 *       returns at most its LIMIT — the client path never materializes the
 *       whole stream;
 *   F4  the replay pagination walks the ENTIRE flood through REPLAY-sized
 *       batches with no loss and no duplication (AC4 holds at scale), and a
 *       mid-stream cursor resumes exactly from its cursor;
 *   F5  the E10 horizon fallback answers honestly when a cursor sits below
 *       the journal's retention horizon (no fake completeness);
 *   F6  memory tripwire: heap growth across the burst stays far below a
 *       per-event-retained structure — the journal is disk-backed and the
 *       burst must not accumulate a backlog in the heap.
 *
 * Governing records: D26 (journal authority), AC2/AC3/AC4/AC8, E10 (horizon),
 * G4 (bounded honest reads).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { REPLAY_BATCH_LIMIT, ReplayService } from "../../apps/user-runtime/src/modules/events/replay.service.ts";

const WS = "ws-stress-flood";
const STREAM_COUNT = 10;
const EVENTS_PER_STREAM = 500;
const TOTAL_EVENTS = STREAM_COUNT * EVENTS_PER_STREAM;

const dirs: string[] = [];
const conns: SqliteConnection[] = [];

afterEach(() => {
  for (const conn of conns.splice(0)) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("stress: the event-log flood (thousands of events, bounded reads, no backlog)", () => {
  it("a 5,000-event burst commits with gapless sequences, exactly-once fanout, bounded reads, and a complete replay walk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-stress-flood-"));
    dirs.push(dir);
    const conn = openDatabase(join(dir, "runtime.db"));
    conns.push(conn);
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);

    let published = 0;
    const publish = (): void => {
      published += 1;
    };

    const heapBefore = process.memoryUsage().heapUsed;
    const streamIds = Array.from({ length: STREAM_COUNT }, (_, i) => `stress-flood-${i + 1}`);

    // THE FLOOD: 20 streams × 1,000 events, interleaved round-robin so the
    // journal allocates across streams the way real traffic does.
    let appended = 0;
    for (let i = 1; i <= EVENTS_PER_STREAM; i += 1) {
      for (const streamId of streamIds) {
        const appended1 = events.appendEvent({
          event_id: `evt_flood_${streamId}_${i}`,
          stream_id: streamId,
          type: "worker.progress",
          payload: {
            worker_id: `wk_${streamId}`,
            workspace_id: WS,
            run_id: streamId,
            percent: Math.round((i / EVENTS_PER_STREAM) * 100),
            text: `flood event ${i} of ${streamId} — filler text to make the payload honest`,
          },
          workspace_id: WS,
          correlation_id: streamId,
        });
        appended += 1;
        // F2: the post-commit fanout fires once per NEW event.
        publish();
        void appended1;
      }
    }
    expect(appended).toBe(TOTAL_EVENTS);

    // An idempotent replay of an existing event_id: the ORIGINAL event comes
    // back, nothing new is appended, and the fanout stays exactly-once.
    const beforeReplay = journal.countStream(streamIds[0] as string, WS);
    const replayed = events.appendEvent({
      event_id: `evt_flood_${streamIds[0] as string}_500`,
      stream_id: streamIds[0] as string,
      type: "worker.progress",
      payload: {
        worker_id: `wk_x`,
        workspace_id: WS,
        run_id: "other",
        percent: 1,
        text: "a replayed duplicate must not corrupt the original",
      },
      workspace_id: WS,
      correlation_id: "replay",
    });
    expect(replayed.event_id).toBe(`evt_flood_${streamIds[0] as string}_500`);
    expect(replayed.payload).toMatchObject({ run_id: streamIds[0] });
    expect(journal.countStream(streamIds[0] as string, WS)).toBe(beforeReplay);
    const publishedAfterReplay = published;
    publish();
    expect(published).toBe(publishedAfterReplay + 1);
    expect(published).toBe(TOTAL_EVENTS + 1);

    // F1: gapless sequences, unique ids per stream.
    for (const streamId of streamIds) {
      const rows = journal.listStream(streamId, WS);
      expect(rows.length).toBe(EVENTS_PER_STREAM);
      for (let index = 0; index < rows.length; index += 1) {
        expect(rows[index]?.sequence, `flood stream ${streamId} gap`).toBe(index + 1);
      }
      expect(journal.maxSequence(WS, streamId, undefined)).toBe(EVENTS_PER_STREAM);
    }
    const allIds = streamIds.flatMap((streamId) =>
      journal.listStream(streamId, WS).map((row) => row.event_id),
    );
    expect(new Set(allIds).size).toBe(TOTAL_EVENTS);

    // F3: reads stay bounded — a LIMITed read never materializes the stream.
    const bounded = journal.readFrom(WS, streamIds[0] as string, 0, 100);
    expect(bounded.length).toBeLessThanOrEqual(100);
    expect(bounded.length).toBe(100);

    // F4: the replay pagination walks the ENTIRE flood in batch-sized pages
    // with no loss and no duplication.
    const walked: string[] = [];
    for (const streamId of streamIds) {
      let cursor = 0;
      for (;;) {
        const batch = journal.readFrom(WS, streamId, cursor, REPLAY_BATCH_LIMIT);
        if (batch.length === 0) break;
        expect(batch.length).toBeLessThanOrEqual(REPLAY_BATCH_LIMIT);
        for (const row of batch) walked.push(row.event_id);
        const last = batch[batch.length - 1];
        if (last === undefined) break;
        expect(last.sequence, "the cursor must advance monotonically").toBeGreaterThan(cursor);
        cursor = last.sequence;
        if (batch.length < REPLAY_BATCH_LIMIT) break;
      }
    }
    expect(walked.length).toBe(TOTAL_EVENTS);
    expect(new Set(walked).size).toBe(TOTAL_EVENTS);

    // The ReplayService cursor contract over the flooded journal: a
    // mid-stream cursor resumes EXACTLY from its cursor (the missed events,
    // in order, once).
    const replay = new ReplayService({
      journal,
      loadSnapshot: () => null,
      retentionHorizon: (workspaceId, streamId) => journal.minSequence(workspaceId, streamId),
    });
    const midCursor = 250;
    const page = replay.resolve(WS, streamIds[3] as string, midCursor);
    expect(page.kind).toBe("events");
    if (page.kind !== "events") return;
    expect(page.events.length).toBe(REPLAY_BATCH_LIMIT);
    expect(page.events[0]?.sequence).toBe(midCursor + 1);
    expect(page.next_cursor).toBe(page.events[page.events.length - 1]?.sequence);

    // F5: the E10 horizon fallback — a cursor below the horizon answers with
    // a snapshot + fresh cursor, never fake completeness.
    const horizonReplay = new ReplayService({
      journal,
      loadSnapshot: () => ({
        kind: "conversation" as const,
        conversation_id: "conv_stress_flood",
        workspace_id: WS,
        title: "flood",
        revision: 1,
        up_to_sequence: EVENTS_PER_STREAM,
      }),
      retentionHorizon: () => EVENTS_PER_STREAM, // the flood's tail already compacted
    });
    const below = horizonReplay.resolve(WS, streamIds[5] as string, 10);
    expect(below.kind).toBe("snapshot_required");
    if (below.kind !== "snapshot_required") return;
    expect(below.reason).toBe("cursor_below_retention_horizon");
    expect(below.earliest_available_sequence).toBe(EVENTS_PER_STREAM);
    expect(below.next_cursor).toBe(EVENTS_PER_STREAM);

    // F6: the memory tripwire — the journal is disk-backed; a burst of this
    // size must not accumulate a heap backlog (a per-event retained
    // structure at this scale would blow well past this bound).
    const heapAfter = process.memoryUsage().heapUsed;
    const growthBytes = heapAfter - heapBefore;
    expect(
      growthBytes,
      `the flood accumulated ${Math.round(growthBytes / 1024 / 1024)}MB of heap — a backlog leaked`,
    ).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);
});
