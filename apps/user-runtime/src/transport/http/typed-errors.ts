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
 */
import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, RequestHandler } from "express";

import type { SheraError } from "@shera-bot/contracts";

import { ConversationsServiceError } from "../../modules/conversations/conversations.types.ts";
import { EventsServiceError } from "../../modules/events/events.service.ts";

interface HttpErrorMapping {
  status: number;
  body: SheraError;
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
export function toSheraErrorResponse(error: unknown): HttpErrorMapping {
  const correlation_id = randomUUID();

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
export function contractValidationResponse(
  safeMessage: string,
  status = 400,
): HttpErrorMapping {
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

/**
 * Express error middleware: mount AFTER all routes on every runtime HTTP
 * surface. Headers-already-sent failures delegate to Express' default
 * handling; everything else becomes the typed taxonomy.
 */
export const typedErrorRequestHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const { status, body } = toSheraErrorResponse(error);
  res.status(status).json(body);
};

/** Mount LAST: unknown paths answer with the typed 404, never HTML. */
export const notFoundRequestHandler: RequestHandler = (_req, res) => {
  res.status(404).json(notFoundErrorResponse());
};
