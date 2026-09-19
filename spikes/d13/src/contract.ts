/**
 * S03 spike (issue #4) — D13 supervision spike: shared minimal contract.
 *
 * Both supervision variants (A: JSONL over stdin/stdout child process, the D14
 * shape; B: Pi behind a loopback HTTP sidecar) implement the SAME protocol and
 * the SAME scenario battery so their measurements are comparable.
 *
 * Pattern provenance (E15 pattern-only, no code copied):
 * - pi-mono coding-agent RPC mode (earendil-works/pi, MIT): strict JSONL framing
 *   split ONLY on "\n" (not readline — it also splits on U+2028/U+2029), partial
 *   line flushed on stream end, correlation ids on commands.
 * - OpenClaw (MIT) lifecycle ideas: no-output-timeout activity probing, escalation
 *   SIGTERM -> SIGKILL, bounded restart budget, "heartbeats do not count as user
 *   interaction", maxBufferedBytes-style bounded queues.
 * - D14 event vocabulary: ready / heartbeat / token(message_delta) / completed /
 *   fatal, correlation id per command, protocol version, fake Pi for tests.
 *
 * Spike scope only: this file is NOT the packages/contracts or packages/pi-protocol
 * work (those are later slices); it is deliberately light.
 */

import { appendFileSync } from "node:fs";

export const PROTOCOL_VERSION = 1;

/** Commands (caller -> Pi). Only what the scenarios need. */
export type PiCommand = {
  type: "prompt";
  id: string;
  session_id: string;
  text: string;
  /** Last token sequence durably journaled by the caller (D26 cursor shape). */
  from_seq: number;
};

/** Events (Pi -> caller). D14 vocabulary, reduced to the spike's needs. */
export type PiEvent =
  | {
      type: "ready";
      proto_version: number;
      session_id: string;
      pid: number;
      /** True when the receiving process already owns this session (warm reuse). */
      resumed: boolean;
    }
  | { type: "heartbeat"; session_id: string; t: number }
  | { type: "token"; id: string; session_id: string; seq: number; text: string }
  | { type: "completed"; id: string; session_id: string; last_seq: number }
  | { type: "fatal"; session_id: string; error: string };

/** Options for the fake Pi engine (identical behavior under both transports). */
export type FakePiOptions = {
  sessionId: string;
  tokens: number;
  tokenDelayMs: number;
  ttftDelayMs: number;
  heartbeatMs: number;
  /** After the first token of a prompt, go completely silent (hang scenario). */
  hangAfterFirstToken: boolean;
  /** Hard-exit the process after N emitted tokens (intrinsic crash scenario). */
  crashAfterTokens: number | null;
  /** Pad token text to ~this many bytes (0 = short "t<n>" tokens). Larger
   * payloads saturate the OS pipe / socket buffer so source-side backpressure
   * (write() === false) is actually observable in the backpressure scenario. */
  tokenBytes: number;
  /** Append every emitted event as JSONL here (loss accounting after kill -9). */
  emitLog: string;
};

/**
 * Transport-neutral fake Pi behavior. Hosts (stdio child, HTTP sidecar) supply
 * the `emit` callback; a `false` return means the transport refused the write
 * (OS pipe / socket buffer full) and is counted as source-side backpressure.
 */
export class FakePiEngine {
  private readonly opts: FakePiOptions;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private emitting = false;
  private emittedTotal = 0;
  private writeFalseCount = 0;
  /** True while the transport write buffer is full (source-side backpressure). */
  private backpressured = false;
  private hangBegun = false;

  constructor(opts: FakePiOptions) {
    this.opts = opts;
  }

  /** Emits an event through the host transport; returns false on backpressure. */
  private emit(event: PiEvent): boolean {
    let line: string;
    try {
      line = JSON.stringify(event) + "\n";
    } catch {
      return true;
    }
    appendEmitLog(this.opts.emitLog, line);
    this.emittedTotal += 1;
    const ok = this.emitRaw(line);
    if (!ok) {
      this.writeFalseCount += 1;
      // Source-side backpressure: suspend emission until the host reports
      // drain() (clearBackpressure). This is what a real Pi writer must do.
      this.backpressured = true;
    }
    return ok;
  }

  /** Host calls this from its transport's drain event to resume emission. */
  clearBackpressure(): void {
    this.backpressured = false;
  }

  /** Overridden by the host with its transport write. */
  emitRaw(line: string): boolean {
    void line; // base transport: writes are always accepted
    return true;
  }

  startHeartbeats(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.emit({ type: "heartbeat", session_id: this.opts.sessionId, t: Date.now() });
    }, this.opts.heartbeatMs);
  }

  /** Run one prompt: after ttftDelayMs, stream tokens from from_seq+1, then completed. */
  runPrompt(cmd: PiCommand): void {
    if (this.emitting || this.hangBegun) return;
    setTimeout(() => this.streamTokens(cmd), this.opts.ttftDelayMs);
  }

  private streamTokens(cmd: PiCommand): void {
    if (this.emitting || this.hangBegun) return;
    this.emitting = true;
    const firstSeq = cmd.from_seq + 1;
    let seq = firstSeq;
    const id = cmd.id;

    const timer = setInterval(() => {
      // Source-side backpressure: hold emission (do not advance) until drain.
      if (this.backpressured) return;
      if (seq > this.opts.tokens) {
        clearInterval(timer);
        this.emitting = false;
        this.emit({ type: "completed", id, session_id: cmd.session_id, last_seq: seq - 1 });
        return;
      }
      this.emit({ type: "token", id, session_id: cmd.session_id, seq, text: this.tokenText(seq) });
      if (this.opts.hangAfterFirstToken) {
        // Hang scenario: stop tokens AND heartbeats, keep the process alive.
        this.hangBegun = true;
        this.stopHeartbeats();
        clearInterval(timer);
        this.emitting = false;
        return;
      }
      if (this.opts.crashAfterTokens !== null && seq >= this.opts.crashAfterTokens) {
        clearInterval(timer);
        this.emitting = false;
        this.stopHeartbeats();
        // Intrinsic crash: hard exit without any fatal event (worst case for D14:
        // "the gateway detects process death independently of a final event").
        process.exit(137);
      }
      seq += 1;
    }, this.opts.tokenDelayMs);
  }

  stopHeartbeats(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Token payload, padded toward opts.tokenBytes when requested. */
  private tokenText(seq: number): string {
    const base = `t${seq}`;
    const target = this.opts.tokenBytes;
    if (target <= base.length + 1) return base;
    return `${base}:${"x".repeat(target - base.length - 1)}`;
  }

  summary(): Record<string, number> {
    return { emitted_events: this.emittedTotal, transport_write_false: this.writeFalseCount };
  }
}

// ---------------------------------------------------------------------------
// Strict JSONL framing (pi-mono rpc.md rule: split ONLY on "\n"; flush any
// buffered partial line when the stream ends; tolerate a trailing "\r").
// ---------------------------------------------------------------------------

export class JsonLineParser {
  private buffer = "";
  /** Set when the stream ended with a partial (unterminated) line. */
  droppedPartial = false;

  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) onLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  /** Call on stream end. Returns the dropped partial line, if any. */
  end(): string | null {
    if (this.buffer.length > 0) {
      this.droppedPartial = true;
      const partial = this.buffer;
      this.buffer = "";
      return partial;
    }
    return null;
  }
}

export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return { type: "protocol_violation", raw: line.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Args, logging, and measurement helpers.
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

export function appendEmitLog(path: string, line: string): void {
  // Synchronous so a kill -9 cannot lose stub-side accounting rows.
  try {
    appendFileSync(path, line);
  } catch {
    // The emit log is measurement-only; never crash the stub for it.
  }
}

export function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Stats = { n: number; median: number; min: number; max: number };

export function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, median: NaN, min: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? NaN)
      : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
  return {
    n: sorted.length,
    median: round2(median),
    min: round2(sorted[0] ?? NaN),
    max: round2(sorted[sorted.length - 1] ?? NaN),
  };
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
