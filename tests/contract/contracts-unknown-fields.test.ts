import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_REGISTRY,
  EVENT_ENVELOPES,
  EXTENSIBLE_CONTRACTS,
  type ContractName,
} from "@shera-bot/contracts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "s02");

/**
 * D25: "unknown fields are rejected for internal protocol messages unless
 * explicitly marked extensible." Every contract in the registry is strict by
 * default; the only exceptions are the names in EXTENSIBLE_CONTRACTS, each of
 * which carries a written rationale. This test is the enforcement.
 */
const CASES: ReadonlyArray<{ schema: ContractName; fixture: string }> = [
  { schema: "Session", fixture: "session.json" },
  { schema: "Pack", fixture: "pack.json" },
  { schema: "Agent", fixture: "agent.json" },
  { schema: "OperationDefinition", fixture: "operation-definition.json" },
  { schema: "Operation", fixture: "operation.json" },
  { schema: "TaskRun", fixture: "task-run.json" },
  { schema: "TypedExecutionEvent", fixture: "event-tool-proposed.json" },
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
  // The explicitly-marked-extensible case (D25 "unless"): the webhook trigger
  // payload accepts source-specific extra fields.
  { schema: "TriggerWebhookPayload", fixture: "webhook-payload.json" },
  { schema: "TaskCommandResult", fixture: "task-command-result.json" },
  { schema: "TaskRejection", fixture: "task-rejection.json" },
  { schema: "EventPage", fixture: "event-page.json" },
  { schema: "ListTaskEventsQuery", fixture: "list-task-events-query.json" },
];

describe.each(CASES)("$schema unknown-field discipline (D25)", ({ schema, fixture }) => {
  const registered = CONTRACT_REGISTRY[schema];
  const raw: Record<string, unknown> = JSON.parse(
    readFileSync(join(fixturesDir, fixture), "utf8"),
  ) as Record<string, unknown>;

  it("rejects an injected unknown top-level field unless explicitly extensible", () => {
    expect(registered, `${schema} must be exported from CONTRACT_REGISTRY`).toBeDefined();

    const poisoned = { ...raw, unknown_provenance_field: { note: "injected by contract test" } };
    const verdict = registered.safeParse(poisoned);

    if (schema in EXTENSIBLE_CONTRACTS) {
      expect(verdict.success, `${schema} is explicitly marked extensible`).toBe(true);
    } else {
      expect(verdict.success, `${schema} must reject unknown fields`).toBe(false);
    }
  });
});

describe("explicit extensibility registry", () => {
  it("documents a rationale for every extensible contract", () => {
    for (const [name, rationale] of Object.entries(EXTENSIBLE_CONTRACTS)) {
      expect(typeof rationale, `${name} rationale`).toBe("string");
      expect((rationale as string).length, `${name} rationale non-empty`).toBeGreaterThan(0);
    }
  });

  it("keeps nested pack members strict (Agent inside Pack)", () => {
    const pack: Record<string, unknown> = JSON.parse(
      readFileSync(join(fixturesDir, "pack.json"), "utf8"),
    );
    const agents = pack["agents"];
    expect(Array.isArray(agents)).toBe(true);

    const poisonedAgent = { ...(agents as Array<Record<string, unknown>>)[0] };
    poisonedAgent["unknown_nested_field"] = true;

    const verdict = CONTRACT_REGISTRY.Pack.safeParse({ ...pack, agents: [poisonedAgent] });
    expect(verdict.success).toBe(false);
  });
});

// Registry-driven enforcement (review fix 2026-09-19): every registered
// top-level schema must be poisoned in the unknown-field suite, so a schema
// added without strictness (non-strictObject) or without a case fails here.
describe("contract registry completeness", () => {
  it("every registered top-level schema has an unknown-field case", () => {
    const envelopeKeys = new Set(Object.keys(EVENT_ENVELOPES));
    const covered = new Set(CASES.map((c) => c.schema));
    const missing = Object.keys(CONTRACT_REGISTRY).filter(
      (name) => !envelopeKeys.has(name) && !covered.has(name as ContractName),
    );
    expect(
      missing,
      `Schemas registered without an unknown-field case: ${missing.join(", ")}. ` +
        "Add a committed fixture + case, or (envelopes only) rely on the TypedExecutionEvent union coverage.",
    ).toEqual([]);
  });
});
