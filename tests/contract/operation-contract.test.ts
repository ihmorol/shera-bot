/**
 * S13 Chunk 1 — red-first contract tests: Operation records, roster-change
 * commands, operation runs, and the D7 collaboration event union.
 *
 * Governing decisions: D7 (collaboration events), D31 (Operation framing),
 * D34/D46 (delegation parent link), D36 (roster risk classification),
 * D42 (closure), D49 (open items).
 * Vocabulary: Pack → Operations → Agents ("Agent", "Operation" — never
 * "Expert", never "Scene").
 */
import { describe, expect, it } from "vitest";

import {
  AddRosterAgentCommandSchema,
  OPERATION_COLLABORATION_EVENT_TYPES,
  OPERATION_ROSTER_COMMAND_TYPES,
  OperationCollaborationEventSchema,
  OperationRecordSchema,
  OperationRunSchema,
  RemoveRosterAgentCommandSchema,
  ROSTER_REFUSAL_CODES,
  RosterRefusalSchema,
} from "../../packages/contracts/src/operation";

const NOW = "2026-10-24T00:00:00.000Z";

type AnyResult = {
  success: boolean;
  error?: { issues: Array<{ code: string; path: unknown[]; message: string }> };
};

function expectTypedIssue(
  result: AnyResult,
  expectedPath: string,
  expectedCode: string,
): void {
  expect(result.success).toBe(false);
  if (result.success) {
    return;
  }
  const issue = result.error.issues.find(
    (candidate) =>
      candidate.code === expectedCode &&
      candidate.path.map(String).join(".") === expectedPath,
  );
  expect(
    issue,
    `expected a ${expectedCode} issue at ${expectedPath}, got ${JSON.stringify(result.error.issues)}`,
  ).toBeDefined();
}

function baseOperationRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation_id: "op-001",
    workspace_id: "ws-001",
    definition_ref: "pack-core/operations/weekly-report@1",
    name: "Weekly report",
    status: "active",
    coordinator_agent_id: "agent-001",
    pinning: {
      pack_id: "pack-core",
      pack_version: "1.2.0",
      roster_agent_ids: ["agent-001", "agent-002"],
      capabilities: ["report.summarize"],
      provider_snapshot: {},
    },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-001",
    operation_id: "op-001",
    parent_task_id: null,
    status: "pending",
    events_seq_cursor: 0,
    provider_snapshot: {},
    credits: {},
    artifacts: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function baseAddCommand(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command_type: "operation.add_roster_agent",
    operation_id: "op-001",
    agent_id: "agent-003",
    pack_id: "pack-core",
    pack_version: "1.2.0",
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
    proposed_assignee_agent_id: "agent-002",
  },
  TaskAccepted: { proposal_event_id: "evt-proposed-001" },
  TaskDelegated: { task_description: "Draft the report outline" },
  ProgressReported: { progress_text: "Outline drafted, filling sections" },
  ArtifactPublished: { artifact_ref: "artifact://run-001/report.md" },
  ApprovalRequested: { approval_request_ref: "approval-001" },
  QuestionRaised: { question_text: "Which currency for the totals?" },
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
    event_id: `evt-${type.toLowerCase()}-001`,
    type,
    operation_id: "op-001",
    run_id: null,
    sender_agent_id: "agent-001",
    recipient_agent_ids: [],
    correlation_id: "corr-001",
    issued_at: NOW,
    payload,
    ...overrides,
  };
}

describe("Operation record contract (D31)", () => {
  it("parses a valid operation record", () => {
    const result = OperationRecordSchema.safeParse(baseOperationRecord());
    expect(result.success).toBe(true);
  });

  it("accepts the coordinator literal \"none\"", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({ coordinator_agent_id: "none" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a concrete coordinator agent id", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({ coordinator_agent_id: "agent-009" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an empty coordinator agent id", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({ coordinator_agent_id: "" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({ status: "paused" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a missing name with a typed error", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({ name: undefined }),
    );
    expectTypedIssue(result as AnyResult, "name", "invalid_type");
  });

  it("accepts a provider snapshot placeholder in pinning", () => {
    const result = OperationRecordSchema.safeParse(
      baseOperationRecord({
        pinning: {
          pack_id: "pack-core",
          pack_version: "1.2.0",
          roster_agent_ids: ["agent-001"],
          capabilities: [],
          provider_snapshot: { provider: "openai", model: "gpt-5" },
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("Roster-change command contracts (D36)", () => {
  it("allows a same-pack low-risk addition without approval", () => {
    const result = AddRosterAgentCommandSchema.safeParse(baseAddCommand());
    expect(result.success).toBe(true);
  });

  it("requires approval for a cost/access-increasing addition", () => {
    const result = AddRosterAgentCommandSchema.safeParse(
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
    const result = AddRosterAgentCommandSchema.safeParse(
      baseAddCommand({
        risk: {
          same_pack: true,
          cost_or_access_increasing: true,
          requires_approval: false,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.success ? "" : JSON.stringify(result.error.issues),
    ).toContain("cost-increase-needs-approval");
  });

  it("refuses a foreign-pack addition outright with a typed refusal code", () => {
    const result = AddRosterAgentCommandSchema.safeParse(
      baseAddCommand({
        risk: {
          same_pack: false,
          cost_or_access_increasing: false,
          requires_approval: true,
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(
      result.success ? "" : JSON.stringify(result.error.issues),
    ).toContain("foreign-pack-refused");
  });

  it("parses a roster removal command", () => {
    const result = RemoveRosterAgentCommandSchema.safeParse({
      command_type: "operation.remove_roster_agent",
      operation_id: "op-001",
      agent_id: "agent-002",
    });
    expect(result.success).toBe(true);
  });

  it("exposes the roster command type literals", () => {
    expect([...OPERATION_ROSTER_COMMAND_TYPES]).toEqual([
      "operation.add_roster_agent",
      "operation.remove_roster_agent",
    ]);
  });

  it("accepts every typed refusal code and rejects unknown ones", () => {
    for (const refusal_code of ROSTER_REFUSAL_CODES) {
      const result = RosterRefusalSchema.safeParse({
        refusal_code,
        message: "blocked by roster policy",
        agent_id: "agent-003",
        pack_id: "pack-foreign",
      });
      expect(result.success, `refusal code ${refusal_code} should parse`).toBe(
        true,
      );
    }
    const unknown = RosterRefusalSchema.safeParse({
      refusal_code: "because-i-said-so",
      message: "nope",
    });
    expect(unknown.success).toBe(false);
  });
});

describe("Operation run contract (D34/D46)", () => {
  it("accepts a run with parent_task_id null (top-level operation run)", () => {
    const result = OperationRunSchema.safeParse(baseRun());
    expect(result.success).toBe(true);
  });

  it("accepts a run with parent_task_id set (delegation link)", () => {
    const result = OperationRunSchema.safeParse(
      baseRun({ parent_task_id: "task-042" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a missing run_id with a typed error", () => {
    const result = OperationRunSchema.safeParse(baseRun({ run_id: undefined }));
    expectTypedIssue(result as AnyResult, "run_id", "invalid_type");
  });

  it("rejects a negative events_seq_cursor", () => {
    const result = OperationRunSchema.safeParse(
      baseRun({ events_seq_cursor: -1 }),
    );
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
      const result = OperationCollaborationEventSchema.safeParse(
        collaborationEvent(type, payload),
      );
      expect(result.success, JSON.stringify(result)).toBe(true);
    });

    it(`rejects ${type} missing a required payload field with a typed error`, () => {
      const firstKey = Object.keys(payload)[0];
      if (!firstKey) {
        throw new Error("sample payload must have at least one field");
      }
      const incompletePayload = { ...payload };
      delete incompletePayload[firstKey];
      const result = OperationCollaborationEventSchema.safeParse(
        collaborationEvent(type, incompletePayload),
      );
      expectTypedIssue(result as AnyResult, `payload.${firstKey}`, "invalid_type");
    });
  }

  it("rejects an unknown event type", () => {
    const result = OperationCollaborationEventSchema.safeParse(
      collaborationEvent("Teleported", { note: "nope" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(
        result.error.issues.every(
          (issue: { code: string }) => typeof issue.code === "string",
        ),
      ).toBe(true);
    }
  });

  it("rejects unknown payload keys (strictObject)", () => {
    const result = OperationCollaborationEventSchema.safeParse(
      collaborationEvent("TaskProposed", {
        task_description: "Summarize",
        proposed_assignee_agent_id: "agent-002",
        extra: true,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue: { code: string }) => issue.code === "unrecognized_keys",
        ),
        JSON.stringify(result.error.issues),
      ).toBe(true);
    }
  });

  it("rejects a run_id that is neither null nor a string", () => {
    const result = OperationCollaborationEventSchema.safeParse(
      collaborationEvent("ProgressReported", { progress_text: "ok" }, {
        run_id: 5,
      }),
    );
    expectTypedIssue(result as AnyResult, "run_id", "invalid_type");
  });

  it("accepts an empty recipient_agent_ids list (operation-wide)", () => {
    const result = OperationCollaborationEventSchema.safeParse(
      collaborationEvent("QuestionRaised", { question_text: "Anyone free?" }),
    );
    expect(result.success).toBe(true);
  });
});
