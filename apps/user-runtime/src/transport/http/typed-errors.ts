/**
 * Typed error middleware (S07) — THE pattern for runtime HTTP surfaces.
 *
 * Every thrown failure crossing an Express boundary is answered with the
 * SheraError wire taxonomy (D23 rule 4): stable code, category, safe_message,
 * retryable, user_action, internal_details, correlation_id. The chunk-2 typed
 * rejections (commands, journal) map onto stable HTTP statuses here; anything
 * unrecognized degrades to a generic INTERNAL_ERROR that carries NO internals,
 * stack traces, or storage details (G3) — the same shape the control plane
 * already serves, so S35 can point at one middleware for the whole taxonomy.
 *
 * This module maps and serializes only; it owns no business behavior and no
 * transport routing (D23 rule 2). Route-level schema mismatches reuse the
 * same response builder (contractValidationResponse) so every failure path
 * emits identical, contract-validated fields.
 *
 * Untyped faults are also RECORDED (B-1): the generic INTERNAL_ERROR carries
 * only its correlation_id to the client, while the injected redacted logger
 * receives the allowlisted operational fields (routing data, name, message,
 * stack) — making "The failure has been recorded." a true statement. The log
 * shape matches the control-plane's request-failure log so one grep covers
 * both surfaces (G3: never payloads, credentials, or SQL text beyond the
 * error's own name/message/stack).
 */
import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, RequestHandler } from "express";

import type { SheraError } from "@shera-bot/contracts";

import { AgentNotFoundError, AgentSettingsValidationError } from "../../adapters/sqlite/agents-repository.ts";
import { AgentSettingsResetUnavailableError } from "../../modules/agents/agents.service.ts";
import { ConversationsServiceError } from "../../modules/conversations/conversations.types.ts";
import { EventsServiceError } from "../../modules/events/events.service.ts";

interface HttpErrorMapping {
  status: number;
  body: SheraError;
}

/**
 * A redacted operator-log sink (G3). Sinks receive an event name plus an
 * explicit field allowlist chosen by the CALL SITE — this type is the conduit,
 * not the redaction enforcement; call sites must never pass secrets.
 */
export type RedactedLogger = (event: string, fields: Record<string, unknown>) => void;

/** Minimal default sink: one JSON line on console.error. */
export function consoleRedactedLogger(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

/**
 * Redaction-safe messages per stable code. The thrown error's own message
 * (which embeds internal context) is NEVER echoed — these strings are the
 * whole of what the client sees (G3).
 */
const CONVERSATIONS_REJECTIONS: Record<
  ConversationsServiceError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  COMMAND_PAYLOAD_INVALID: {
    status: 400,
    safe_message: "The command envelope is malformed.",
    user_action: null,
  },
  COMMAND_UNKNOWN_TYPE: {
    status: 400,
    safe_message: "The command type is not accepted by this API.",
    user_action: null,
  },
  CONVERSATION_NOT_FOUND: {
    status: 404,
    safe_message: "The conversation does not exist in this workspace.",
    user_action: null,
  },
  CONVERSATION_REVISION_CONFLICT: {
    status: 409,
    safe_message: "The conversation changed since it was read.",
    user_action: "Reload the conversation and retry with the current revision.",
  },
};

const JOURNAL_REJECTIONS: Record<
  EventsServiceError["code"],
  { status: number; safe_message: string }
> = {
  EVENT_PAYLOAD_INVALID: {
    status: 400,
    safe_message: "The event payload failed validation.",
  },
  EVENT_UNKNOWN_TYPE: {
    status: 400,
    safe_message: "The event type is not known to this runtime.",
  },
  EVENT_SEQUENCE_CONFLICT: {
    status: 409,
    safe_message: "The event sequence conflicted with an existing append.",
  },
};

/** S11: the agents boundary rejections (the repository's typed error class). */
const AGENTS_REJECTIONS: Record<
  AgentNotFoundError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  AGENT_NOT_FOUND: {
    status: 404,
    safe_message: "The agent does not exist in this workspace.",
    user_action: null,
  },
};

function bodyParserType(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: unknown }).type;
    if (typeof type === "string") {
      return type;
    }
  }
  return null;
}

/** Map any thrown failure to a stable HTTP status + contract-validated body. */
export function toSheraErrorResponse(error: unknown, correlationId?: string): HttpErrorMapping {
  const correlation_id = correlationId ?? randomUUID();

  if (error instanceof ConversationsServiceError) {
    const mapping = CONVERSATIONS_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof EventsServiceError) {
    const mapping = JOURNAL_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof AgentNotFoundError) {
    const mapping = AGENTS_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  // S11 chunk 3: settings that do not conform to the contracts overrides
  // schema answer with the contract's standard validation failure — the
  // thrown message (which names internal shapes) is never echoed (G3).
  if (error instanceof AgentSettingsValidationError) {
    return contractValidationResponse("The agent settings payload is not valid.");
  }

  // Reset-to-default needs the pinned pack's recommendation (D16 forbids
  // inventing provider picks); without it the reset is a typed conflict.
  if (error instanceof AgentSettingsResetUnavailableError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message:
          "Resetting this setting needs the pinned pack's recommended default, which is not loaded.",
        retryable: false,
        user_action: "Start the runtime with the pinned pack configured.",
        internal_details: null,
        correlation_id,
      },
    };
  }

  // Body-parser failures (invalid JSON, oversized body) are client errors
  // with well-known types; answer with the contract's validation failure
  // instead of the generic 500 fallback.
  const parserType = bodyParserType(error);
  if (parserType === "entity.parse.failed") {
    return contractValidationResponse("The request body is not valid JSON.");
  }
  if (parserType === "entity.too.large") {
    return contractValidationResponse("The request body exceeds the accepted size.", 413);
  }

  // Unknown failure: the generic, already-stripped fault. No stack, no
  // message echo, no internals (G3) — the same payload the control plane
  // uses for untyped server faults.
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      category: "internal",
      safe_message: "Something went wrong. The failure has been recorded.",
      retryable: false,
      user_action: "Try again later.",
      internal_details: null,
      correlation_id,
    },
  };
}

/** Route-level schema mismatch: the same typed shape the middleware emits. */
export function contractValidationResponse(safeMessage: string, status = 400): HttpErrorMapping {
  return {
    status,
    body: {
      code: "CONTRACT_VALIDATION_FAILED",
      category: "validation",
      safe_message: safeMessage,
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: randomUUID(),
    },
  };
}

/** Typed 404 for unknown routes (matches the control-plane contract). */
export function notFoundErrorResponse(): SheraError {
  return {
    code: "ROUTE_NOT_FOUND",
    category: "validation",
    safe_message: "The requested resource does not exist.",
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  };
}

/** True when the failure is none of the typed/parsing paths — the generic 500. */
function isUntypedFault(error: unknown): boolean {
  return (
    !(error instanceof ConversationsServiceError) &&
    !(error instanceof EventsServiceError) &&
    !(error instanceof AgentNotFoundError) &&
    !(error instanceof AgentSettingsValidationError) &&
    !(error instanceof AgentSettingsResetUnavailableError) &&
    bodyParserType(error) === null
  );
}

/**
 * Express error middleware with an injected redacted fault log: an untyped
 * fault is answered with the generic INTERNAL_ERROR whose correlation_id is
 * ALSO the one logged (B-1) — the client can quote it, the operator can find
 * it. Typed rejections and contract-validation failures are recorded as data
 * / answered precisely and are not logged here.
 */
export function createTypedErrorRequestHandler(
  logFault: RedactedLogger = consoleRedactedLogger,
): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const untyped = isUntypedFault(error);
    const correlationId = untyped ? randomUUID() : undefined;
    const { status, body } = toSheraErrorResponse(error, correlationId);
    if (untyped && correlationId !== undefined) {
      logFault("untyped_request_fault", {
        correlation_id: correlationId,
        method: req.method,
        path: req.path,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    }
    res.status(status).json(body);
  };
}

/** Default mount: untyped faults are recorded to the default redacted sink. */
export const typedErrorRequestHandler: ErrorRequestHandler = createTypedErrorRequestHandler();

/** Mount LAST: unknown paths answer with the typed 404, never HTML. */
export const notFoundRequestHandler: RequestHandler = (_req, res) => {
  res.status(404).json(notFoundErrorResponse());
};
