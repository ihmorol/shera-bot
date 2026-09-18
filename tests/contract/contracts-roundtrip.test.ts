import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACT_REGISTRY, type ContractName } from "@shera-bot/contracts";

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
