/**
 * HarnessRunService tests (S07; D51, G2, D34, D23 rule 5/6, E12).
 *
 * The gateway side of the seam: adapters PROPOSE, the service validates and
 * executes. Tests prove the deterministic fake drives a run end-to-end into
 * contract-valid D26 events on the journal (created -> queued -> started ->
 * progress -> succeeded), that replays are idempotent (no new rows, no
 * double fanout), that non-triggers and non-typed-event input die as typed
 * rejections (G2), and that an adapter cannot force an illegal transition.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { TypedExecutionEvent } from "@shera-bot/contracts";

import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { FakeHarnessAdapter } from "../../adapters/process/fake-harness-adapter.ts";
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessProposal,
  HarnessRunRequest,
} from "../../adapters/process/harness-adapter.ts";
import { EventsService } from "../events/events.service.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { HarnessRunService } from "./harness-run-service.ts";

const tempDirs: string[] = [];
const WS_A = "ws-11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-28T12:00:00.000Z";
const PACK = { pack_id: "pack_default", pack_version: "0.1.0", pack_hash: "0".repeat(64) };

const TRIGGER: TypedExecutionEvent = {
  event_id: "evt_trig_1",
  stream_id: "conversation:conv_001",
  sequence: 1,
  event_version: 1,
  actor: { type: "system", id: "scheduler" },
  task_id: "task_evt_trig_1",
  conversation_id: "conv_001",
  occurred_at: NOW,
  redaction_class: "internal",
  event_type: "trigger.scheduled",
  payload: { schedule_id: "sch_001", due_at: NOW },
};

interface Harness {
  service: HarnessRunService;
  journal: EventJournalRepository;
  conn: SqliteConnection;
  published: EventEnvelope[];
}

function newHarness(adapter: HarnessAdapter = new FakeHarnessAdapter({ now: () => NOW })): Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-harness-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const published: EventEnvelope[] = [];
  const service = new HarnessRunService({
    adapter,
    tx,
    journal,
    events,
    pinned_pack: PACK,
    workspace_id: WS_A,
    policy: { max_retries: 3 },
    now: () => NOW,
    publish: (event) => published.push(event),
  });
  return { service, journal, conn, published };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("harness run service — the fake drives a run end-to-end (D51, G2)", () => {
  it("journals the full scripted run as contract-valid D26 events in order", () => {
    const h = newHarness();
    try {
      const result = h.service.startRun(TRIGGER);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.task_id).toBe("task_evt_trig_1");
      expect(result.workspace_id).toBe(WS_A);
      expect(result.state).toBe("SUCCEEDED");
      expect(result.version).toBe(4);
      expect(result.rejections).toEqual([]);

      const stream = h.journal.listStream(taskStreamId("task_evt_trig_1"), WS_A, h.conn.db);
      expect(stream.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(stream.map((row) => row.event_type)).toEqual([
        "task.created",
        "task.queued",
        "task.started",
        "progress.reported",
        "task.succeeded",
      ]);

      // The row payload IS the full D26 envelope (the durable contract event).
      const succeeded = JSON.parse(stream[4]!.payload) as TypedExecutionEvent;
      expect(succeeded).toMatchObject({
        event_type: "task.succeeded",
        sequence: 5,
        task_id: "task_evt_trig_1",
        conversation_id: "conv_001",
        payload: { from_state: "RUNNING", to_state: "SUCCEEDED", reason: "run_completed" },
      });
      expect(succeeded.payload).toMatchObject({ correlation_id: "cmd_complete_task_evt_trig_1" });

      // Fanout fires exactly once per appended event, after commit.
      expect(h.published.map((event) => event.type)).toEqual([
        "task.created",
        "task.queued",
        "task.started",
        "progress.reported",
        "task.succeeded",
      ]);
    } finally {
      h.conn.close();
    }
  });

  it("replays idempotently: the same trigger adds no rows and fans out nothing", () => {
    const h = newHarness();
    try {
      const first = h.service.startRun(TRIGGER);
      expect(first.ok).toBe(true);
      const rowsAfterFirst = h.journal.countStream(
        taskStreamId("task_evt_trig_1"),
        WS_A,
        h.conn.db,
      );
      const publishedAfterFirst = h.published.length;

      const second = h.service.startRun(TRIGGER);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.journal_events).toEqual([]);
      expect(second.rejections).toEqual([]);
      // The replayed script lands on the same terminal state.
      expect(second.state).toBe("SUCCEEDED");

      expect(h.journal.countStream(taskStreamId("task_evt_trig_1"), WS_A, h.conn.db)).toBe(
        rowsAfterFirst,
      );
      // Exactly-once fanout: the replay publishes nothing new.
      expect(h.published).toHaveLength(publishedAfterFirst);
    } finally {
      h.conn.close();
    }
  });
});

describe("harness run service — the gateway validates what adapters propose (G2)", () => {
  it("rejects a typed non-trigger event without touching the journal", () => {
    const h = newHarness();
    try {
      // task.created is a typed event but NOT a D34 trigger.
      const nonTrigger: TypedExecutionEvent = {
        ...TRIGGER,
        event_type: "task.created",
        payload: {
          trigger_event_type: "trigger.scheduled",
          trigger_event_id: "evt_trig_1",
          correlation_id: "evt_trig_1",
        },
      };
      const result = h.service.startRun(nonTrigger);
      expect(result).toMatchObject({
        ok: false,
        reason: "not_a_task_trigger",
        code: "TASK_RUN_INPUT_NOT_A_TRIGGER",
      });
      expect(h.journal.countStream(taskStreamId("task_evt_trig_1"), WS_A, h.conn.db)).toBe(0);
    } finally {
      h.conn.close();
    }
  });

  it("rejects natural-language input as a typed value (it is never classified)", () => {
    const h = newHarness();
    try {
      const result = h.service.startRun("please just run the thing for me");
      expect(result).toMatchObject({
        ok: false,
        reason: "not_a_typed_event",
        code: "TASK_RUN_INPUT_NOT_TYPED_EVENT",
      });
    } finally {
      h.conn.close();
    }
  });

  it("records an adapter's illegal proposal as a typed rejection and still applies the legal one", () => {
    // A misbehaving adapter: stale expected_version first, then a legal queue.
    const stubborn: HarnessAdapter = {
      harness: "fake",
      driveRun(request: HarnessRunRequest, sink: HarnessEventSink) {
        const proposals: HarnessProposal[] = [
          {
            kind: "task_command",
            command: {
              type: "queue_task",
              command_id: "cmd_stale_1",
              idempotency_key: "idem_stale_1",
              workspace_id: request.workspace_id,
              task_id: request.task_id,
              actor: { type: "runtime", id: "harness:fake" },
              expected_version: 99,
              issued_at: NOW,
            },
          },
          {
            kind: "task_command",
            command: {
              type: "queue_task",
              command_id: "cmd_good_1",
              idempotency_key: "idem_good_1",
              workspace_id: request.workspace_id,
              task_id: request.task_id,
              actor: { type: "runtime", id: "harness:fake" },
              expected_version: 1,
              issued_at: NOW,
            },
          },
        ];
        for (const proposal of proposals) {
          sink.propose(proposal);
        }
      },
    };
    const h = newHarness(stubborn);
    try {
      const result = h.service.startRun(TRIGGER);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        kind: "version_conflict",
        code: "TASK_VERSION_CONFLICT",
      });
      // The legal proposal still applied; the run is QUEUED at version 2.
      expect(result.state).toBe("QUEUED");
      expect(result.version).toBe(2);
      expect(h.published.map((event) => event.type)).toEqual(["task.created", "task.queued"]);
    } finally {
      h.conn.close();
    }
  });

  it("records an invalid journal_event proposal as a typed rejection and the run still completes (B2)", () => {
    // A misbehaving adapter: a journal_event payload that fails the D26
    // envelope contract FIRST, then the normal valid script.
    const invalidThenValid: HarnessAdapter = {
      harness: "fake",
      driveRun(request: HarnessRunRequest, sink: HarnessEventSink) {
        const base = {
          workspace_id: request.workspace_id,
          task_id: request.task_id,
          actor: { type: "runtime" as const, id: "harness:fake" },
          issued_at: NOW,
        };
        sink.propose({
          kind: "journal_event",
          event_type: "progress.reported",
          // Strict payload schema rejects the unknown key; the VALUE must
          // never surface in the recorded rejection (G3).
          payload: { notes: "SECRET-HARNESS-VALUE" },
        });
        sink.propose({
          kind: "task_command",
          command: {
            type: "queue_task",
            command_id: `cmd_queue_${request.task_id}`,
            idempotency_key: `idem_queue_${request.task_id}`,
            expected_version: 1,
            ...base,
          },
        });
        sink.propose({
          kind: "task_command",
          command: {
            type: "start_task",
            command_id: `cmd_start_${request.task_id}`,
            idempotency_key: `idem_start_${request.task_id}`,
            expected_version: 2,
            ...base,
          },
        });
        sink.propose({
          kind: "journal_event",
          event_type: "progress.reported",
          payload: { summary: "valid progress", fraction: 0.5 },
        });
        sink.propose({
          kind: "task_command",
          command: {
            type: "complete_task",
            command_id: `cmd_complete_${request.task_id}`,
            idempotency_key: `idem_complete_${request.task_id}`,
            expected_version: 3,
            ...base,
          },
        });
      },
    };
    const h = newHarness(invalidThenValid);
    try {
      const result = h.service.startRun(TRIGGER);
      // The invalid proposal did NOT crash the run: it was recorded as data
      // and skipped, and the valid script drove to completion.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe("SUCCEEDED");
      expect(result.version).toBe(4);
      expect(result.rejections).toHaveLength(1);
      const rejection = result.rejections[0]!;
      expect(rejection).toMatchObject({
        kind: "malformed_command",
        code: "JOURNAL_EVENT_MALFORMED",
        safe_message:
          "The proposed journal event progress.reported failed the D26 envelope contract.",
      });
      const detail = rejection.detail as { event_type: string; issues: unknown[] };
      expect(detail.event_type).toBe("progress.reported");
      expect(detail.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(rejection)).not.toContain("SECRET-HARNESS-VALUE");

      // Nothing was appended or fanned out for the invalid proposal: the
      // stream holds exactly the valid script's five events.
      const stream = h.journal.listStream(taskStreamId("task_evt_trig_1"), WS_A, h.conn.db);
      expect(stream.map((row) => row.event_type)).toEqual([
        "task.created",
        "task.queued",
        "task.started",
        "progress.reported",
        "task.succeeded",
      ]);
      expect(h.published.map((event) => event.type)).toEqual([
        "task.created",
        "task.queued",
        "task.started",
        "progress.reported",
        "task.succeeded",
      ]);
    } finally {
      h.conn.close();
    }
  });
});
