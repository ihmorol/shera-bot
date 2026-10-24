/**
 * S13 chunk 1 — contract tests: Operation record, roster-change commands,
 * operation runs, and the D7 collaboration event union.
 *
 * Governing decisions: D7 (collaboration events), D31 (Operation framing),
 * D34/D46 (delegation parent link), D36 (roster risk classification),
 * D42/D49 (coordinator lifecycle), D25 (strict contracts, typed errors).
 * Vocabulary: Pack → Operations → Agents ("Agent", "Operation" — never
 * "Expert", never "Scene").
 */
import { describe, expect, it } from "vitest";

import {
  AddRosterAgentCommand,
  OPERATION_COLLABORATION_EVENT_TYPES,
  OPERATION_ROSTER_COMMAND_TYPES,
  OperationCollaborationEvent,
  OperationRecord,
  OperationRun,
  RemoveRosterAgentCommand,
  ROSTER_REFUSAL_CODES,
  RosterRefusal,
} from "@shera-bot/contracts";

const NOW = "2026-10-24T00:00:00.000Z";

type AnyResult = {
  success: boolean;
  error?: { issues: Array<{ code: string; path: unknown[]; message: string }> };
};

function expectTypedIssue(result: AnyResult, expectedPath: string, expectedCode: string): void {
  expect(result.success).toBe(false);
  if (result.success) {
    return;
  }
  const issues = result.error?.issues ?? [];
  const issue = issues.find(
    (candidate) =>
      candidate.code === expectedCode && candidate.path.map(String).join(".") === expectedPath,
  );
  expect(
    issue,
    `expected a ${expectedCode} issue at ${expectedPath}, got ${JSON.stringify(issues)}`,
  ).toBeDefined();
}

function baseOperationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: "op_001",
    workspace_id: "ws_default_01",
    definition_ref: "agent-packs/student/v1/operations/research-paper@1.0.0",
    name: "Research Paper",
    status: "active",
    coordinator_agent_id: "agent_general_assistant",
    pinning: {
      pack_id: "agent-packs/student/v1",
      pack_version: "1.0.0",
      roster_agent_ids: ["agent_general_assistant", "agent_researcher"],
      capabilities: ["skill_planning_core"],
      provider_snapshot: {},
    },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run_001",
    workspace_id: "ws_default_01",
    operation_id: "op_001",
    parent_task_id: null,
    state: "CREATED",
    events_seq_cursor: 0,
    provider_snapshot: { provider_id: "provider_platform", model: "platform-default" },
    credits: {},
    artifacts: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function baseRosterCommandEnvelope(): Record<string, unknown> {
  return {
    command_id: "cmd_001",
    idempotency_key: "idem_cmd_001",
    workspace_id: "ws_default_01",
    operation_id: "op_001",
    actor: { type: "user", id: "user_emon" },
    issued_at: NOW,
  };
}

function baseAddCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...baseRosterCommandEnvelope(),
    type: "operation.add_roster_agent",
    agent_id: "agent_developer",
    pack_id: "agent-packs/student/v1",
    pack_version: "1.0.0",
    risk: {
      same_pack: true,
      cost_or_access_increasing: false,
      requires_approval: false,
    },
    ...overrides,
  };
}

const D7_PAYLOAD_SAMPLES: Record<string, Record<string, unknown>> = {
  TaskProposed: {
    task_description: "Summarize the weekly report",
    proposed_assignee_agent_id: "agent_researcher",
  },
  TaskAccepted: { proposal_event_id: "evt_proposed_001" },
  TaskDelegated: { task_description: "Draft the report outline" },
  ProgressReported: { progress_text: "Outline drafted, filling sections" },
  ArtifactPublished: { artifact_ref: "artifact_001" },
  ApprovalRequested: { approval_request_ref: "approval_001" },
  QuestionRaised: { question_text: "Which citation style is required?" },
  TaskBlocked: { blocked_reason: "Waiting on credentials" },
  TaskFailed: { failure_class: "provider_error" },
  TaskCompleted: { completion_summary: "Report delivered" },
  HandoffRequested: { handoff_reason: "Coordinator context exhausted" },
};

function collaborationEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: `evt_${type.toLowerCase()}_001`,
    type,
    workspace_id: "ws_default_01",
    operation_id: "op_001",
    run_id: null,
    sender_agent_id: "agent_general_assistant",
    recipient_agent_ids: [],
    correlation_id: "corr_001",
    issued_at: NOW,
    payload,
    ...overrides,
  };
}

describe("Operation record contract (D31, D42, D49)", () => {
  it("parses a valid operation record", () => {
    const result = OperationRecord.safeParse(baseOperationRecord());
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('accepts the coordinator literal "none" (D42/D49)', () => {
    const result = OperationRecord.safeParse(baseOperationRecord({ coordinator_agent_id: "none" }));
    expect(result.success).toBe(true);
  });

  it("accepts a concrete coordinator agent id", () => {
    const result = OperationRecord.safeParse(
      baseOperationRecord({ coordinator_agent_id: "agent_study_planner" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an empty coordinator agent id", () => {
    const result = OperationRecord.safeParse(baseOperationRecord({ coordinator_agent_id: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = OperationRecord.safeParse(baseOperationRecord({ status: "paused" }));
    expect(result.success).toBe(false);
  });

  it("rejects a missing name with a typed error", () => {
    const result = OperationRecord.safeParse(baseOperationRecord({ name: undefined }));
    expectTypedIssue(result as AnyResult, "name", "invalid_type");
  });

  it("accepts a provider snapshot placeholder in pinning", () => {
    const result = OperationRecord.safeParse(
      baseOperationRecord({
        pinning: {
          pack_id: "agent-packs/student/v1",
          pack_version: "1.0.0",
          roster_agent_ids: ["agent_general_assistant"],
          capabilities: [],
          provider_snapshot: { provider_id: "provider_local", model: "qwen3-8b" },
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("Roster-change command contracts (D36)", () => {
  it("allows a same-pack low-risk addition without approval", () => {
    const result = AddRosterAgentCommand.safeParse(baseAddCommand());
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("requires approval for a cost/access-increasing addition", () => {
    const result = AddRosterAgentCommand.safeParse(
      baseAddCommand({
        risk: {
          same_pack: true,
          cost_or_access_increasing: true,
          requires_approval: true,
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("refuses a cost/access-increasing addition flagged as approval-free", () => {
    const result = AddRosterAgentCommand.safeParse(
      baseAddCommand({
        risk: {
          same_pack: true,
          cost_or_access_increasing: true,
          requires_approval: false,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : JSON.stringify(result.error.issues)).toContain(
      "cost-increase-needs-approval",
    );
  });

  it("refuses a foreign-pack addition outright with a typed refusal code", () => {
    const result = AddRosterAgentCommand.safeParse(
      baseAddCommand({
        pack_id: "agent-packs/other/v1",
        risk: {
          same_pack: false,
          cost_or_access_increasing: false,
          requires_approval: true,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(result.success ? "" : JSON.stringify(result.error.issues)).toContain(
      "foreign-pack-refused",
    );
  });

  it("parses a roster removal command (D49: removable at any time)", () => {
    const result = RemoveRosterAgentCommand.safeParse({
      ...baseRosterCommandEnvelope(),
      type: "operation.remove_roster_agent",
      agent_id: "agent_researcher",
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("rejects a removal command with a missing idempotency key (typed envelope)", () => {
    const envelope = baseRosterCommandEnvelope();
    delete envelope["idempotency_key"];
    const result = RemoveRosterAgentCommand.safeParse({
      ...envelope,
      type: "operation.remove_roster_agent",
      agent_id: "agent_researcher",
    });
    expectTypedIssue(result as AnyResult, "idempotency_key", "invalid_type");
  });

  it("exposes the roster command type literals", () => {
    expect([...OPERATION_ROSTER_COMMAND_TYPES]).toEqual([
      "operation.add_roster_agent",
      "operation.remove_roster_agent",
    ]);
  });

  it("accepts every typed refusal code and rejects unknown ones", () => {
    for (const refusal_code of ROSTER_REFUSAL_CODES) {
      const result = RosterRefusal.safeParse({
        refusal_code,
        message: "blocked by roster policy",
        agent_id: "agent_developer",
        pack_id: "agent-packs/other/v1",
      });
      expect(result.success, `refusal code ${refusal_code} should parse`).toBe(true);
    }
    const unknown = RosterRefusal.safeParse({
      refusal_code: "because-i-said-so",
      message: "nope",
    });
    expect(unknown.success).toBe(false);
  });
});

describe("Operation run contract (D31, D34, D46)", () => {
  it("accepts a run with parent_task_id null (top-level operation run)", () => {
    const result = OperationRun.safeParse(baseRun());
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("accepts a run with parent_task_id set (D34/D46 delegation link)", () => {
    const result = OperationRun.safeParse(baseRun({ parent_task_id: "task_042" }));
    expect(result.success).toBe(true);
  });

  it("rejects a missing run_id with a typed error", () => {
    const result = OperationRun.safeParse(baseRun({ run_id: undefined }));
    expectTypedIssue(result as AnyResult, "run_id", "invalid_type");
  });

  it("rejects a state outside the D8 vocabulary (no second state machine)", () => {
    const result = OperationRun.safeParse(baseRun({ state: "pending" }));
    expect(result.success).toBe(false);
  });

  it("rejects a negative events_seq_cursor", () => {
    const result = OperationRun.safeParse(baseRun({ events_seq_cursor: -1 }));
    expect(result.success).toBe(false);
  });
});

describe("D7 collaboration event union", () => {
  it("exposes exactly the 11 D7 event types", () => {
    expect([...OPERATION_COLLABORATION_EVENT_TYPES]).toEqual([
      "TaskProposed",
      "TaskAccepted",
      "TaskDelegated",
      "ProgressReported",
      "ArtifactPublished",
      "ApprovalRequested",
      "QuestionRaised",
      "TaskBlocked",
      "TaskFailed",
      "TaskCompleted",
      "HandoffRequested",
    ]);
  });

  for (const [type, payload] of Object.entries(D7_PAYLOAD_SAMPLES)) {
    it(`parses a valid ${type} event`, () => {
      const result = OperationCollaborationEvent.safeParse(collaborationEvent(type, payload));
      expect(result.success, JSON.stringify(result)).toBe(true);
    });

    it(`rejects ${type} missing a required payload field with a typed error`, () => {
      const firstKey = Object.keys(payload)[0];
      if (!firstKey) {
        throw new Error("sample payload must have at least one field");
      }
      const incompletePayload = { ...payload };
      delete incompletePayload[firstKey];
      const result = OperationCollaborationEvent.safeParse(
        collaborationEvent(type, incompletePayload),
      );
      expectTypedIssue(result as AnyResult, `payload.${firstKey}`, "invalid_type");
    });
  }

  it("rejects an unknown event type", () => {
    const result = OperationCollaborationEvent.safeParse(
      collaborationEvent("Teleported", { note: "nope" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(
        result.error.issues.every((issue: { code: string }) => typeof issue.code === "string"),
      ).toBe(true);
    }
  });

  it("rejects unknown payload keys (strictObject)", () => {
    const result = OperationCollaborationEvent.safeParse(
      collaborationEvent("TaskProposed", {
        task_description: "Summarize",
        proposed_assignee_agent_id: "agent_researcher",
        extra: true,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue: { code: string }) => issue.code === "unrecognized_keys"),
        JSON.stringify(result.error.issues),
      ).toBe(true);
    }
  });

  it("rejects a run_id that is neither null nor a string", () => {
    const result = OperationCollaborationEvent.safeParse(
      collaborationEvent(
        "ProgressReported",
        { progress_text: "ok" },
        {
          run_id: 5,
        },
      ),
    );
    expectTypedIssue(result as AnyResult, "run_id", "invalid_type");
  });

  it("accepts an empty recipient_agent_ids list (Operation-wide broadcast)", () => {
    const result = OperationCollaborationEvent.safeParse(
      collaborationEvent("QuestionRaised", { question_text: "Anyone free?" }),
    );
    expect(result.success).toBe(true);
  });
});
