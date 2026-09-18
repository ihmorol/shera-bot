/**
 * D8 state vocabulary — leaf module (no contract imports) so events and
 * task-run records can share it without a cycle.
 */
import { z } from "zod";

/** D8 state vocabulary, complete. Terminal states: SUCCEEDED, FAILED, CANCELLED. */
export const RUN_STATES = [
  "CREATED",
  "PLANNED",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_AGENT",
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_RESOURCE",
  "RETRYING",
  "CANCELLING",
  "CANCELLED",
  "SUCCEEDED",
  "FAILED",
  "PAUSED",
  "RECOVERY_REQUIRED",
] as const;

export const RunState = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunState>;

export const RUN_STATES_TERMINAL = ["CANCELLED", "SUCCEEDED", "FAILED"] as const;
export const TERMINAL_RUN_STATES = z.enum(RUN_STATES_TERMINAL);
export type TerminalRunState = z.infer<typeof TERMINAL_RUN_STATES>;

/** D48: `PAUSED` always carries a reason; exhaustion follows PRD §8. */
export const PAUSE_REASONS = ["insufficient_credits", "retry_exhausted"] as const;
export const PauseReason = z.enum(PAUSE_REASONS);
export type PauseReason = z.infer<typeof PauseReason>;
