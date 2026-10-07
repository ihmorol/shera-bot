import type { SheraError } from "@shera-bot/contracts";

/**
 * Shared typed-failure handling for the web's fetch clients (S09 chunk 1).
 * Every server failure arrives as the S02 taxonomy body (D23 rule 4) through
 * the same-origin proxies; this module is the ONE place that parses it, so
 * callers always surface safe_message + retryable and never internals (G3).
 * A body that is not the typed taxonomy maps to honest fallback copy — never
 * to a fabricated success.
 */

export class TypedHttpError extends Error {
  readonly sheraError: SheraError;

  constructor(sheraError: SheraError) {
    super(sheraError.safe_message);
    this.name = "TypedHttpError";
    this.sheraError = sheraError;
  }
}

/** Fallback for a non-typed failure body (transport noise). */
export const TYPED_FALLBACK_ERROR: SheraError = {
  code: "INTERNAL_ERROR",
  category: "internal",
  safe_message: "Something went wrong. The failure has been recorded.",
  retryable: false,
  user_action: "Try again later.",
  internal_details: null,
  correlation_id: "client-fallback",
};

/** The app origin itself was unreachable — a transport failure, retryable. */
export const UNREACHABLE_ERROR: SheraError = {
  code: "RESOURCE_UNAVAILABLE",
  category: "resource",
  safe_message: "The connection to Shera failed. You can try again.",
  retryable: true,
  user_action: "Try again shortly.",
  internal_details: null,
  correlation_id: "client-unreachable",
};

export function typedErrorFromPayload(payload: unknown): TypedHttpError {
  if (
    payload !== null &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>)["safe_message"] === "string" &&
    typeof (payload as Record<string, unknown>)["retryable"] === "boolean"
  ) {
    const candidate = payload as Record<string, unknown>;
    return new TypedHttpError({
      code: typeof candidate["code"] === "string" ? candidate["code"] : TYPED_FALLBACK_ERROR.code,
      category: "internal",
      safe_message: candidate["safe_message"] as string,
      retryable: candidate["retryable"] as boolean,
      user_action:
        typeof candidate["user_action"] === "string" ? (candidate["user_action"] as string) : null,
      internal_details: null,
      correlation_id:
        typeof candidate["correlation_id"] === "string"
          ? (candidate["correlation_id"] as string)
          : TYPED_FALLBACK_ERROR.correlation_id,
    });
  }
  return new TypedHttpError(TYPED_FALLBACK_ERROR);
}
