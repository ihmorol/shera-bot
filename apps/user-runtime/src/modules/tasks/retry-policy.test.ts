/**
 * S22 chunk 1 — the retry POLICY is pure and runtime-owned (AC14, AC2, AC10,
 * PRD §8, E13, D20). Red-first: this suite pins the classification table and
 * the bounded decision function BEFORE the implementation exists.
 *
 * The three honest outcomes for one failure:
 *  - transient     → retry with bounded backoff, at most three attempts
 *                    (PRD §8: "retry transient failures with bounded backoff
 *                    up to three times, then pause and notify");
 *  - non-transient → fail immediately with the typed error (never retried);
 *  - ambiguous     → never blindly retried — the run pauses for review with
 *                    the reason recorded (E13; D20: "ambiguous outcomes are
 *                    not blindly retried").
 *
 * Retry decisions are RUNTIME-owned: nothing here takes an agent-supplied
 * attempt bound — the max is the policy's, the classification is the
 * runtime's data table (G2), and an UNKNOWN failure code classifies as
 * ambiguous (fail-closed: an unclassified failure is never blindly retried).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  RETRY_BACKOFF_SCHEDULE_MS,
  classifyFailure,
  decideRetry,
} from "./retry-policy.ts";

describe("classifyFailure (the runtime's typed classification table)", () => {
  it("classifies timeout-class failures as transient", () => {
    expect(classifyFailure("TOOL_EXECUTION_TIMEOUT")).toBe("transient");
    expect(classifyFailure("worker_timeout")).toBe("transient");
  });

  it("classifies connection/refusal transport shapes as transient", () => {
    expect(classifyFailure("TRANSIENT_NETWORK")).toBe("transient");
    expect(classifyFailure("provider_rate_limited")).toBe("transient");
  });

  it("classifies validation and budget failures as permanent (fail immediately)", () => {
    expect(classifyFailure("TOOL_ARGS_INVALID")).toBe("permanent");
    expect(classifyFailure("TOOL_RESPONSE_TOO_LARGE")).toBe("permanent");
    expect(classifyFailure("WORKER_PROTOCOL_VIOLATION")).toBe("permanent");
  });

  it("classifies ambiguous-effect codes as ambiguous (never blindly retried)", () => {
    expect(classifyFailure("EXTERNAL_EFFECT_UNCONFIRMED")).toBe("ambiguous");
    expect(classifyFailure("PROVIDER_RESPONSE_AMBIGUOUS")).toBe("ambiguous");
  });

  it("classifies an UNKNOWN failure code as ambiguous (fail-closed default)", () => {
    // An unclassified failure must never be blindly retried (E13 needs_human
    // default): the honest answer is the pause-for-review path.
    expect(classifyFailure("SOMETHING_NOBODY_NAMED")).toBe("ambiguous");
  });
});

describe("decideRetry (the bounded, runtime-owned decision)", () => {
  it("retries a transient failure with the bounded backoff delay for the attempt", () => {
    const first = decideRetry({
      failureCode: "TOOL_EXECUTION_TIMEOUT",
      attemptsSoFar: 0,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(first).toEqual({ action: "retry", attempt: 1, delayMs: RETRY_BACKOFF_SCHEDULE_MS[0] });

    const second = decideRetry({
      failureCode: "TOOL_EXECUTION_TIMEOUT",
      attemptsSoFar: 1,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(second).toEqual({ action: "retry", attempt: 2, delayMs: RETRY_BACKOFF_SCHEDULE_MS[1] });
  });

  it("pauses with the retry_exhausted reason after the last policy attempt (AC14)", () => {
    // attemptsSoFar === maxAttempts: the bound is reached; the run pauses.
    const verdict = decideRetry({
      failureCode: "TOOL_EXECUTION_TIMEOUT",
      attemptsSoFar: DEFAULT_RETRY_POLICY.maxAttempts,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(verdict).toEqual({ action: "pause", reason: "retry_exhausted" });
  });

  it("never schedules a fourth retry (PRD §8: at most three attempts)", () => {
    const verdict = decideRetry({
      failureCode: "TOOL_EXECUTION_TIMEOUT",
      attemptsSoFar: DEFAULT_RETRY_POLICY.maxAttempts + 5,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(verdict).not.toEqual(
      expect.objectContaining({ action: "retry", attempt: expect.any(Number) }),
    );
  });

  it("fails a non-transient failure immediately with its typed code (AC2)", () => {
    const verdict = decideRetry({
      failureCode: "TOOL_ARGS_INVALID",
      attemptsSoFar: 0,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(verdict).toEqual({ action: "fail", code: "TOOL_ARGS_INVALID" });
  });

  it("never retries an ambiguous effect — pause for review with the reason (AC10, E13)", () => {
    const verdict = decideRetry({
      failureCode: "PROVIDER_RESPONSE_AMBIGUOUS",
      attemptsSoFar: 0,
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(verdict).toEqual({
      action: "pause_for_review",
      reason: "ambiguous_external_effect",
      code: "PROVIDER_RESPONSE_AMBIGUOUS",
    });
    // Even at zero attempts and even for a transient-looking attempt count,
    // ambiguous never maps to a retry.
    expect(
      decideRetry({
        failureCode: "EXTERNAL_EFFECT_UNCONFIRMED",
        attemptsSoFar: 0,
        policy: DEFAULT_RETRY_POLICY,
      }),
    ).toMatchObject({ action: "pause_for_review" });
  });

  it("the agent cannot widen the bound: attemptsSoFar above the policy bound still pauses", () => {
    // The decision consumes only the runtime's own attempt ledger and the
    // runtime's own policy — there is no input an agent could supply to get
    // "one more try" past the bound (G2: retry decisions are runtime-owned).
    const verdict = decideRetry({
      failureCode: "TOOL_EXECUTION_TIMEOUT",
      attemptsSoFar: Number.MAX_SAFE_INTEGER,
      policy: { maxAttempts: 3, backoffScheduleMs: [1, 2, 4] },
    });
    expect(verdict).toEqual({ action: "pause", reason: "retry_exhausted" });
  });
});
