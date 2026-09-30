/**
 * E8 mock-runtime mode tests (S09 chunk 1): the deterministic in-process
 * runtime drives the REAL stack — real SQLite, real HTTP, the real gateway —
 * with the FakeHarnessAdapter's fixed D8 script and a fixed clock. No Docker,
 * no live providers, no child processes.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { TypedExecutionEvent } from "@shera-bot/contracts";

import { startE2eMockRuntime, E2E_MOCK_FIXED_EPOCH, isE2eMockMode } from "./e2e-mode.ts";

const NOW = E2E_MOCK_FIXED_EPOCH;
const dbDirs: string[] = [];

const TRIGGER: TypedExecutionEvent = {
  event_id: "evt_trig_e2e_1",
  stream_id: "conversation:conv_e2e_1",
  sequence: 1,
  event_version: 1,
  actor: { type: "system", id: "e2e-harness" },
  task_id: "task_evt_e2e_1",
  conversation_id: "conv_e2e_1",
  occurred_at: NOW,
  redaction_class: "internal",
  event_type: "trigger.scheduled",
  payload: { schedule_id: "sch_e2e_1", due_at: NOW },
};

afterAll(() => {
  for (const dir of dbDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mode selection", () => {
  it("RUNTIME_E2E_MOCK=1 selects the mode; anything else does not", () => {
    expect(isE2eMockMode({ RUNTIME_E2E_MOCK: "1" })).toBe(true);
    expect(isE2eMockMode({ RUNTIME_E2E_MOCK: "0" })).toBe(false);
    expect(isE2eMockMode({})).toBe(false);
  });
});

describe("the mock runtime serves the real local API", () => {
  it("answers the health probe and drives the real-rows round trip", async () => {
    const mock = await startE2eMockRuntime();
    dbDirs.push(dirname(mock.dbPath));
    try {
      const health = await fetch(`${mock.origin}/internal/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const response = await fetch(`${mock.origin}/v1/conversations/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "conversation.create",
          workspace_id: mock.workspace_id,
          idempotency_key: "e2e-ga-seed-v1",
          payload: { title: "General Assistant" },
        }),
      });
      expect(response.status).toBe(200);
      const created = (await response.json()) as { conversation_id: string; kind: string };
      expect(created.kind).toBe("created");

      const events = await fetch(
        `${mock.origin}/v1/conversations/${created.conversation_id}/events?workspace_id=${mock.workspace_id}&last_acknowledged_sequence=0`,
      );
      const replay = (await events.json()) as { kind: string; events: Array<{ type: string }> };
      expect(replay.kind).toBe("events");
      expect(replay.events.map((event) => event["type"])).toEqual(["conversation.created"]);
    } finally {
      await mock.stop();
    }
  });

  it("is disposable: a fresh start does not inherit the previous database", async () => {
    const first = await startE2eMockRuntime();
    dbDirs.push(dirname(first.dbPath));
    await first.stop();

    const second = await startE2eMockRuntime();
    dbDirs.push(dirname(second.dbPath));
    try {
      expect(second.dbPath).not.toBe(first.dbPath);
      const response = await fetch(
        `${second.origin}/v1/conversations/conv_missing/events?workspace_id=${second.workspace_id}&last_acknowledged_sequence=0`,
      );
      const replay = (await response.json()) as { kind: string; events: unknown[] };
      // Nothing inherited: the unknown stream replays as an honest empty batch.
      expect(replay.kind).toBe("events");
      expect(replay.events).toEqual([]);
    } finally {
      await second.stop();
    }
  });
});

describe("deterministic harness runs (fixed D8 script, fixed clock)", () => {
  it("drives a run to SUCCEEDED with the scripted journal sequence, then replays idempotently", async () => {
    const mock = await startE2eMockRuntime({ now: () => NOW });
    dbDirs.push(dirname(mock.dbPath));
    try {
      const first = mock.harness.startRun(TRIGGER);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected a successful start");
      expect(first.state).toBe("SUCCEEDED");

      const types = first.journal_events.map((event) => event.type);
      expect(types).toEqual([
        "task.created",
        "task.queued",
        "task.started",
        "progress.reported",
        "task.succeeded",
      ]);
      // The fixed clock stamps the D26 envelope inside every journal payload
      // identically (the row's own occurred_at is the append time — storage
      // identity, deliberately not the event clock).
      expect(
        first.journal_events.every(
          (event) =>
            typeof event.payload === "object" &&
            event.payload !== null &&
            (event.payload as Record<string, unknown>)["occurred_at"] === NOW,
        ),
      ).toBe(true);
      // The scripted payload is byte-stable across runs (the journal row's
      // payload IS the full D26 envelope, so fraction sits one level in).
      const progress = first.journal_events.find((event) => event.type === "progress.reported");
      const inner = progress?.payload as { payload?: { fraction?: number } } | undefined;
      expect(inner?.payload?.fraction).toBe(0.5);

      const second = mock.harness.startRun(TRIGGER);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error("expected a successful replay");
      // Idempotent replay: the same trigger adds no new journal events.
      expect(second.journal_events).toEqual([]);
    } finally {
      await mock.stop();
    }
  });

  it("refuses a non-loopback host outright", async () => {
    await expect(startE2eMockRuntime({ host: "0.0.0.0" })).rejects.toThrow(/non-loopback/);
  });
});
