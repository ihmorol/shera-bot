/**
 * Newline-delimited JSON framing for the Pi adapter (S12).
 *
 * Ported from spikes/d13/src/contract.ts with the pi-mono rpc.md rule the
 * spike validated (E17): split ONLY on "\n" (never readline — it also splits
 * on U+2028/U+2029), tolerate a trailing "\r", flush a partial line on stream
 * end, and never buffer more than the 1 MiB line cap (D14 protocol-failure
 * rule: oversized lines are rejected, not accumulated).
 *
 * Governing records: D13, D14, E17.
 */
import { Buffer } from "node:buffer";

import { ProtocolViolationError } from "./errors.ts";
import { validateFrame, type PiChildFrame, type PiFrame, type PiParentFrame } from "./protocol.ts";

/** Hard cap on one JSONL frame, 1 MiB (D14 protocol-failure rule). */
export const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Streaming JSONL parser. onLine fires once per complete line; the 1 MiB cap
 * is enforced on the pending buffer, so an unterminated oversized line is
 * delivered (truncated at the cap boundary) for classification instead of
 * growing without bound, and the parser recovers for the next line.
 */
export class JsonLineParser {
  private buffer = "";
  private bufferBytes = 0;
  /** Set when the stream ended with a partial (unterminated) line. */
  droppedPartial = false;

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, "utf8");
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.bufferBytes = Buffer.byteLength(this.buffer, "utf8");
      if (line.length > 0) onLine(line);
      idx = this.buffer.indexOf("\n");
    }
    if (this.bufferBytes > MAX_LINE_BYTES) {
      const oversized = this.buffer;
      this.buffer = "";
      this.bufferBytes = 0;
      onLine(oversized);
    }
  }

  /** Call on stream end. Returns the dropped partial line, if any. */
  end(): string | null {
    if (this.buffer.length === 0) return null;
    this.droppedPartial = true;
    const partial = this.buffer;
    this.buffer = "";
    this.bufferBytes = 0;
    return partial;
  }
}

/**
 * Parse one JSONL line into a validated frame. Every failure is classified as
 * a typed PiProtocolError — a parse failure is never a raw SyntaxError.
 */
export function parseFrame(line: string): PiFrame {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_LINE_BYTES) {
    throw new ProtocolViolationError({
      reason: "oversized_line",
      detail: `line is ${bytes} bytes; cap is ${MAX_LINE_BYTES}`,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    // G3: the raw line is child output — classify by SIZE, never echo it
    // (a misbehaving child could print prompt text or secrets inside a
    // malformed line; the digest carries nothing recoverable).
    throw new ProtocolViolationError({
      reason: "unparseable_json_line",
      detail: `unparseable JSON line (${bytes} bytes)`,
    });
  }
  return validateFrame(value);
}

/** Encode one frame as a JSONL line (exactly one trailing newline). */
export function encodeFrame(frame: PiChildFrame | PiParentFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
