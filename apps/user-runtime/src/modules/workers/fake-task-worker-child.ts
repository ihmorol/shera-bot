/**
 * Fake task worker: stdio child implementing the versioned worker JSONL
 * protocol (S16 chunk 1; D32 layer 3, E8). stdout carries protocol frames
 * only; stderr is diagnostic (never protocol, G3).
 *
 * Run directly: node src/fake-task-worker-child.ts --run-id r1 --steps 3 ...
 * Spawned via spawnFakeTaskWorker() from tests; every misbehavior is
 * individually switchable so suites can classify each failure mode:
 *
 * - silence / hang: --hang-after-step N (0 = right after ready) stops
 *   heartbeats AND progress, ignores the shutdown frame, and keeps the
 *   process alive — a true stall the watchdog must escalate.
 * - crash: --crash-on-step N hard-exits(137) before that step's progress
 *   (death is detected independently of any final event, D14 rule).
 * - worker-reported error: --error-on-step N emits an error frame with
 *   --error-class and exits.
 * - slow progress: --slow-ttft-ms delays the FIRST progress while heartbeats
 *   keep flowing — a slow-but-healthy worker the stall watchdog must spare.
 *
 * Governing records: D32, D33, E8, G3.
 */
import { JsonLineParser } from "@shera-bot/pi-protocol";

import { encodeWorkerFrame, WORKER_PROTOCOL_VERSION, type WorkerChildFrame } from "./worker-frames.ts";

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

const protocolVersion = numberArg("protocol-version", WORKER_PROTOCOL_VERSION);
const workerId = args["worker-id"] ?? "fake-task-worker";
const steps = numberArg("steps", 3);
const stepDelayMs = numberArg("step-delay-ms", 20);
// 0 disables heartbeats entirely (a silence misbehavior variant).
const heartbeatMs = numberArg("heartbeat-ms", 50);
const crashOnStepRaw = numberArg("crash-on-step", Number.NaN);
const crashOnStep = Number.isFinite(crashOnStepRaw) ? crashOnStepRaw : null;
const errorOnStepRaw = numberArg("error-on-step", Number.NaN);
const errorOnStep = Number.isFinite(errorOnStepRaw) ? errorOnStepRaw : null;
const errorClass = args["error-class"] ?? "transient_failure";
const hangAfterStepRaw = numberArg("hang-after-step", Number.NaN);
const hangAfterStep = Number.isFinite(hangAfterStepRaw) ? hangAfterStepRaw : null;
const slowTtftMs = numberArg("slow-ttft-ms", 0);
const checkpointEvery = numberArg("checkpoint-every", 0);

function emit(frame: WorkerChildFrame): void {
  process.stdout.write(encodeWorkerFrame(frame));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Handshake: hello announces the protocol version, ready the worker (D32).
emit({ v: protocolVersion, type: "hello", worker_version: protocolVersion, pid: process.pid });
emit({ v: protocolVersion, type: "ready", worker_id: workerId, pid: process.pid });

let hung = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
if (heartbeatMs > 0) {
  heartbeatTimer = setInterval(() => {
    if (hung) return;
    emit({ v: protocolVersion, type: "heartbeat", t: Date.now() });
  }, heartbeatMs);
}

function hang(): void {
  hung = true;
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
}

async function run(): Promise<void> {
  if (slowTtftMs > 0) await delay(slowTtftMs); // heartbeats keep flowing
  for (let step = 1; step <= steps; step++) {
    if (hung) return;
    if (hangAfterStep !== null && step > hangAfterStep) {
      hang(); // stop heartbeats AND progress; stay alive; ignore shutdown
      return;
    }
    if (crashOnStep === step) {
      // Intrinsic crash: hard exit, no final event (death must be detected
      // independently of any final frame).
      process.exit(137);
    }
    if (errorOnStep === step) {
      emit({
        v: protocolVersion,
        type: "error",
        failure_class: errorClass,
        message: "synthetic worker error",
      });
      process.exit(1);
    }
    emit({
      v: protocolVersion,
      type: "progress",
      percent: Math.round((step / steps) * 100),
      text: `step ${step} of ${steps}`,
    });
    if (checkpointEvery > 0 && step % checkpointEvery === 0) {
      emit({
        v: protocolVersion,
        type: "checkpoint",
        checkpoint: {
          step_id: `step-${step}`,
          completed_actions: [`step-${step}`],
          created_at: new Date().toISOString(),
        },
      });
    }
    await delay(stepDelayMs);
  }
  emit({ v: protocolVersion, type: "done", summary: `completed ${steps} steps` });
  // The work is complete: a healthy worker exits after done (D32 — its
  // lifecycle is governed by the task, and the task just finished).
  process.exit(0);
}

void run();

// Strict JSONL command intake; the only parent frame is shutdown. A HUNG
// worker ignores it — that is what makes the watchdog escalation real.
const parser = new JsonLineParser();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  parser.push(chunk, (line) => {
    let type: unknown;
    try {
      type = (JSON.parse(line) as Record<string, unknown>)["type"];
    } catch {
      process.stderr.write(`protocol_violation: unparseable command line (${line.length} bytes)\n`);
      return;
    }
    if (type === "shutdown") {
      if (hung) return; // a hung worker cannot process frames
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      process.exit(0);
    } else {
      process.stderr.write(`unexpected_parent_frame: ${String(type).slice(0, 64)}\n`);
    }
  });
});
process.stdin.on("end", () => {
  const partial = parser.end();
  if (partial !== null) process.stderr.write("partial_command_line_dropped\n");
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  process.exit(0);
});
