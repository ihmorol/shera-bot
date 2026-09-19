/**
 * S03 spike — Variant A stub host: fake Pi as a child process speaking JSONL
 * over stdin/stdout (the D14 shape). Loopback-only, no network, no model calls.
 *
 * stdout carries protocol messages ONLY; diagnostics go to stderr (D14).
 * Run directly: node src/fake-pi-stdio.ts --session-id s1 --tokens 200 ...
 */
import {
  FakePiEngine,
  JsonLineParser,
  PROTOCOL_VERSION,
  appendEmitLog,
  parseArgs,
  parseJsonLine,
  type PiCommand,
  type PiEvent,
} from "./contract.ts";

const args = parseArgs(process.argv.slice(2));

const engine = new FakePiEngine({
  sessionId: args["session-id"] ?? "stub-session",
  tokens: Number(args["tokens"] ?? 200),
  tokenDelayMs: Number(args["token-delay-ms"] ?? 5),
  ttftDelayMs: Number(args["ttft-delay-ms"] ?? 20),
  heartbeatMs: Number(args["heartbeat-ms"] ?? 100),
  hangAfterFirstToken: args["hang-after-first-token"] === "true",
  crashAfterTokens: args["crash-after-tokens"] ? Number(args["crash-after-tokens"]) : null,
  tokenBytes: Number(args["token-bytes"] ?? 0),
  emitLog: args["emit-log"] ?? "",
});

// Transport write: stdout, protocol messages only. A false return means the
// OS pipe buffer is full (the caller stopped reading) — source-side backpressure.
engine.emitRaw = (line: string): boolean => process.stdout.write(line);

// The engine suspends emission on write()==false; resume when the pipe drains.
process.stdout.on("drain", () => engine.clearBackpressure());

function send(event: PiEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// Ready handshake on startup.
send({
  type: "ready",
  proto_version: PROTOCOL_VERSION,
  session_id: args["session-id"] ?? "stub-session",
  pid: process.pid,
  resumed: false,
});
engine.startHeartbeats();

// Strict JSONL command intake (pi-mono rpc framing rule).
const parser = new JsonLineParser();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  parser.push(chunk, (line) => {
    const msg = parseJsonLine(line) as PiCommand;
    if (msg && msg.type === "prompt") {
      engine.runPrompt(msg);
    } else {
      // D14: invalid messages are rejected and recorded as protocol failures.
      process.stderr.write(`protocol_violation: ${line.slice(0, 120)}\n`);
    }
  });
});
process.stdin.on("end", () => {
  // Flush any buffered partial command line (pi-mono rpc.md hangup rule).
  const partial = parser.end();
  if (partial) process.stderr.write("partial_command_line_dropped\n");
});

// On SIGTERM (clean stop), append the engine summary to the emit log so the
// harness can read source-side backpressure accounting after the run.
process.on("SIGTERM", () => {
  engine.stopHeartbeats();
  if (args["emit-log"]) {
    appendEmitLog(
      args["emit-log"],
      JSON.stringify({ type: "stub_summary", ...engine.summary() }) + "\n",
    );
  }
  process.exit(0);
});
