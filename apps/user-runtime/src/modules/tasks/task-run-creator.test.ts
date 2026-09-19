import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TASK_TRIGGER_EVENT_TYPES } from "@shera-bot/contracts";

import { createTaskRunFromTypedEvent } from "./task-run-creator.ts";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../tests/fixtures/s02",
);
const NOW = "2026-09-18T10:00:00.000Z";
const HASH = "9".repeat(64);

const DEPS = {
  pinned_pack: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
  workspace_id: "ws_default_01",
  clock: { now: NOW, next_sequence: 7 },
} as const;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

const TRIGGER_FIXTURES: ReadonlyArray<[string, string]> = [
  ["tool.proposed", "event-tool-proposed.json"],
  ["delegation.proposed", "event-delegation-proposed.json"],
  ["approval.requested", "event-approval-requested.json"],
  ["operation.confirmed", "event-operation-confirmed.json"],
  ["trigger.scheduled", "event-trigger-scheduled.json"],
  ["trigger.webhook", "event-trigger-webhook.json"],
  ["trigger.file_event", "event-trigger-file.json"],
];

describe("G2: task runs are created only from typed execution events", () => {
  it("maps the D34 trigger vocabulary onto fixture files (no gaps)", () => {
    const fixtureTypes = TRIGGER_FIXTURES.map(([eventType]) => eventType).sort();
    expect(fixtureTypes).toEqual([...TASK_TRIGGER_EVENT_TYPES].sort());
  });

  it.each(TRIGGER_FIXTURES)("creates a TaskRun in CREATED from %s", (_type, file) => {
    const result = createTaskRunFromTypedEvent(fixture(file), DEPS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ${file} to create a task run`);

    expect(result.run.state).toBe("CREATED");
    expect(result.run.version).toBe(1);
    expect(result.run.workspace_id).toBe("ws_default_01");
    expect(result.run.conversation_id).toBe("conv_001");
    expect(result.run.created_from.trigger_event_type).toBe(_type);
    expect(result.run.pack_snapshot).toEqual(DEPS.pinned_pack);

    // The creation is itself journaled as a typed event, not prose.
    expect(result.creation_event.event_type).toBe("task.created");
    expect(result.creation_event.task_id).toBe(result.run.task_id);
    expect(result.creation_event.stream_id).toBe(`task:${result.run.task_id}`);
    expect(result.creation_event.sequence).toBe(DEPS.clock.next_sequence);
    expect(result.creation_event.occurred_at).toBe(NOW);
    expect(result.creation_event.event_version).toBe(1);
    if (result.creation_event.event_type === "task.created") {
      expect(result.creation_event.payload.trigger_event_id).toBeDefined();
    }
  });

  it("derives a deterministic task_id from the creating event", () => {
    const first = createTaskRunFromTypedEvent(fixture("event-tool-proposed.json"), DEPS);
    const second = createTaskRunFromTypedEvent(fixture("event-tool-proposed.json"), DEPS);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.run.task_id).toBe(first.run.task_id);
    }
  });

  it("rejects natural language with a typed rejection, never an exception", () => {
    expect(() =>
      createTaskRunFromTypedEvent("please research this topic for me", DEPS),
    ).not.toThrow();

    const prose = createTaskRunFromTypedEvent("please research this topic for me", DEPS);
    expect(prose.ok).toBe(false);
    if (!prose.ok) {
      expect(prose.rejection.kind).toBe("not_a_typed_event");
      expect(prose.rejection.code).toBe("TASK_RUN_INPUT_NOT_TYPED_EVENT");
    }
  });

  it("rejects a prose-shaped object that is not a typed execution event", () => {
    const result = createTaskRunFromTypedEvent(
      { text: "run the literature review", urgent: true },
      DEPS,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe("not_a_typed_event");
    }
  });

  it("rejects a valid typed event that is not a task-creation trigger", () => {
    const progress = createTaskRunFromTypedEvent(fixture("event-task-started.json"), DEPS);

    expect(progress.ok).toBe(false);
    if (!progress.ok) {
      expect(progress.rejection.kind).toBe("not_a_task_trigger");
      expect(progress.rejection.code).toBe("TASK_RUN_INPUT_NOT_A_TRIGGER");
    }
  });
});
