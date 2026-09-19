/**
 * S03 spike — Variant B stub host: fake Pi behind a loopback HTTP sidecar.
 * Loopback only (binds 127.0.0.1), no external network, no model calls.
 *
 * Shape mirrors a minimal gateway sidecar:
 *   GET  /events  — chunked JSONL event stream (ready, heartbeat, token,
 *                   completed, fatal) — the "always-on" channel that carries
 *                   heartbeats even when no prompt is active.
 *   POST /prompt  — accept one prompt command (control channel).
 * The sidecar writes ONE bootstrap JSON line to stdout with its bound port
 * (listen on 127.0.0.1:0) — the supervisor still owns the sidecar process.
 *
 * Run directly: node src/fake-pi-sidecar.ts --session-id s1 --port 0 ...
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  FakePiEngine,
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

let sink: ServerResponse | null = null;

// Transport write: the chunked /events response. A false return means the
// kernel socket buffer is full (the caller stopped reading) — source-side
// backpressure, same accounting as the stdio pipe in variant A.
engine.emitRaw = (line: string): boolean => {
  if (!sink) return true;
  const ok = sink.write(line);
  if (!ok) sink.once("drain", () => engine.clearBackpressure());
  return ok;
};

function send(event: PiEvent): void {
  sink?.write(JSON.stringify(event) + "\n");
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "transfer-encoding": "chunked",
    });
    sink = res;
    send({
      type: "ready",
      proto_version: PROTOCOL_VERSION,
      session_id: args["session-id"] ?? "stub-session",
      pid: process.pid,
      resumed: false,
    });
    engine.startHeartbeats();
    req.on("close", () => {
      if (sink === res) {
        sink = null;
        engine.stopHeartbeats();
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/prompt") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      const cmd = parseJsonLine(body) as PiCommand;
      if (cmd && cmd.type === "prompt") {
        engine.runPrompt(cmd);
        res.writeHead(202, { "content-type": "application/json" });
        res.end('{"accepted":true}');
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"accepted":false,"error":"protocol_violation"}');
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(args["port"] ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  // One bootstrap line on stdout — process supervision of the sidecar itself
  // stays with the caller (variant B has this extra lifecycle hop vs variant A).
  process.stdout.write(
    JSON.stringify({ type: "sidecar_listening", port: boundPort, pid: process.pid }) + "\n",
  );
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200).unref();
});
