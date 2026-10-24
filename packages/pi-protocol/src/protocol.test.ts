/**
 * S12 chunk 1 — protocol frame validation, JSONL framing, and typed error tests.
 * Red-first: written against the target API before implementation exists.
 *
 * Frame shapes are ported from spikes/d13/src/contract.ts (variant A, the E17
 * winner) with the versioned envelope added (D14: the protocol is versioned).
 * Governing records: D13, D14, E17.
 */
import { describe, expect, it } from "vitest";

import { ProtocolViolationError, ProtocolVersionError } from "./errors.ts";
import { MAX_LINE_BYTES, JsonLineParser, encodeFrame, parseFrame } from "./framing.ts";
import { PROTOCOL_VERSION, validateFrame } from "./protocol.ts";

function violationOf(fn: () => unknown): ProtocolViolationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProtocolViolationError) return error;
    throw error;
  }
  throw new Error("expected ProtocolViolationError");
}

describe("protocol version", () => {
  it("starts at 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("validateFrame", () => {
  it("accepts every frame shape ported from the spike plus the new hello/error/shutdown frames", () => {
    const frames = [
      { v: 1, type: "hello", protocol_version: 1, pid: 4242 },
      { v: 1, type: "ready", proto_version: 1, session_id: "s1", pid: 4242, resumed: false },
      { v: 1, type: "heartbeat", session_id: "s1", t: 1234 },
      { v: 1, type: "token", id: "c1", session_id: "s1", seq: 1, text: "t1" },
      { v: 1, type: "completed", id: "c1", session_id: "s1", last_seq: 3 },
      { v: 1, type: "fatal", session_id: "s1", error: "boom" },
      { v: 1, type: "error", session_id: "s1", error: "bad command" },
      { v: 1, type: "prompt", id: "c1", session_id: "s1", text: "hi", from_seq: 0 },
      { v: 1, type: "shutdown" },
    ];
    for (const frame of frames) {
      expect(validateFrame(frame)).toEqual(frame);
    }
  });

  it("classifies a wrong envelope version as ProtocolVersionError", () => {
    try {
      validateFrame({ v: PROTOCOL_VERSION + 1, type: "heartbeat", session_id: "s1", t: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolVersionError);
      const versionError = error as ProtocolVersionError;
      expect(versionError.code).toBe("PROTOCOL_VERSION_MISMATCH");
      expect(versionError.category).toBe("validation");
      expect(versionError.expected).toBe(PROTOCOL_VERSION);
      expect(versionError.received).toBe(PROTOCOL_VERSION + 1);
    }
  });

  it("rejects non-object frames", () => {
    expect(violationOf(() => validateFrame(42)).reason).toBe("frame_not_object");
    expect(violationOf(() => validateFrame("hello")).reason).toBe("frame_not_object");
    expect(violationOf(() => validateFrame(null)).reason).toBe("frame_not_object");
  });

  it("rejects a missing or non-integer v field", () => {
    expect(violationOf(() => validateFrame({ type: "shutdown" })).reason).toBe(
      "missing_required_field",
    );
    expect(violationOf(() => validateFrame({ v: 1.5, type: "shutdown" })).reason).toBe(
      "invalid_version_field",
    );
  });

  it("rejects unknown frame types", () => {
    expect(violationOf(() => validateFrame({ v: 1, type: "teleport" })).reason).toBe(
      "unknown_frame_type",
    );
    expect(violationOf(() => validateFrame({ v: 1 })).reason).toBe("missing_required_field");
  });

  it("rejects missing required fields per frame type", () => {
    expect(
      violationOf(() =>
        validateFrame({ v: 1, type: "token", id: "c1", session_id: "s1", text: "t" }),
      ).field,
    ).toBe("seq");
    expect(
      violationOf(() =>
        validateFrame({ v: 1, type: "prompt", id: "c1", session_id: "s1", from_seq: 0 }),
      ).field,
    ).toBe("text");
    expect(
      violationOf(() =>
        validateFrame({ v: 1, type: "ready", proto_version: 1, session_id: "s1", pid: 1 }),
      ).field,
    ).toBe("resumed");
  });

  it("rejects required fields with the wrong primitive type", () => {
    expect(
      violationOf(() =>
        validateFrame({ v: 1, type: "token", id: "c1", session_id: "s1", seq: 1, text: 42 }),
      ).reason,
    ).toBe("field_type_invalid");
    expect(
      violationOf(() =>
        validateFrame({
          v: 1,
          type: "ready",
          proto_version: 1,
          session_id: "s1",
          pid: 1,
          resumed: "yes",
        }),
      ).reason,
    ).toBe("field_type_invalid");
  });
});

describe("parseFrame", () => {
  it("parses a JSONL line into a validated frame", () => {
    const line = '{"v":1,"type":"heartbeat","session_id":"s1","t":7}';
    expect(parseFrame(line)).toEqual({ v: 1, type: "heartbeat", session_id: "s1", t: 7 });
  });

  it("classifies unparseable lines as ProtocolViolationError, never a raw SyntaxError", () => {
    try {
      parseFrame("{not json");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolViolationError);
      const violation = error as ProtocolViolationError;
      expect(violation.reason).toBe("unparseable_json_line");
      expect(violation.code).toBe("PROTOCOL_VIOLATION");
      expect(violation.category).toBe("validation");
    }
  });

  it("rejects lines over the 1 MiB cap as oversized", () => {
    const line = `{"v":1,"type":"token","id":"c1","session_id":"s1","seq":1,"text":"${"x".repeat(MAX_LINE_BYTES)}"}`;
    try {
      parseFrame(line);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolViolationError);
      expect((error as ProtocolViolationError).reason).toBe("oversized_line");
    }
  });
});

describe("JsonLineParser", () => {
  it("splits only on \\n and tolerates a trailing \\r", () => {
    const lines: string[] = [];
    const parser = new JsonLineParser();
    parser.push('{"a":1}\r\n{"b":2}\n', (line) => lines.push(line));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on U+2028/U+2029 line separators", () => {
    const lines: string[] = [];
    const parser = new JsonLineParser();
    const raw = '{"v":1,"type":"heartbeat","session_id":"a\u2028b\u2029c","t":1}\n';
    parser.push(raw, (line) => lines.push(line));
    expect(lines).toEqual(['{"v":1,"type":"heartbeat","session_id":"a\u2028b\u2029c","t":1}']);
    expect(parseFrame(lines[0]!).type).toBe("heartbeat");
  });

  it("skips empty lines", () => {
    const lines: string[] = [];
    const parser = new JsonLineParser();
    parser.push("\n\n{}\n\n", (line) => lines.push(line));
    expect(lines).toEqual(["{}"]);
  });

  it("flushes a partial line on end() and flags it as dropped", () => {
    const lines: string[] = [];
    const parser = new JsonLineParser();
    parser.push('{"a":1}\n{"b":', (line) => lines.push(line));
    expect(lines).toEqual(['{"a":1}']);
    expect(parser.droppedPartial).toBe(false);
    expect(parser.end()).toBe('{"b":');
    expect(parser.droppedPartial).toBe(true);
    expect(parser.end()).toBeNull();
  });

  it("caps buffered bytes at 1 MiB and delivers the oversized buffer for classification, then recovers", () => {
    const lines: string[] = [];
    const parser = new JsonLineParser();
    parser.push("x".repeat(MAX_LINE_BYTES + 1), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(violationOf(() => parseFrame(lines[0]!)).reason).toBe("oversized_line");
    const after: string[] = [];
    parser.push('{"v":1,"type":"shutdown"}\n', (line) => after.push(line));
    expect(after).toEqual(['{"v":1,"type":"shutdown"}']);
  });
});

describe("encodeFrame", () => {
  it("appends exactly one newline and round-trips through parseFrame", () => {
    const frame = { v: 1, type: "token", id: "c1", session_id: "s1", seq: 7, text: "t7" } as const;
    const line = encodeFrame(frame);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseFrame(line.trimEnd())).toEqual(frame);
  });
});
