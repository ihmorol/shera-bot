/**
 * Typed error construction on the S02 taxonomy (D23 rule 4): every error
 * carries code, category, safe_message, retryable, user_action,
 * internal_details, correlation_id. `internal_details` never crosses the user
 * boundary unredacted — HTTP responses carry `internal_details: null` and the
 * full details go to the redacted server log only.
 */
import { randomUUID } from "node:crypto";

import type { SheraError } from "@shera-bot/contracts";

/** New stable codes for S05 (the S02 list grows per slice; codes never rename). */
export const AUTH_ERROR_CODES = [
  "UNAUTHENTICATED",
  "SIGNUP_CAP_REACHED",
  "AUTH_CONFIGURATION_INVALID",
  "AUTH_SIGNIN_FAILED",
  "ROUTE_NOT_FOUND",
  "INTERNAL_ERROR",
  "CONTRACT_VALIDATION_FAILED",
] as const;

/** S06 runtime-provisioning error codes (also registered in contracts KNOWN_ERROR_CODES). */
export const RUNTIME_ERROR_CODES = [
  "RUNTIME_PROVISION_FAILED",
  "RUNTIME_PROVISION_IN_PROGRESS",
  "RUNTIME_NOT_PROVISIONED",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_TENANT_MISMATCH",
  "INTERNAL_CHANNEL_UNAUTHORIZED",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** The exact S1 refusal copy (docs/UI_DESIGN.md S1). No retry affordance. */
export const SIGNUP_CAP_REFUSAL_MESSAGE =
  "Shera is in private testing and is at its five-account limit.";

export interface TypedErrorInput {
  code: AuthErrorCode | (typeof RUNTIME_ERROR_CODES)[number];
  category: SheraError["category"];
  safe_message: string;
  retryable: boolean;
  user_action: string | null;
  correlation_id: string | undefined;
}

export function makeSheraError(input: TypedErrorInput): SheraError {
  return {
    code: input.code,
    category: input.category,
    safe_message: input.safe_message,
    retryable: input.retryable,
    user_action: input.user_action,
    // Never crosses the boundary unredacted: responses carry null; the server
    // log carries the redacted internal details alongside the correlation_id.
    internal_details: null,
    correlation_id: input.correlation_id ?? randomUUID(),
  };
}

export function unauthenticatedError(correlationId?: string): SheraError {
  return makeSheraError({
    code: "UNAUTHENTICATED",
    category: "unauthorized",
    safe_message: "Sign in to continue.",
    retryable: false,
    user_action: "Continue with Google.",
    correlation_id: correlationId,
  });
}

export function signupCapReachedError(correlationId?: string): SheraError {
  return makeSheraError({
    code: "SIGNUP_CAP_REACHED",
    category: "policy",
    safe_message: SIGNUP_CAP_REFUSAL_MESSAGE,
    retryable: false,
    user_action: null,
    correlation_id: correlationId,
  });
}

export function authConfigurationError(correlationId?: string): SheraError {
  return makeSheraError({
    code: "AUTH_CONFIGURATION_INVALID",
    category: "internal",
    safe_message: "Sign-in is not available because this deployment is not fully configured.",
    retryable: false,
    user_action: "Contact the operator.",
    correlation_id: correlationId,
  });
}

export function authSignInFailedError(correlationId?: string): SheraError {
  return makeSheraError({
    code: "AUTH_SIGNIN_FAILED",
    category: "provider",
    safe_message: "Sign-in failed. You can try again.",
    retryable: true,
    user_action: "Retry sign-in from the login screen.",
    correlation_id: correlationId,
  });
}

export function routeNotFoundError(correlationId?: string): SheraError {
  return makeSheraError({
    code: "ROUTE_NOT_FOUND",
    category: "validation",
    safe_message: "The requested resource does not exist.",
    retryable: false,
    user_action: null,
    correlation_id: correlationId,
  });
}

export function contractValidationError(safeMessage: string, correlationId?: string): SheraError {
  return makeSheraError({
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation",
    safe_message: safeMessage,
    retryable: false,
    user_action: null,
    correlation_id: correlationId,
  });
}

/** Untyped server fault, already stripped to the safe taxonomy shape. */
export function internalErrorPayload(correlationId: string): SheraError {
  return makeSheraError({
    code: "INTERNAL_ERROR",
    category: "internal",
    safe_message: "Something went wrong. The failure has been recorded.",
    retryable: false,
    user_action: "Try again later.",
    correlation_id: correlationId,
  });
}

/** HTTP status for an error category on the user boundary. */
export function statusForError(error: SheraError): number {
  switch (error.category) {
    case "unauthorized":
      return 401;
    case "policy":
      return 403;
    case "validation":
      return 404;
    case "conflict":
      return 409;
    case "state":
      return 409;
    case "resource":
      return 503;
    case "internal":
      return 503;
    case "provider":
      return 502;
    default:
      return 500;
  }
}

/**
 * S06 runtime operations: an error that carries the typed taxonomy through
 * service boundaries so routes can answer with the safe payload while the
 * redacted internals reach the log.
 */
export class RuntimeOperationError extends Error {
  readonly sheraError: SheraError;

  constructor(sheraError: SheraError) {
    super(sheraError.safe_message);
    this.name = "RuntimeOperationError";
    this.sheraError = sheraError;
  }
}

export function runtimeProvisionFailedError(correlationId?: string): RuntimeOperationError {
  return new RuntimeOperationError(
    makeSheraError({
      code: "RUNTIME_PROVISION_FAILED",
      category: "resource",
      safe_message: "Your runtime could not be provisioned. The failure has been recorded.",
      retryable: true,
      user_action: "Try again; if it keeps failing, contact the operator.",
      correlation_id: correlationId,
    }),
  );
}

export function runtimeProvisionInProgressError(correlationId?: string): RuntimeOperationError {
  return new RuntimeOperationError(
    makeSheraError({
      code: "RUNTIME_PROVISION_IN_PROGRESS",
      category: "conflict",
      safe_message: "Your runtime is already being provisioned.",
      retryable: true,
      user_action: "Check the runtime status in a moment.",
      correlation_id: correlationId,
    }),
  );
}

export function runtimeNotProvisionedError(correlationId?: string): RuntimeOperationError {
  return new RuntimeOperationError(
    makeSheraError({
      code: "RUNTIME_NOT_PROVISIONED",
      category: "state",
      safe_message: "No runtime has been provisioned for this account yet.",
      retryable: false,
      user_action: "Provision your runtime first.",
      correlation_id: correlationId,
    }),
  );
}

export function runtimeUnavailableError(correlationId?: string): RuntimeOperationError {
  return new RuntimeOperationError(
    makeSheraError({
      code: "RUNTIME_UNAVAILABLE",
      category: "resource",
      safe_message: "The runtime is not available right now. The failure has been recorded.",
      retryable: true,
      user_action: "Try again shortly.",
      correlation_id: correlationId,
    }),
  );
}

export function runtimeTenantMismatchError(correlationId?: string): RuntimeOperationError {
  return new RuntimeOperationError(
    makeSheraError({
      code: "RUNTIME_TENANT_MISMATCH",
      category: "policy",
      safe_message: "This runtime belongs to another account.",
      retryable: false,
      user_action: null,
      correlation_id: correlationId,
    }),
  );
}
