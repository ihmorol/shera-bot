/**
 * Task worker framing (S16 chunk 1; D32 layer 3) — the versioned newline-JSON
 * protocol between the runtime and a supervised task worker process.
 *
 * These are NOT Pi frames: the D14 Pi negotiation governs Agent sessions;
 * workers speak this smaller sibling protocol. The framing DISCIPLINE is the
 * same (E17-validated): split ONLY on "\n" (never readline — it also splits
 * on U+2028/U+2029), tolerate a trailing "\r", never buffer more than the
 * line cap, and classify every failure as a typed error whose detail carries
 * only SIZE — a misbehaving child's output is never echoed (G3).
 *
 * Frame flow: the child announces hello (protocol version + pid), then ready
 * (its worker id + pid); the supervisor considers the worker LIVE at ready.
 * While working it streams heartbeat (liveness), progress (percent/text) and
 * checkpoint (opaque JSON the RUNTIME persists, D33) frames, and finishes
 * with done (result summary) — or reports error (failure class) and exits.
 * The only parent→child frame is shutdown (graceful stop). The envelope `v`
 * is the HOST's policy: parseWorkerFrame validates structure; the supervisor
 * checks WORKER_PROTOCOL_VERSION on the handshake exactly like the D14
 * negotiation (a wrong-version child is a handshake failure, not a parse
 * error).
 *
 * Governing records: D32, D33, D10, G3.
 */

/** Bumped only when the frame shapes below change incompatibly. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Hard cap on one JSONL frame, 1 MiB — the same discipline as Pi (D14). */
export const MAX_WORKER_LINE_BYTES = 1024 * 1024;

export const MAX_PROGRESS_TEXT_CHARS = 500;
export const MAX_SUMMARY_CHARS = 2_000;
export const MAX_ERROR_MESSAGE_CHARS = 500;
export const MAX_FAILURE_CLASS_CHARS = 100;

/** hello — the child announces its protocol version and pid. */
export interface WorkerHelloFrame {
  v: number;
  type: "hello";
  worker_version: number;
  pid: number;
}

/** ready — the child is live and working its run. */
export interface WorkerReadyFrame {
  v: number;
  type: "ready";
  worker_id: string;
  pid: number;
}

/** heartbeat — liveness only; never carries work semantics. */
export interface WorkerHeartbeatFrame {
  v: number;
  type: "heartbeat";
  t: number;
}

/** progress — run-scoped work progress (percent 0-100 + bounded text). */
export interface WorkerProgressFrame {
  v: number;
  type: "progress";
  percent: number;
  text: string;
}

/** checkpoint — opaque JSON payload the RUNTIME persists (D33). */
export interface WorkerCheckpointFrame {
  v: number;
  type: "checkpoint";
  checkpoint: Record<string, unknown>;
}

/** done — the run's work finished; carries the result summary. */
export interface WorkerDoneFrame {
  v: number;
  type: "done";
  summary: string;
}

/** error — the worker reports a failure class and stops. */
export interface WorkerErrorFrame {
  v: number;
  type: "error";
  failure_class: string;
  message: string;
}

export type WorkerChildFrame =
  | WorkerHelloFrame
  | WorkerReadyFrame
  | WorkerHeartbeatFrame
  | WorkerProgressFrame
  | WorkerCheckpointFrame
  | WorkerDoneFrame
  | WorkerErrorFrame;

/** shutdown — the ONLY parent→child frame (graceful stop request). */
export interface WorkerShutdownFrame {
  v: number;
  type: "shutdown";
}

export type WorkerParentFrame = WorkerShutdownFrame;

/** Typed worker protocol failure (the worker protocol's PiProtocolError). */
export type WorkerProtocolErrorCode = "WORKER_PROTOCOL_VERSION" | "WORKER_PROTOCOL_VIOLATION";

export class WorkerProtocolError extends Error {
  readonly code: WorkerProtocolErrorCode;
  readonly category = "protocol" as const;
  /** Machine-readable violation reason (e.g. "oversized_line"). */
  readonly reason: string | null;
  /** Bounded, size-only detail — never raw child output (G3). */
  readonly detail: string | null;

  constructor(input: { code?: WorkerProtocolErrorCode; reason?: string; detail?: string }) {
    super(
      `${input.code ?? "WORKER_PROTOCOL_VIOLATION"}${input.reason ? `: ${input.reason}` : ""}` +
        (input.detail ? ` (${input.detail})` : ""),
    );
    this.name = "WorkerProtocolError";
    this.code = input.code ?? "WORKER_PROTOCOL_VIOLATION";
    this.reason = input.reason ?? null;
    this.detail = input.detail ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isBoundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

/**
 * Parse one JSONL line into a structurally valid worker child frame. Every
 * failure is a typed WorkerProtocolError — parse failures and field
 * violations are classified, never raw SyntaxErrors; the raw line is never
 * echoed (size-only detail, G3). The envelope `v` is deliberately NOT
 * checked here: version policy is the supervisor's handshake decision.
 */
export function parseWorkerFrame(line: string): WorkerChildFrame {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_WORKER_LINE_BYTES) {
    throw new WorkerProtocolError({
      reason: "oversized_line",
      detail: `line is ${bytes} bytes; cap is ${MAX_WORKER_LINE_BYTES}`,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    // G3: the raw line is child output — classify by SIZE, never echo it.
    throw new WorkerProtocolError({
      reason: "unparseable_json_line",
      detail: `unparseable JSON line (${bytes} bytes)`,
    });
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new WorkerProtocolError({ reason: "frame_not_an_object", detail: `${bytes} bytes` });
  }
  if (value.v !== WORKER_PROTOCOL_VERSION && !isFiniteNumber(value.v)) {
    throw new WorkerProtocolError({ reason: "invalid_envelope", detail: "v is not a number" });
  }

  switch (value.type) {
    case "hello": {
      if (
        !isFiniteNumber(value.worker_version) ||
        !isIntegerBetween(value.pid, 1, Number.MAX_SAFE_INTEGER)
      ) {
        throw new WorkerProtocolError({ reason: "invalid_hello", detail: "worker_version/pid" });
      }
      return value as unknown as WorkerHelloFrame;
    }
    case "ready": {
      if (
        !isBoundedString(value.worker_id, 256) ||
        !isIntegerBetween(value.pid, 1, Number.MAX_SAFE_INTEGER)
      ) {
        throw new WorkerProtocolError({ reason: "invalid_ready", detail: "worker_id/pid" });
      }
      return value as unknown as WorkerReadyFrame;
    }
    case "heartbeat": {
      if (!isFiniteNumber(value.t)) {
        throw new WorkerProtocolError({ reason: "invalid_heartbeat", detail: "t" });
      }
      return value as unknown as WorkerHeartbeatFrame;
    }
    case "progress": {
      if (
        !isIntegerBetween(value.percent, 0, 100) ||
        !isBoundedString(value.text, MAX_PROGRESS_TEXT_CHARS, 0)
      ) {
        throw new WorkerProtocolError({ reason: "invalid_progress", detail: "percent/text" });
      }
      return value as unknown as WorkerProgressFrame;
    }
    case "checkpoint": {
      if (!isRecord(value.checkpoint)) {
        throw new WorkerProtocolError({ reason: "invalid_checkpoint", detail: "not an object" });
      }
      return value as unknown as WorkerCheckpointFrame;
    }
    case "done": {
      if (!isBoundedString(value.summary, MAX_SUMMARY_CHARS, 0)) {
        throw new WorkerProtocolError({ reason: "invalid_done", detail: "summary" });
      }
      return value as unknown as WorkerDoneFrame;
    }
    case "error": {
      if (
        !isBoundedString(value.failure_class, MAX_FAILURE_CLASS_CHARS) ||
        !isBoundedString(value.message, MAX_ERROR_MESSAGE_CHARS, 0)
      ) {
        throw new WorkerProtocolError({
          reason: "invalid_error_frame",
          detail: "failure_class/message",
        });
      }
      return value as unknown as WorkerErrorFrame;
    }
    default:
      throw new WorkerProtocolError({
        reason: "unknown_frame_type",
        detail: `type ${value.type.slice(0, 64)}`,
      });
  }
}

/**
 * Validate one PARENT frame (the host→child direction). The child is a
 * test double and a future harness; the parent surface is one frame today.
 */
export function encodeWorkerFrame(frame: WorkerChildFrame | WorkerParentFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
