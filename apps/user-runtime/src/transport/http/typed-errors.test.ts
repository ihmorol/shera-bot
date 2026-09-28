/**
 * Typed error middleware unit tests (S07; D23 rule 4, G3).
 *
 * The middleware is the ONE pattern every runtime HTTP surface uses to turn a
 * thrown failure into the SheraError wire taxonomy: stable code, category,
 * safe_message, retryable, user_action, internal_details, correlation_id.
 * Raw storage/internal errors and stack traces never cross the wire (G3),
 * and every produced body must validate against the @shera-bot/contracts
 * SheraError schema.
 */
import { describe, expect, it } from "vitest";

import { SheraError } from "@shera-bot/contracts";

import { ConversationsServiceError } from "../../modules/conversations/conversations.types.ts";
import { EventsServiceError } from "../../modules/events/events.service.ts";
import { notFoundErrorResponse, toSheraErrorResponse } from "./typed-errors.ts";

describe("toSheraErrorResponse — chunk-2 typed rejections map to stable HTTP failures", () => {
  it("maps conversations typed rejections to status + code + category", () => {
    const cases: Array<[ConversationsServiceError, number, string]> = [
      [
        new ConversationsServiceError("COMMAND_PAYLOAD_INVALID", "validation", "internal detail"),
        400,
        "COMMAND_PAYLOAD_INVALID",
      ],
      [
        new ConversationsServiceError("COMMAND_UNKNOWN_TYPE", "validation", "internal detail"),
        400,
        "COMMAND_UNKNOWN_TYPE",
      ],
      [
        new ConversationsServiceError("CONVERSATION_NOT_FOUND", "state", "internal detail"),
        404,
        "CONVERSATION_NOT_FOUND",
      ],
      [
        new ConversationsServiceError(
          "CONVERSATION_REVISION_CONFLICT",
          "conflict",
          "internal detail",
        ),
        409,
        "CONVERSATION_REVISION_CONFLICT",
      ],
    ];
    for (const [error, status, code] of cases) {
      const mapped = toSheraErrorResponse(error);
      expect(mapped.status).toBe(status);
      expect(mapped.body.code).toBe(code);
      // Contract-shaped: the produced body IS a SheraError.
      expect(() => SheraError.parse(mapped.body)).not.toThrow();
    }
  });

  it("maps journal typed failures to status + code + category", () => {
    const cases: Array<[EventsServiceError, number, string]> = [
      [
        new EventsServiceError("EVENT_PAYLOAD_INVALID", "validation", "internal detail"),
        400,
        "EVENT_PAYLOAD_INVALID",
      ],
      [
        new EventsServiceError("EVENT_UNKNOWN_TYPE", "validation", "internal detail"),
        400,
        "EVENT_UNKNOWN_TYPE",
      ],
      [
        new EventsServiceError("EVENT_SEQUENCE_CONFLICT", "conflict", "internal detail"),
        409,
        "EVENT_SEQUENCE_CONFLICT",
      ],
    ];
    for (const [error, status, code] of cases) {
      const mapped = toSheraErrorResponse(error);
      expect(mapped.status).toBe(status);
      expect(mapped.body.code).toBe(code);
      expect(() => SheraError.parse(mapped.body)).not.toThrow();
    }
  });

  it("gives the revision conflict a redaction-safe user action", () => {
    const mapped = toSheraErrorResponse(
      new ConversationsServiceError("CONVERSATION_REVISION_CONFLICT", "conflict", "rev 4 vs 2"),
    );
    expect(mapped.body.user_action).toBeTruthy();
    expect(mapped.body.internal_details).toBeNull();
  });

  it("falls back to a generic INTERNAL_ERROR that leaks nothing (G3)", () => {
    const mapped = toSheraErrorResponse(new Error("SQLITE_CONSTRAINT: users.email leaked"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.code).toBe("INTERNAL_ERROR");
    expect(mapped.body.category).toBe("internal");
    expect(JSON.stringify(mapped.body)).not.toContain("SQLITE_CONSTRAINT");
    expect(JSON.stringify(mapped.body)).not.toContain("leaked");
    expect(mapped.body.internal_details).toBeNull();
    expect(() => SheraError.parse(mapped.body)).not.toThrow();
  });

  it("maps a JSON body-parse failure to a typed 400, not a 500", () => {
    const parseError = Object.assign(new Error("Unexpected token in JSON"), {
      type: "entity.parse.failed",
      status: 400,
    });
    const mapped = toSheraErrorResponse(parseError);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe("CONTRACT_VALIDATION_FAILED");
    expect(() => SheraError.parse(mapped.body)).not.toThrow();
  });

  it("maps an oversized body to a typed 413, not a 500", () => {
    const tooLarge = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
    });
    const mapped = toSheraErrorResponse(tooLarge);
    expect(mapped.status).toBe(413);
    expect(mapped.body.code).toBe("CONTRACT_VALIDATION_FAILED");
  });

  it("issues a fresh correlation_id per response", () => {
    const error = new ConversationsServiceError("CONVERSATION_NOT_FOUND", "state", "x");
    const first = toSheraErrorResponse(error);
    const second = toSheraErrorResponse(error);
    expect(first.body.correlation_id).not.toBe(second.body.correlation_id);
  });
});

describe("notFoundErrorResponse — unknown routes answer with the typed 404", () => {
  it("produces a contract-shaped ROUTE_NOT_FOUND with no internals", () => {
    const body = notFoundErrorResponse();
    expect(body.code).toBe("ROUTE_NOT_FOUND");
    expect(body.category).toBe("validation");
    expect(body.retryable).toBe(false);
    expect(body.internal_details).toBeNull();
    expect(() => SheraError.parse(body)).not.toThrow();
  });
});
