import { describe, expect, it } from "vitest";

import {
  APPROVAL_CHOICES,
  APPROVAL_GRANT_SOURCE_CHOICES,
  APPROVAL_REMINDER_SCHEDULE_SECONDS,
} from "@shera-bot/contracts";

/**
 * PRD §8 fixes the five approval choices and the reminder sequence; D9 fixes
 * the grant field list. Both are contract data, not UI copy.
 */
describe("approval contract data (PRD §8, D9)", () => {
  it("exposes exactly the five fixed choices, in the recorded order", () => {
    expect([...APPROVAL_CHOICES]).toEqual([
      "approve-this-execution-only",
      "always-approve-this-tool",
      "always-approve-this-tool-for-this-agent",
      "reject-this-action",
      "cancel-the-task",
    ]);
  });

  it("derives grant-creating choices from the fixed five (reject/cancel create no grant)", () => {
    for (const choice of APPROVAL_GRANT_SOURCE_CHOICES) {
      expect(APPROVAL_CHOICES).toContain(choice);
    }
    expect(APPROVAL_GRANT_SOURCE_CHOICES).not.toContain("reject-this-action");
    expect(APPROVAL_GRANT_SOURCE_CHOICES).not.toContain("cancel-the-task");
    expect(APPROVAL_GRANT_SOURCE_CHOICES.length).toBe(3);
  });

  it("encodes the PRD §8 reminder schedule: immediate, 15m, 45m, 3h, 24h — none after", () => {
    expect([...APPROVAL_REMINDER_SCHEDULE_SECONDS]).toEqual([0, 900, 2700, 10800, 86400]);
  });
});
