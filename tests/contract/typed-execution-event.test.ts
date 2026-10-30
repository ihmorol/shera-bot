import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TASK_TRIGGER_EVENT_TYPES,
  TypedExecutionEvent,
  type TypedExecutionEvent as TypedExecutionEventType,
} from "@shera-bot/contracts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "s02");

/**
 * D26 fixes the durable event envelope. The issue text says "ten required
 * fields"; D26 itself names eleven (actor is the easily-miscounted one). This
 * test asserts the exact D26 field list on every envelope member — the count
 * discrepancy is recorded in the slice report, D26 wins.
 */
const D26_ENVELOPE_FIELDS = [
  "event_id",
  "stream_id",
  "sequence",
  "event_type",
  "event_version",
  "actor",
  "task_id",
  "conversation_id",
  "occurred_at",
  "payload",
  "redaction_class",
];

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Record<string, unknown>;
}

describe("TypedExecutionEvent envelope shape (D26)", () => {
  it("carries exactly the D26 field set on every event-type member", () => {
    expect(TypedExecutionEvent.options.length).toBeGreaterThanOrEqual(10);

    for (const option of TypedExecutionEvent.options) {
      const keys = Object.keys(option.shape).sort();
      expect(keys).toEqual([...D26_ENVELOPE_FIELDS].sort());
    }
  });

  it("discriminates payload by event_type", () => {
    const proposed = TypedExecutionEvent.parse(loadFixture("event-tool-proposed.json"));
    expect(proposed.event_type).toBe("tool.proposed");
    if (proposed.event_type === "tool.proposed") {
      expect(typeof proposed.payload.args_digest).toBe("string");
    }

    // A tool.proposed envelope carrying an approval-request payload must fail:
    // payload shape is pinned to the discriminator.
    const mismatched = {
      ...loadFixture("event-tool-proposed.json"),
      payload: { capability: "web.read", risk_class: "READ_ONLY" },
    };
    expect(TypedExecutionEvent.safeParse(mismatched).success).toBe(false);
  });

  it("rejects an unknown event_type", () => {
    const unknown = {
      ...loadFixture("event-task-started.json"),
      event_type: "agent.said.something.in.prose",
    };
    const verdict = TypedExecutionEvent.safeParse(unknown);
    expect(verdict.success).toBe(false);
  });

  it("keeps the D34 trigger vocabulary closed and typed", () => {
    // S28 (PRD §8's eight autonomous trigger categories): the runtime trigger
    // vocabulary gains the four categories the initial S02 set did not carry —
    // Git changes, task completion, agent-evaluated conditions, and external
    // service events. Every one is a TYPED event (never prose — G2); the set
    // stays closed and the closed-ness stays pinned here.
    expect([...TASK_TRIGGER_EVENT_TYPES].sort()).toEqual(
      [
        "tool.proposed",
        "delegation.proposed",
        "approval.requested",
        "operation.confirmed",
        "trigger.scheduled",
        "trigger.webhook",
        "trigger.file_event",
        "trigger.git_event",
        "trigger.task_completed",
        "trigger.condition_met",
        "trigger.external_event",
      ].sort(),
    );
  });

  it("rejects a sequence that is not a positive integer", () => {
    const badSequence = { ...loadFixture("event-task-started.json"), sequence: 0 };
    expect(TypedExecutionEvent.safeParse(badSequence).success).toBe(false);

    const fractional = { ...loadFixture("event-task-started.json"), sequence: 2.5 };
    expect(TypedExecutionEvent.safeParse(fractional).success).toBe(false);
  });

  it("types the parsed fixture without any hand-written duplicate (D25)", () => {
    const parsed: TypedExecutionEventType = TypedExecutionEvent.parse(
      loadFixture("event-task-started.json"),
    );
    // The type must narrow on the discriminator; this only compiles when the
    // inferred union is a real discriminated union.
    if (parsed.event_type === "task.started") {
      expect(parsed.payload.to_state).toBe("RUNNING");
    } else {
      throw new Error("discriminated narrowing failed");
    }
  });
});
