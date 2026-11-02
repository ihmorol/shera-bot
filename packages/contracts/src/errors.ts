/**
 * Stable error taxonomy (D23 rule 4): every error carries code, category,
 * safe_message, retryable, user_action, internal_details, correlation_id.
 * Internal details never cross the user boundary unredacted — safe_message is
 * the only field user-facing surfaces may render verbatim.
 *
 * Zod-first (D25); no transport or persistence coupling (D23 rule 2).
 */
import { z } from "zod";

import { JsonObject } from "./primitives.ts";

export const ERROR_CATEGORIES = [
  "validation",
  "conflict",
  "unauthorized",
  "policy",
  "state",
  "resource",
  "provider",
  "internal",
] as const;
export const ErrorCategory = z.enum(ERROR_CATEGORIES);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

/**
 * Stable machine-readable codes (SCREAMING_SNAKE). The set grows as slices add
 * behavior; codes are never renamed once shipped. The list below is the S02
 * vocabulary; the schema accepts any code matching the convention so later
 * slices do not have to re-edit this file to introduce a new code.
 */
export const KNOWN_ERROR_CODES = [
  "TASK_ILLEGAL_TRANSITION",
  "TASK_VERSION_CONFLICT",
  "TASK_DUPLICATE_COMMAND",
  "TASK_ACTOR_NOT_ALLOWED",
  "TASK_RETRY_AUTHORIZATION_REQUIRED",
  "TASK_RETRY_BOUND_EXCEEDED",
  "TASK_COMMAND_MALFORMED",
  "TASK_RUN_INPUT_NOT_TYPED_EVENT",
  "TASK_RUN_INPUT_NOT_A_TRIGGER",
  "CONTRACT_VALIDATION_FAILED",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "INSUFFICIENT_CREDITS",
  "RESOURCE_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "RECOVERY_REQUIRED",
  "INTERNAL_ERROR",
  // S05 (control-plane identity layer).
  "UNAUTHENTICATED",
  "SIGNUP_CAP_REACHED",
  "AUTH_CONFIGURATION_INVALID",
  "AUTH_SIGNIN_FAILED",
  "ROUTE_NOT_FOUND",
  // S06 (runtime provisioning + internal channel).
  "RUNTIME_PROVISION_FAILED",
  "RUNTIME_PROVISION_IN_PROGRESS",
  "RUNTIME_NOT_PROVISIONED",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_TENANT_MISMATCH",
  "INTERNAL_CHANNEL_UNAUTHORIZED",
  // S32 (admin API/CLI; D47, issue #33).
  "ADMIN_UNAUTHENTICATED",
  "ADMIN_ACCOUNT_NOT_FOUND",
  "ADMIN_SNAPSHOT_NOT_FOUND",
] as const;

export const ErrorCodeShape = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "error codes are SCREAMING_SNAKE_CASE and stable");

export const SheraError = z.strictObject({
  code: ErrorCodeShape,
  category: ErrorCategory,
  /** Safe for display; never contains internals, secrets, or provider output (G3). */
  safe_message: z.string().min(1).max(300),
  retryable: z.boolean(),
  /** What the user can do next; null when there is no user action. */
  user_action: z.string().max(300).nullable(),
  /** Internal diagnostics. Redaction-classified before crossing any boundary. */
  internal_details: JsonObject.nullable(),
  correlation_id: z.string().min(1).max(256),
});
export type SheraError = z.infer<typeof SheraError>;
