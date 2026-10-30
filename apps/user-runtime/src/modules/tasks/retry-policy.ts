/**
 * The retry POLICY (S22; PRD §8, AC14, AC2, AC10, E13, D20, G2) — pure data
 * and a pure decision function. The runtime, not the Agent, owns retry
 * decisions (G2/D13: "Pi does not own ... retry policy"): the classification
 * is THIS module's data table, the attempt bound is THIS module's policy, and
 * there is no input by which a proposal could widen either.
 *
 * The three honest outcomes for one failure:
 *  - transient     → retry with BOUNDED backoff, at most three attempts, then
 *                    the run pauses and notifies (PRD §8). The backoff is a
 *                    fixed bounded schedule (1s → 2s → 4s, capped) — no
 *                    unbounded exponential growth, no jitter (deterministic
 *                    tests; the Temporal RetryPolicy semantics were the
 *                    pattern reference, recorded in E35).
 *  - non-transient → fail immediately with the typed error code (AC2).
 *  - ambiguous     → NEVER blindly retried (E13/D20): the run pauses for
 *                    review with the reason and the failing code recorded.
 *
 * Unknown failure codes classify as AMBIGUOUS (fail-closed): a failure the
 * runtime has not classified is never retried on a guess — exactly the E13
 * needs_human default at the retry layer. BullMQ/Redis was REJECTED for the
 * prototype (E27: the runtime owns its own clocks and queues); this policy
 * rides the runtime's own scheduler seam, not a second state store.
 *
 * Purity: never throws, never reads a clock, never mutates inputs — the
 * caller (the retry coordinator) supplies the attempt ledger and the clock.
 *
 * Governing records: PRD §8, D8 (RETRYING/PAUSED/FAILED rows), E13, D20, G2.
 */

/** The three failure kinds the runtime distinguishes (closed vocabulary). */
export type FailureKind = "transient" | "permanent" | "ambiguous";

/** What the runtime does with one failure, as data. */
export type RetryDecision =
  | { action: "retry"; attempt: number; delayMs: number }
  | { action: "pause"; reason: "retry_exhausted" }
  | { action: "fail"; code: string }
  | { action: "pause_for_review"; reason: "ambiguous_external_effect"; code: string };

/** The runtime's typed failure classification table (data, never prose). */
const FAILURE_CLASSIFICATION: Readonly<Record<string, FailureKind>> = {
  // Transient: the work may succeed on a later attempt.
  TOOL_EXECUTION_TIMEOUT: "transient",
  TRANSIENT_NETWORK: "transient",
  PROVIDER_RATE_LIMITED: "transient",
  WORKER_TIMEOUT: "transient",
  RESOURCE_BUSY: "transient",
  // Permanent: a later attempt would fail identically — fail immediately.
  TOOL_ARGS_INVALID: "permanent",
  TOOL_ARGS_DIGEST_MISMATCH: "permanent",
  TOOL_RESPONSE_TOO_LARGE: "permanent",
  TOOL_NOT_REGISTERED: "permanent",
  TOOL_DISABLED: "permanent",
  TOOL_BINDING_FAILED: "permanent",
  WORKER_PROTOCOL_VIOLATION: "permanent",
  // Ambiguous: an external effect MAY have happened; replaying blindly could
  // duplicate it (E13/D20). The run pauses for review with the reason.
  EXTERNAL_EFFECT_UNCONFIRMED: "ambiguous",
  PROVIDER_RESPONSE_AMBIGUOUS: "ambiguous",
};

/**
 * Classify one typed failure code. The lookup normalizes case — worker
 * failure_class strings arrive from child processes as free bounded text
 * (the D14 frame), so `worker_timeout` and `WORKER_TIMEOUT` are the same
 * class. Unknown codes are ambiguous (fail-closed).
 */
export function classifyFailure(failureCode: string): FailureKind {
  return FAILURE_CLASSIFICATION[failureCode.trim().toUpperCase()] ?? "ambiguous";
}

export interface RetryPolicy {
  /** The maximum number of RETRY attempts after the first failure (PRD §8: 3). */
  maxAttempts: number;
  /**
   * The bounded backoff schedule: backoffScheduleMs[i] is the delay BEFORE
   * attempt i+1. The schedule must cover maxAttempts entries; the coordinator
   * caps the delay at the last entry when the array is shorter.
   */
  backoffScheduleMs: readonly number[];
}

/** The recorded PRD §8 policy: at most three attempts, bounded backoff. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffScheduleMs: [1_000, 2_000, 4_000],
};

/** The schedule exposed for the composition/tests (bounded, deterministic). */
export const RETRY_BACKOFF_SCHEDULE_MS: readonly number[] = DEFAULT_RETRY_POLICY.backoffScheduleMs;

export interface DecideRetryInput {
  /** The typed failure code the runtime recorded for the failed attempt. */
  failureCode: string;
  /**
   * How many RETRY attempts the run has ALREADY consumed (0 = the failure was
   * the first attempt). The runtime's own ledger — never agent-supplied.
   */
  attemptsSoFar: number;
  /** The runtime's policy (DEFAULT_RETRY_POLICY in production). */
  policy: RetryPolicy;
}

/**
 * The bounded decision for one failure. Transient failures retry while
 * attempts remain (bounded delay from the schedule), then pause with the
 * retry_exhausted reason (AC14); permanent failures fail immediately with
 * their typed code (AC2); ambiguous failures pause for review with the reason
 * recorded — never retried at any attempt count (AC10, E13).
 */
export function decideRetry(input: DecideRetryInput): RetryDecision {
  const kind = classifyFailure(input.failureCode);
  if (kind === "permanent") {
    return { action: "fail", code: input.failureCode };
  }
  if (kind === "ambiguous") {
    return {
      action: "pause_for_review",
      reason: "ambiguous_external_effect",
      code: input.failureCode,
    };
  }
  if (input.attemptsSoFar >= input.policy.maxAttempts) {
    return { action: "pause", reason: "retry_exhausted" };
  }
  const attempt = input.attemptsSoFar + 1;
  const schedule = input.policy.backoffScheduleMs;
  const delayMs = schedule[Math.min(attempt - 1, schedule.length - 1)]!;
  return { action: "retry", attempt, delayMs };
}
