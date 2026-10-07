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
import { describe, expect, it, vi } from "vitest";

import { SheraError } from "@shera-bot/contracts";

import { ConversationsServiceError } from "../../modules/conversations/conversations.types.ts";
import { EventsServiceError } from "../../modules/events/events.service.ts";
import {
  AgentFolderAccessDeniedError,
  AgentFolderUriInvalidError,
} from "../../modules/agents/agent-folders.service.ts";
import {
  consoleRedactedLogger,
  createTypedErrorRequestHandler,
  notFoundErrorResponse,
  toSheraErrorResponse,
  type RedactedLogger,
} from "./typed-errors.ts";

interface StubResponse {
  headersSent: boolean;
  statusCode: number;
  body: unknown;
  status(code: number): StubResponse;
  json(body: unknown): StubResponse;
}

function stubResponse(headersSent = false): StubResponse {
  return {
    headersSent,
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function callHandler(
  handler: ReturnType<typeof createTypedErrorRequestHandler>,
  error: unknown,
  req: { method: string; path: string },
  res: StubResponse,
  next: () => void,
): void {
  handler(error, req as never, res as never, next);
}

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

describe("createTypedErrorRequestHandler — untyped faults are recorded, not silent (B-1)", () => {
  it("logs the untyped fault with the correlation_id the client receives, and nothing beyond the allowlist", () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: RedactedLogger = (event, fields) => logged.push({ event, fields });
    const handler = createTypedErrorRequestHandler(logger);
    const res = stubResponse();

    callHandler(
      handler,
      new Error("SQLITE_CONSTRAINT: users.email leaked"),
      { method: "POST", path: "/v1/conversations/commands" },
      res,
      () => {},
    );

    // The client sees the generic, already-stripped fault (G3).
    expect(res.statusCode).toBe(500);
    const body = res.body as { code: string; correlation_id: string; safe_message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("SQLITE_CONSTRAINT");
    expect(JSON.stringify(body)).not.toContain("leaked");

    // The operator log carries the SAME correlation_id the client can quote,
    // and exactly the allowlisted fields: routing data + name/message/stack.
    expect(logged).toHaveLength(1);
    const recorded = logged[0]!;
    expect(recorded.event).toBe("untyped_request_fault");
    const fields = recorded.fields;
    expect(Object.keys(fields).sort()).toEqual([
      "correlation_id",
      "message",
      "method",
      "name",
      "path",
      "stack",
    ]);
    expect(fields.correlation_id).toBe(body.correlation_id);
    expect(fields.method).toBe("POST");
    expect(fields.path).toBe("/v1/conversations/commands");
    expect(fields.name).toBe("Error");
    expect(fields.message).toBe("SQLITE_CONSTRAINT: users.email leaked");
    expect(typeof fields.stack).toBe("string");
  });

  it("does not log typed rejections — they are answered precisely and recorded as data", () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const handler = createTypedErrorRequestHandler((event, fields) =>
      logged.push({ event, fields }),
    );
    const res = stubResponse();

    callHandler(
      handler,
      new ConversationsServiceError("CONVERSATION_REVISION_CONFLICT", "conflict", "rev 4 vs 2"),
      { method: "POST", path: "/v1/conversations/commands" },
      res,
      () => {},
    );

    expect(res.statusCode).toBe(409);
    expect(logged).toHaveLength(0);
  });

  it("does not log the typed folder rejections — the 403/400 isolation answers, never untyped_request_fault", () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const handler = createTypedErrorRequestHandler((event, fields) =>
      logged.push({ event, fields }),
    );

    // The guard's denial: typed 403, the stable code on the wire.
    const deniedRes = stubResponse();
    callHandler(
      handler,
      new AgentFolderAccessDeniedError("agent_intruder", "agent_owner"),
      { method: "GET", path: "/v1/agents/agent_owner/folders" },
      deniedRes,
      () => {},
    );
    expect(deniedRes.statusCode).toBe(403);
    expect((deniedRes.body as { code: string }).code).toBe("AGENT_FOLDER_ACCESS_DENIED");

    // The malformed URI: typed 400.
    const invalidRes = stubResponse();
    callHandler(
      handler,
      new AgentFolderUriInvalidError(),
      { method: "GET", path: "/v1/agents/agent_owner/folders?uri=workspace%3A%2F%2Fx" },
      invalidRes,
      () => {},
    );
    expect(invalidRes.statusCode).toBe(400);
    expect((invalidRes.body as { code: string }).code).toBe("AGENT_FOLDER_URI_INVALID");

    // Both are typed rejections: answered precisely and recorded as data —
    // never logged as untyped_request_fault with message + stack.
    expect(logged).toHaveLength(0);
  });

  it("delegates headers-sent failures to Express and logs nothing", () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const handler = createTypedErrorRequestHandler((event, fields) =>
      logged.push({ event, fields }),
    );
    const res = stubResponse(true);
    let delegated: unknown = null;
    callHandler(handler, new Error("late failure"), { method: "GET", path: "/x" }, res, () => {
      delegated = "next";
    });

    expect(delegated).toBe("next");
    expect(logged).toHaveLength(0);
  });

  it("a non-Error fault is still recorded with its stringified form", () => {
    const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const handler = createTypedErrorRequestHandler((event, fields) =>
      logged.push({ event, fields }),
    );
    const res = stubResponse();

    callHandler(handler, "raw string fault", { method: "GET", path: "/x" }, res, () => {});

    expect(res.statusCode).toBe(500);
    expect(logged).toHaveLength(1);
    const recorded = logged[0]!;
    expect(recorded.fields.name).toBe("Error");
    expect(recorded.fields.message).toBe("raw string fault");
    expect(recorded.fields.stack).toBeNull();
  });

  it("the default sink writes one redacted JSON line on console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handler = createTypedErrorRequestHandler(consoleRedactedLogger);
      const res = stubResponse();
      callHandler(handler, new Error("boom"), { method: "GET", path: "/x" }, res, () => {});

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(line.event).toBe("untyped_request_fault");
      expect(line.level).toBe("error");
      expect(line.correlation_id).toBe((res.body as { correlation_id: string }).correlation_id);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
