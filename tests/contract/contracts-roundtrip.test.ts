import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACT_REGISTRY, EVENT_ENVELOPES, type ContractName } from "@shera-bot/contracts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "s02");

/**
 * Round-trip contract tests (S02, D25 "schema changes require contract tests").
 * Every case: committed fixture -> parse -> serialize -> parse -> deep-equal.
 * The fixtures are the recorded evidence of the agreed wire shape; a schema
 * change that breaks them fails here before it can break a consumer.
 */
const ROUND_TRIP_CASES: ReadonlyArray<{ schema: ContractName; fixture: string }> = [
  { schema: "Session", fixture: "session.json" },
  { schema: "Pack", fixture: "pack.json" },
  { schema: "Agent", fixture: "agent.json" },
  { schema: "OperationDefinition", fixture: "operation-definition.json" },
  { schema: "Operation", fixture: "operation.json" },
  { schema: "TaskRun", fixture: "task-run.json" },
  { schema: "TypedExecutionEvent", fixture: "event-tool-proposed.json" },
  { schema: "TypedExecutionEvent", fixture: "event-delegation-proposed.json" },
  { schema: "TypedExecutionEvent", fixture: "event-approval-requested.json" },
  { schema: "TypedExecutionEvent", fixture: "event-operation-confirmed.json" },
  { schema: "TypedExecutionEvent", fixture: "event-trigger-scheduled.json" },
  { schema: "TypedExecutionEvent", fixture: "event-trigger-webhook.json" },
  { schema: "TypedExecutionEvent", fixture: "event-trigger-file.json" },
  { schema: "TypedExecutionEvent", fixture: "event-task-started.json" },
  { schema: "ApprovalRequest", fixture: "approval-request.json" },
  { schema: "ApprovalGrant", fixture: "approval-grant.json" },
  { schema: "ArtifactRef", fixture: "artifact-ref.json" },
  { schema: "CreditReservation", fixture: "credit-reservation.json" },
  { schema: "CreditSettlement", fixture: "credit-settlement.json" },
  { schema: "CreditRelease", fixture: "credit-release.json" },
  { schema: "MemoryEntry", fixture: "memory-entry.json" },
  { schema: "ToolDefinition", fixture: "tool-definition.json" },
  { schema: "CollaborationMessage", fixture: "collaboration-message.json" },
  { schema: "SheraError", fixture: "shera-error.json" },
  { schema: "TaskCommand", fixture: "task-command.json" },
  { schema: "TriggerWebhookPayload", fixture: "webhook-payload.json" },
  { schema: "TaskCommandResult", fixture: "task-command-result.json" },
  { schema: "TaskRejection", fixture: "task-rejection.json" },
  { schema: "EventPage", fixture: "event-page.json" },
  { schema: "ListTaskEventsQuery", fixture: "list-task-events-query.json" },
  // S06 (runtime backend contract + internal channel; D12, D2).
  { schema: "ResourceSummary", fixture: "resource-summary.json" },
  { schema: "ProvisionRuntimeInput", fixture: "provision-runtime-input.json" },
  { schema: "ProvisionRuntimeResult", fixture: "provision-runtime-result.json" },
  { schema: "ResumeRuntimeInput", fixture: "resume-runtime-input.json" },
  { schema: "ResumeRuntimeResult", fixture: "resume-runtime-result.json" },
  { schema: "StopRuntimeInput", fixture: "stop-runtime-input.json" },
  { schema: "StopRuntimeResult", fixture: "stop-runtime-result.json" },
  { schema: "GetRuntimeStatusInput", fixture: "get-runtime-status-input.json" },
  { schema: "RuntimeStatus", fixture: "runtime-status.json" },
  { schema: "RuntimeRegistrationRequest", fixture: "runtime-registration-request.json" },
  { schema: "RuntimeRegistrationResponse", fixture: "runtime-registration-response.json" },
  {
    schema: "RuntimeCredentialRotationRequest",
    fixture: "runtime-credential-rotation-request.json",
  },
  {
    schema: "RuntimeCredentialRotationResponse",
    fixture: "runtime-credential-rotation-response.json",
  },
  { schema: "RuntimeCredentialCommitRequest", fixture: "runtime-credential-commit-request.json" },
  { schema: "RuntimeCredentialCommitResponse", fixture: "runtime-credential-commit-response.json" },
  // S11 (D16 agent settings command surface; one case per union member).
  { schema: "AgentSettingsCommand", fixture: "agent-settings-command-update-instructions.json" },
  {
    schema: "AgentSettingsCommand",
    fixture: "agent-settings-command-update-default-provider.json",
  },
  { schema: "AgentSettingsCommand", fixture: "agent-settings-command-update-tool-defaults.json" },
  { schema: "AgentSettingsCommand", fixture: "agent-settings-command-reset-setting.json" },
  { schema: "AgentSettingsCommand", fixture: "agent-settings-command-reset-all.json" },
  { schema: "AgentSettingsSnapshot", fixture: "agent-settings-snapshot.json" },
  { schema: "AgentSettingsOverrides", fixture: "agent-settings-overrides.json" },
  // S13 chunk 1 (Operation chat: persisted record, D36 roster commands,
  // operation runs, D7 collaboration event union).
  { schema: "OperationRecord", fixture: "operation-record.json" },
  { schema: "OperationRun", fixture: "operation-run.json" },
  { schema: "AddRosterAgentCommand", fixture: "operation-roster-add-command.json" },
  { schema: "RemoveRosterAgentCommand", fixture: "operation-roster-remove-command.json" },
  { schema: "RosterRefusal", fixture: "operation-roster-refusal.json" },
  { schema: "OperationCollaborationEvent", fixture: "operation-collaboration-event.json" },
  // S14 chunk 1 (ad-hoc creation + rename; D41, D23 rule 6).
  { schema: "OperationRenameCommand", fixture: "operation-rename-command.json" },
  // S15 chunk 1 (D30 launch preview read model: the eight groups).
  { schema: "OperationLaunchPreview", fixture: "operation-launch-preview.json" },
  // S15 chunk 3 (the D30 confirm step: the launch envelope + its receipt).
  { schema: "OperationLaunchCommand", fixture: "operation-launch-command.json" },
  { schema: "OperationLaunchReceipt", fixture: "operation-launch-receipt.json" },
];

describe.each(ROUND_TRIP_CASES)("$schema round-trip ($fixture)", ({ schema, fixture }) => {
  const registered = CONTRACT_REGISTRY[schema];
  const raw: unknown = JSON.parse(readFileSync(join(fixturesDir, fixture), "utf8"));

  it("parses the committed fixture and is stable across an encode/decode cycle", () => {
    expect(registered, `${schema} must be exported from CONTRACT_REGISTRY`).toBeDefined();

    const parsed = registered.parse(raw);
    const reparsed = registered.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
  });

  it("is idempotent under repeated parse (defaults do not drift)", () => {
    const once = registered.parse(raw);
    const twice = registered.parse(once);

    expect(twice).toEqual(once);
  });
});

// Registry-driven enforcement (review fix 2026-09-19): the registry docstring
// promises that a schema added without a fixture case fails the suite. This
// test makes that true. Envelope-union members are exempt: they are covered
// through the TypedExecutionEvent cases (the union test asserts every
// envelope's shape).
describe("contract registry completeness", () => {
  it("every registered top-level schema has a round-trip fixture case", () => {
    const envelopeKeys = new Set(Object.keys(EVENT_ENVELOPES));
    const covered = new Set(ROUND_TRIP_CASES.map((c) => c.schema));
    const missing = Object.keys(CONTRACT_REGISTRY).filter(
      (name) => !envelopeKeys.has(name) && !covered.has(name as ContractName),
    );
    expect(
      missing,
      `Schemas registered without a round-trip fixture case: ${missing.join(", ")}. ` +
        "Add a committed fixture + case, or (envelopes only) rely on the TypedExecutionEvent union coverage.",
    ).toEqual([]);
  });
});
