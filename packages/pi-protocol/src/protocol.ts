/**
 * Versioned JSONL protocol frames for the Pi adapter (S12).
 *
 * Frame shapes are ported from spikes/d13/src/contract.ts (variant A, the
 * E17 winner) with one envelope change: every frame carries `v`, the protocol
 * version integer (D14: the protocol is versioned). The hello, error, and
 * shutdown frames are new in S12 (hello announces the protocol version before
 * ready; error is the in-band counterpart of the spike's fatal; shutdown is
 * the graceful parent-initiated stop that the spike did with SIGTERM).
 *
 * validateFrame is structural only: it never cross-checks a hello
 * protocol_version against PROTOCOL_VERSION — version negotiation policy is
 * the host's decision (the supervision core, S12 chunk 2).
 *
 * Governing records: D13, D14, E17.
 */
import { ProtocolViolationError, ProtocolVersionError } from "./errors.ts";

export const PROTOCOL_VERSION = 1;

export interface PiFrameBase {
  /** Protocol version integer; starts at 1 (D14). */
  v: number;
}

/** Child → parent, first frame on stdout: announces the protocol version. */
export interface HelloFrame extends PiFrameBase {
  type: "hello";
  protocol_version: number;
  pid: number;
}

/** Child → parent; ported spike shape (ready handshake). */
export interface ReadyFrame extends PiFrameBase {
  type: "ready";
  proto_version: number;
  session_id: string;
  pid: number;
  resumed: boolean;
}

/** Child → parent; ported spike shape (t is the child's wall clock). */
export interface HeartbeatFrame extends PiFrameBase {
  type: "heartbeat";
  session_id: string;
  t: number;
}

/**
 * Child → parent token delta; ported spike shape. A reply streams these
 * supervised token frames ({seq, text}) and ends in a completed frame.
 */
export interface TokenFrame extends PiFrameBase {
  type: "token";
  id: string;
  session_id: string;
  seq: number;
  text: string;
}

/** Child → parent final frame of a reply stream; ported spike shape. */
export interface CompletedFrame extends PiFrameBase {
  type: "completed";
  id: string;
  session_id: string;
  last_seq: number;
}

/** Child → parent unrecoverable failure; ported spike shape (D14 fatal). */
export interface FatalFrame extends PiFrameBase {
  type: "fatal";
  session_id: string;
  error: string;
}

/** Child → parent in-band error reply; reuses the spike's fatal field shape. */
export interface ErrorFrame extends PiFrameBase {
  type: "error";
  session_id: string;
  error: string;
}

/** Parent → child command; ported spike shape (D26 cursor in from_seq). */
export interface PromptFrame extends PiFrameBase {
  type: "prompt";
  id: string;
  session_id: string;
  text: string;
  from_seq: number;
}

/** Parent → child graceful stop request; the child exits cleanly. */
export interface ShutdownFrame extends PiFrameBase {
  type: "shutdown";
}

export type PiChildFrame =
  HelloFrame | ReadyFrame | HeartbeatFrame | TokenFrame | CompletedFrame | FatalFrame | ErrorFrame;

export type PiParentFrame = PromptFrame | ShutdownFrame;

export type PiFrame = PiChildFrame | PiParentFrame;

export const PI_CHILD_FRAME_TYPES = [
  "hello",
  "ready",
  "heartbeat",
  "token",
  "completed",
  "fatal",
  "error",
] as const;
export const PI_PARENT_FRAME_TYPES = ["prompt", "shutdown"] as const;
export const PI_FRAME_TYPES = [...PI_CHILD_FRAME_TYPES, ...PI_PARENT_FRAME_TYPES] as const;
export type PiFrameType = (typeof PI_FRAME_TYPES)[number];

const PI_CHILD_FRAME_TYPE_SET: ReadonlySet<string> = new Set(PI_CHILD_FRAME_TYPES);

export function isPiChildFrame(frame: PiFrame): frame is PiChildFrame {
  return PI_CHILD_FRAME_TYPE_SET.has(frame.type);
}

type FieldKind = "string" | "number" | "boolean";

/** Required payload fields per frame type, ported from the spike shapes. */
const FRAME_FIELDS: Readonly<Record<PiFrameType, Readonly<Record<string, FieldKind>>>> = {
  hello: { protocol_version: "number", pid: "number" },
  ready: { proto_version: "number", session_id: "string", pid: "number", resumed: "boolean" },
  heartbeat: { session_id: "string", t: "number" },
  token: { id: "string", session_id: "string", seq: "number", text: "string" },
  completed: { id: "string", session_id: "string", last_seq: "number" },
  fatal: { session_id: "string", error: "string" },
  error: { session_id: "string", error: "string" },
  prompt: { id: "string", session_id: "string", text: "string", from_seq: "number" },
  shutdown: {},
};

/**
 * Validate one decoded frame value. Throws ProtocolVersionError on an
 * envelope version mismatch and ProtocolViolationError on any structural
 * problem. Unknown extra fields are tolerated for forward compatibility.
 */
export function validateFrame(value: unknown): PiFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolViolationError({ reason: "frame_not_object", detail: typeof value });
  }
  const record = value as Record<string, unknown>;
  if (record["v"] === undefined) {
    throw new ProtocolViolationError({ reason: "missing_required_field", field: "v" });
  }
  if (typeof record["v"] !== "number" || !Number.isInteger(record["v"])) {
    throw new ProtocolViolationError({ reason: "invalid_version_field", field: "v" });
  }
  if (record["v"] !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError({ expected: PROTOCOL_VERSION, received: record["v"] });
  }
  if (record["type"] === undefined) {
    throw new ProtocolViolationError({ reason: "missing_required_field", field: "type" });
  }
  const type = record["type"];
  if (typeof type !== "string" || !PI_FRAME_TYPES.includes(type as PiFrameType)) {
    throw new ProtocolViolationError({ reason: "unknown_frame_type", detail: String(type) });
  }
  const fields = FRAME_FIELDS[type as PiFrameType];
  for (const field of Object.keys(fields)) {
    const expected = fields[field]!;
    const actual = record[field];
    if (actual === undefined) {
      throw new ProtocolViolationError({ reason: "missing_required_field", field });
    }
    if (typeof actual !== expected) {
      throw new ProtocolViolationError({ reason: "field_type_invalid", field });
    }
  }
  return value as PiFrame;
}
