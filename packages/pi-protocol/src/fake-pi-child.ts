/**
 * Fake Pi: stdio child implementing the versioned JSONL protocol (S12).
 * Ported from spikes/d13/src/fake-pi-stdio.ts (variant A, the E17 winner).
 * stdout carries protocol frames only; stderr is diagnostic (D14).
 *
 * Run directly: node src/fake-pi-child.ts --session-id s1 --tokens 3 ...
 * Spawned via spawnFakePi() from tests; every misbehavior is individually
 * switchable so suites can classify each failure mode (D14: tests use fake Pi
 * processes with deterministic events and failures).
 *
 * Governing records: D13, D14, E17.
 */
import { JsonLineParser, encodeFrame, parseFrame } from "./framing.ts";
import { PROTOCOL_VERSION, type PiChildFrame, type PromptFrame } from "./protocol.ts";

function parseArgs(argv: readonly string[]): Record<string, string> {
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

const args = parseArgs(process.argv.slice(2));

function numberArg(key: string, fallback: number): number {
  const raw = args[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const sessionId = args["session-id"] ?? "fake-pi";
// Wrong-version misbehavior: applied to hello, ready, and every frame's v.
const protocolVersion = numberArg("protocol-version", PROTOCOL_VERSION);
const tokens = numberArg("tokens", 3);
const tokenDelayMs = numberArg("token-delay-ms", 5);
const ttftDelayMs = numberArg("ttft-delay-ms", 10);
// 0 disables heartbeats entirely (the silence misbehavior).
const heartbeatMs = numberArg("heartbeat-ms", 100);
const hangAfterFirstToken = args["hang-after-first-token"] === "true";
const crashAfterTokensRaw = numberArg("crash-after-tokens", Number.NaN);
const crashAfterTokens = Number.isFinite(crashAfterTokensRaw) ? crashAfterTokensRaw : null;
const crashOnPrompt = args["crash-on-prompt"] === "true";

function emit(frame: PiChildFrame): void {
  process.stdout.write(encodeFrame(frame));
}

// Handshake: hello announces the protocol version, ready the session (D14).
emit({ v: protocolVersion, type: "hello", protocol_version: protocolVersion, pid: process.pid });
emit({
  v: protocolVersion,
  type: "ready",
  proto_version: protocolVersion,
  session_id: sessionId,
  pid: process.pid,
  resumed: false,
});

if (args["invalid-json-line"] !== undefined) {
  process.stdout.write("this line is not json\n");
}
if (args["unknown-frame-type"] === "true") {
  process.stdout.write(`${JSON.stringify({ v: protocolVersion, type: "vanish", session_id: sessionId })}\n`);
}

let heartbeatTimer: NodeJS.Timeout | null = null;
if (heartbeatMs > 0) {
  heartbeatTimer = setInterval(() => {
    emit({ v: protocolVersion, type: "heartbeat", session_id: sessionId, t: Date.now() });
  }, heartbeatMs);
}

let emitting = false;
let hangBegun = false;

function runPrompt(cmd: PromptFrame): void {
  if (crashOnPrompt && cmd.text === "crash") {
    // Crash on demand: hard exit, no final event (D14: the gateway must detect
    // process death independently of a final event).
    process.exit(137);
  }
  if (emitting || hangBegun) return; // spike semantics: one prompt at a time
  emitting = true;
  setTimeout(() => streamTokens(cmd), ttftDelayMs);
}

function streamTokens(cmd: PromptFrame): void {
  const firstSeq = cmd.from_seq + 1;
  let seq = firstSeq;
  const timer = setInterval(() => {
    if (seq > cmd.from_seq + tokens) {
      clearInterval(timer);
      emitting = false;
      emit({
        v: protocolVersion,
        type: "completed",
        id: cmd.id,
        session_id: cmd.session_id,
        last_seq: seq - 1,
      });
      return;
    }
    emit({ v: protocolVersion, type: "token", id: cmd.id, session_id: cmd.session_id, seq, text: `t${seq}` });
    if (hangAfterFirstToken) {
      // Hang misbehavior: stop tokens AND heartbeats, keep the process alive.
      hangBegun = true;
      emitting = false;
      clearInterval(timer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      return;
    }
    if (crashAfterTokens !== null && seq - cmd.from_seq >= crashAfterTokens) {
      clearInterval(timer);
      emitting = false;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      process.exit(137);
    }
    seq += 1;
  }, tokenDelayMs);
}

// Strict JSONL command intake; invalid messages are rejected and recorded as
// protocol failures on stderr (D14), never crashing the child.
const parser = new JsonLineParser();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  parser.push(chunk, (line) => {
    let frame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      process.stderr.write(`protocol_violation: ${error instanceof Error ? error.message : line.slice(0, 120)}\n`);
      return;
    }
    if (frame.type === "prompt") {
      runPrompt(frame);
    } else if (frame.type === "shutdown") {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      process.exit(0);
    } else {
      process.stderr.write(`unexpected_parent_frame: ${frame.type}\n`);
    }
  });
});
process.stdin.on("end", () => {
  // Flush any buffered partial command line (pi-mono rpc framing rule, E17).
  const partial = parser.end();
  if (partial !== null) process.stderr.write("partial_command_line_dropped\n");
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  process.exit(0);
});
