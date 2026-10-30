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
 * - memory hoarding (S16 chunk 2 kernel tests): --allocate-mb N allocates and
 *   TOUCHES N MB in 32 MB chunks right after ready; under a prlimit --as cap
 *   the allocation fails (catchable RangeError) → a diagnostic line on
 *   stderr (G3: diagnostic, never protocol) → exit(1). Under a generous cap
 *   the allocation succeeds and the worker proceeds normally.
 * - process creation (S16 chunk 2 kernel tests): --fork-children N spawns N
 *   short-lived node children after ready; any fork failure (e.g. EAGAIN
 *   under a prlimit --nproc cap) is reported on stderr and exits(1).
 *
 * Governing records: D32, D33, E8, G3, E1.
 */
import { JsonLineParser } from "@shera-bot/pi-protocol";

import {
  encodeWorkerFrame,
  WORKER_PROTOCOL_VERSION,
  type WorkerChildFrame,
} from "./worker-frames.ts";

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
const allocateMb = numberArg("allocate-mb", 0);
const forkChildren = numberArg("fork-children", 0);
// S22 tree-cancellation probes: spawn ONE long-lived descendant (`sleep`) and
// record its pid in a marker file; report this process's pid + process group
// id in another (the detached-spawn proof: pgid === pid means the worker
// LEADS its own group, so a negative-pid kill reaches the whole tree).
const spawnDescendant = args["spawn-descendant"] === "true";
// S22 capture/test scoping: apply the scripted error to ONE run id only
// (the harness command is shared across runs; a run-scoped error lets one
// run fail transiently while its siblings stay healthy).
const errorOnRun = args["error-on-run"] ?? "";
const descendantMarkerFile = args["descendant-marker-file"] ?? "";
const groupMarkerFile = args["group-marker-file"] ?? "";

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

/**
 * Allocate and TOUCH (zero-fill) `targetMb` in 32 MB chunks, keeping the
 * references so the address space really grows. Returns false (after a
 * stderr diagnostic — never protocol, G3) when the allocation fails, which
 * under a prlimit --as cap is the KERNEL limit being hit.
 */
function hoardMemory(targetMb: number): boolean {
  const chunkBytes = 32 * 1024 * 1024;
  const chunks: Buffer[] = [];
  try {
    for (let allocated = 0; allocated < targetMb; allocated += 32) {
      chunks.push(Buffer.alloc(chunkBytes, 1));
    }
    return true;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    process.stderr.write(`allocation_failed: ${name} after ${chunks.length * 32} MB\n`);
    return false;
  }
}

/**
 * Spawn `count` short-lived node children SEQUENTIALLY, waiting for each.
 * Returns false (after a stderr diagnostic) when any fork is denied — under
 * a prlimit --nproc cap that is the KERNEL limit being hit (RLIMIT_NPROC is
 * enforced per real user id, so a low cap denies forks at the kernel
 * boundary; a cap of 1 even denies the child's own boot-time threads).
 */
async function spawnChildren(count: number): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  let failed = 0;
  for (let i = 0; i < count; i++) {
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
          stdio: "ignore",
        });
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
      });
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) {
    process.stderr.write(`fork_denied: ${failed} of ${count} spawns failed\n`);
    return false;
  }
  return true;
}

async function run(): Promise<void> {
  if (slowTtftMs > 0) await delay(slowTtftMs); // heartbeats keep flowing
  if (allocateMb > 0 && !hoardMemory(allocateMb)) process.exit(1); // kernel cap hit
  if (forkChildren > 0 && !(await spawnChildren(forkChildren))) process.exit(1);
  if (spawnDescendant && descendantMarkerFile !== "") {
    const { spawn } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    // A long-lived descendant that ignores nothing: plain `sleep`, same
    // process group as this worker. Its pid lands in the marker file so the
    // suite can probe it with kill(pid, 0) after the cancellation.
    const descendant = spawn("sleep", ["600"], { stdio: "ignore" });
    writeFileSync(descendantMarkerFile, String(descendant.pid ?? 0));
  }
  if (groupMarkerFile !== "") {
    const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
    // Linux: /proc/self/stat field 5 is the process group id (there is no
    // getpgid in Node). The detached-spawn proof reads pgid === pid.
    let pgid = process.pid;
    try {
      if (existsSync("/proc/self/stat")) {
        const stat = readFileSync("/proc/self/stat", "utf8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
        pgid = Number(afterComm.split(" ")[2]);
      }
    } catch {
      // fall back to the pid (leader assumption)
    }
    writeFileSync(groupMarkerFile, JSON.stringify({ pid: process.pid, pgid }));
  }
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
    if (errorOnStep === step && (errorOnRun === "" || errorOnRun === args["run-id"])) {
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
