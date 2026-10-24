/**
 * Demo reply child (S12 chunk 4 browser evidence) — TEST-INFRASTRUCTURE ONLY,
 * never referenced by production code. It runs ONLY when an operator points
 * the session harness command at it (SHERA_SESSION_HARNESS_COMMAND) for the
 * impeccable gate's real-browser captures.
 *
 * It speaks the SAME versioned JSONL D14 protocol as the fake-Pi child
 * (fake-pi-child.ts: hello → ready → heartbeats → token/completed on prompt),
 * with one difference: the reply is a SCRIPTED, human-readable line (so the
 * captures show a meaningful chat exchange instead of "t1t2t3"). It conforms
 * to the spawn adapter's contract — `--session-id {session_id}` and
 * `--heartbeat-ms {heartbeat_interval_ms}` arrive as argv placeholders, the
 * D15 context rides SHERA_SESSION_CONTEXT (decoded, never logged, G3) — and
 * exits cleanly on the shutdown frame, stdin end, SIGTERM, and SIGINT.
 *
 * Governing records: D13, D14, D15, G3, G4.
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
const sessionId = args["session-id"] ?? "demo-reply";
const heartbeatMs = Number(args["heartbeat-ms"] ?? 1000) || 1000;
const tokenDelayMs = Number(args["token-delay-ms"] ?? 15) || 15;
// The scripted line the chat visibly answers with (demo copy, not model output).
const REPLY =
  args["reply"] ??
  "Hello! This reply comes from the S12 demo session child — a supervised process speaking the D14 protocol.";

// The D15 context arrives through the environment (G3: never argv). The demo
// child decodes it to prove the channel, and touches nothing else.
try {
  const context = JSON.parse(process.env["SHERA_SESSION_CONTEXT"] ?? "{}") as {
    agent_id?: string;
  };
  process.stderr.write(`demo_reply_child: context agent_id=${context.agent_id ?? "unknown"}\n`);
} catch {
  process.stderr.write("demo_reply_child: SHERA_SESSION_CONTEXT was not valid JSON\n");
}

function emit(frame: PiChildFrame): void {
  process.stdout.write(encodeFrame(frame));
}

// Handshake (D14): hello announces the protocol version, ready the session.
emit({ v: PROTOCOL_VERSION, type: "hello", protocol_version: PROTOCOL_VERSION, pid: process.pid });
emit({
  v: PROTOCOL_VERSION,
  type: "ready",
  proto_version: PROTOCOL_VERSION,
  session_id: sessionId,
  pid: process.pid,
  resumed: false,
});

const heartbeatTimer = setInterval(() => {
  emit({ v: PROTOCOL_VERSION, type: "heartbeat", session_id: sessionId, t: Date.now() });
}, heartbeatMs);

let emitting = false;

function runPrompt(cmd: PromptFrame): void {
  if (emitting) return; // demo semantics: one reply at a time
  emitting = true;
  // Tokens are word-sized slices of the scripted line; the supervisor joins
  // them into the reply text it publishes durably (SessionReplyBridge).
  const tokens = REPLY.split(" ").map((word, index, all) =>
    index < all.length - 1 ? `${word} ` : word,
  );
  let seq = cmd.from_seq + 1;
  const timer = setInterval(() => {
    if (seq > cmd.from_seq + tokens.length) {
      clearInterval(timer);
      emitting = false;
      emit({
        v: PROTOCOL_VERSION,
        type: "completed",
        id: cmd.id,
        session_id: cmd.session_id,
        last_seq: seq - 1,
      });
      return;
    }
    emit({
      v: PROTOCOL_VERSION,
      type: "token",
      id: cmd.id,
      session_id: cmd.session_id,
      seq,
      text: tokens[seq - cmd.from_seq - 1] ?? "",
    });
    seq += 1;
  }, tokenDelayMs);
}

const parser = new JsonLineParser();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  parser.push(chunk, (line) => {
    let frame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      process.stderr.write(
        `protocol_violation: ${error instanceof Error ? error.message : line.slice(0, 120)}\n`,
      );
      return;
    }
    if (frame.type === "prompt") {
      runPrompt(frame);
    } else if (frame.type === "shutdown") {
      clearInterval(heartbeatTimer);
      process.exit(0);
    } else {
      process.stderr.write(`unexpected_parent_frame: ${frame.type}\n`);
    }
  });
});
process.stdin.on("end", () => {
  clearInterval(heartbeatTimer);
  process.exit(0);
});

process.on("SIGTERM", () => {
  clearInterval(heartbeatTimer);
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(heartbeatTimer);
  process.exit(0);
});
