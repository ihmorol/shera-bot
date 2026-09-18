import { describe, expect, it } from "vitest";

import type { RunState, TaskCommand, TaskPolicy, TaskRun } from "@shera-bot/contracts";

import { evaluateTaskTransition, parseTaskCommand, TASK_TRANSITIONS } from "./task-transitions.ts";

const POLICY: TaskPolicy = { max_retries: 3 };
const NOW = "2026-09-18T10:00:00.000Z";
const HASH = "1".repeat(64);

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: "task_001",
    workspace_id: "ws_default_01",
    conversation_id: "conv_001",
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: ["agent_general_assistant"],
    state: "CREATED",
    version: 1,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

type CommandOverrides = Partial<TaskCommand> & Record<string, unknown>;

function makeCommand(overrides: CommandOverrides = {}): TaskCommand {
  const base = {
    command_id: "cmd_001",
    idempotency_key: "idem_001",
    workspace_id: "ws_default_01",
    task_id: "task_001",
    actor: { type: "runtime" as const, id: "runtime-gateway" },
    // evaluate() builds the run at version 3; a matching expected_version keeps
    // the optimistic check quiet unless a test targets it explicitly.
    expected_version: 3,
    issued_at: NOW,
  };
  // The override may switch the discriminated union member entirely.
  return { ...base, ...overrides } as unknown as TaskCommand;
}

function evaluate(
  state: RunState,
  command: TaskCommand,
  overrides: { policy?: TaskPolicy; applied?: string[]; run?: Partial<TaskRun> } = {},
) {
  return evaluateTaskTransition({
    run: makeRun({ state, version: 3, ...overrides.run }),
    command,
    policy: overrides.policy ?? POLICY,
    applied_idempotency_keys: overrides.applied ?? [],
    clock: { now: NOW, next_sequence: 41 },
  });
}

describe("task state machine: every table row is legal and emits its event", () => {
  it.each(TASK_TRANSITIONS.map((row) => [`${row.from} --${row.command}-> ${row.to}`, row]))(
    "%s",
    (_label, row) => {
      const actorType = row.actors[0];
      if (!actorType) throw new Error(`row ${row.command} has no allowed actor`);

      const extras: Record<string, unknown> = {};
      if (row.command === "schedule_retry" || row.command === "retry_task") {
        extras.failure_event_id = "evt_failed_1";
        extras.attempt = 2;
      }
      if (row.command === "retry_attempt") {
        extras.attempt = 2;
      }
      if (row.command === "approval_granted" || row.command === "approval_rejected") {
        extras.approval_id = "apr_001";
      }

      const result = evaluate(
        row.from,
        makeCommand({
          type: row.command,
          actor: { type: actorType, id: "principal_1" },
          ...extras,
        }),
      );

      if (!result.ok) {
        throw new Error(
          `expected ${row.from} --${row.command}-> ${row.to} to be accepted, got: ` +
            `${result.rejection.kind} (${JSON.stringify(result.rejection.detail)})`,
        );
      }

      expect(result.from).toBe(row.from);
      expect(result.to).toBe(row.to);
      expect(result.reason).toBe(row.reason);
      expect(result.next_version).toBe(4); // version 3 -> 4 (optimistic increment)
      expect(result.emitted_event.event_type).toBe(row.event);
      expect(result.emitted_event.task_id).toBe("task_001");
      expect(result.emitted_event.stream_id).toBe("task:task_001");
      expect(result.emitted_event.sequence).toBe(41);
      expect(result.emitted_event.event_version).toBe(1);
      expect(result.emitted_event.occurred_at).toBe(NOW);
      if ("from_state" in result.emitted_event.payload) {
        expect(result.emitted_event.payload.from_state).toBe(row.from);
        expect(result.emitted_event.payload.to_state).toBe(row.to);
        expect(result.emitted_event.payload.correlation_id).toBe("cmd_001");
      } else {
        throw new Error(`row ${row.command} did not emit a lifecycle payload`);
      }
    },
  );
});

describe("task state machine: typed rejections (never thrown)", () => {
  it("rejects SUCCEEDED -> RUNNING as an illegal transition", () => {
    const result = evaluate("SUCCEEDED", makeCommand({ type: "start_task" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe("illegal_transition");
      expect(result.rejection.code).toBe("TASK_ILLEGAL_TRANSITION");
    }
  });

  it("rejects CANCELLED -> RUNNING and FAILED -> RUNNING (terminal states have no exits)", () => {
    for (const state of ["CANCELLED", "FAILED", "SUCCEEDED"] as const) {
      const result = evaluate(state, makeCommand({ type: "start_task" }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection.kind).toBe("illegal_transition");
      }
    }
  });

  it("rejects FAILED -> RETRYING without a retry event (missing authorization)", () => {
    // The row exists, so this is a policy violation naming the missing record —
    // not an illegal-transition rejection. With the authorization it is legal.
    const without = evaluate("FAILED", makeCommand({ type: "retry_task" }));

    expect(without.ok).toBe(false);
    if (!without.ok) {
      expect(without.rejection.kind).toBe("policy_violation");
      expect(without.rejection.code).toBe("TASK_RETRY_AUTHORIZATION_REQUIRED");
    }

    const exceeding = evaluate(
      "FAILED",
      makeCommand({ type: "retry_task", failure_event_id: "evt_failed_1", attempt: 4 }),
    );

    expect(exceeding.ok).toBe(false);
    if (!exceeding.ok) {
      expect(exceeding.rejection.code).toBe("TASK_RETRY_BOUND_EXCEEDED");
    }

    const authorized = evaluate(
      "FAILED",
      makeCommand({ type: "retry_task", failure_event_id: "evt_failed_1", attempt: 3 }),
    );

    expect(authorized.ok).toBe(true);
  });

  it("rejects a version conflict with expected/actual in the detail", () => {
    const result = evaluate("RUNNING", makeCommand({ type: "complete_task", expected_version: 2 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe("version_conflict");
      expect(result.rejection.code).toBe("TASK_VERSION_CONFLICT");
      expect(result.rejection.detail).toEqual({ expected_version: 2, actual_version: 3 });
    }
  });

  it("deduplicates a repeated idempotency key before any other check", () => {
    const result = evaluate("RUNNING", makeCommand({ type: "complete_task" }), {
      applied: ["idem_001"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.kind).toBe("duplicate_command");
      expect(result.rejection.code).toBe("TASK_DUPLICATE_COMMAND");
    }

    const fresh = evaluate("RUNNING", makeCommand({ type: "complete_task" }), {
      applied: ["idem_other"],
    });

    expect(fresh.ok).toBe(true);
  });

  it("rejects an actor the row does not allow (agents cannot cancel; only users grant approval)", () => {
    const agentCancel = evaluate(
      "RUNNING",
      makeCommand({ type: "cancel_task", actor: { type: "agent", id: "agent_researcher" } }),
    );

    expect(agentCancel.ok).toBe(false);
    if (!agentCancel.ok) {
      expect(agentCancel.rejection.kind).toBe("actor_not_allowed");
      expect(agentCancel.rejection.code).toBe("TASK_ACTOR_NOT_ALLOWED");
    }

    const agentGrant = evaluate(
      "WAITING_FOR_APPROVAL",
      makeCommand({
        type: "approval_granted",
        approval_id: "apr_001",
        actor: { type: "agent", id: "agent_researcher" },
      }),
    );

    expect(agentGrant.ok).toBe(false);
    if (!agentGrant.ok) {
      expect(agentGrant.rejection.kind).toBe("actor_not_allowed");
    }
  });

  it("rejects a command whose shape violates its contract, as data not an exception", () => {
    expect(() => parseTaskCommand("please just run the thing for me")).not.toThrow();

    const prose = parseTaskCommand("please just run the thing for me");
    expect(prose.ok).toBe(false);
    if (!prose.ok) {
      expect(prose.rejection.kind).toBe("malformed_command");
      expect(prose.rejection.code).toBe("TASK_COMMAND_MALFORMED");
    }

    const unknownType = parseTaskCommand({ type: "vibes.execute" });
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) {
      expect(unknownType.rejection.kind).toBe("malformed_command");
    }
  });

  it("lists the commands that the current state accepts in an illegal-transition rejection", () => {
    const result = evaluate("PAUSED", makeCommand({ type: "complete_task" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.detail).toEqual({
        state: "PAUSED",
        allowed_commands: ["cancel_task", "resume_task"],
      });
    }
  });
});
