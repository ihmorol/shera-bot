/**
 * Fake task worker factory: spawns the stdio child (fake-task-worker-child.ts)
 * as a real node process and exposes a typed harness around it (D32/E8 rule:
 * tests use fake worker processes with deterministic events and failures).
 *
 * Every child stdout line is classified through parseWorkerFrame, so suites
 * assert both the healthy frame stream and each misbehavior's typed error —
 * the exact pattern of the D14 fake Pi harness, applied to the worker
 * protocol. The SUPERVISOR consumes only raw lines through its injected
 * TaskWorkerChild seam; this harness exists for the TEST side to observe and
 * wrap.
 *
 * Governing records: D32, D33, E8, G3.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { JsonLineParser } from "@shera-bot/pi-protocol";

import {
  WorkerProtocolError,
  encodeWorkerFrame,
  parseWorkerFrame,
  type WorkerChildFrame,
  type WorkerParentFrame,
} from "./worker-frames.ts";

/** Child entry script path, resolved relative to this module. */
export const FAKE_TASK_WORKER_CHILD_SCRIPT = fileURLToPath(
  new URL("./fake-task-worker-child.ts", import.meta.url),
);

export interface SpawnFakeTaskWorkerOptions {
  runId?: string;
  workerId?: string;
  /** Scripted work steps (each emits one progress frame). */
  steps?: number;
  stepDelayMs?: number;
  /** 0 disables heartbeats (a silence misbehavior variant). */
  heartbeatMs?: number;
  /** Hard-exit(137) before this step's progress (intrinsic crash). */
  crashOnStep?: number;
  /** Emit an error frame instead of this step's progress, then exit. */
  errorOnStep?: number;
  errorClass?: string;
  /** 0 = hang right after ready; N = hang after step N (silence misbehavior). */
  hangAfterStep?: number;
  /** Long time-to-first-progress while heartbeats keep flowing (slow ≠ stalled). */
  slowTtftMs?: number;
  /** Emit a checkpoint frame after every Nth step (0 = none). */
  checkpointEvery?: number;
  /** Wrong-version misbehavior: announced on hello and every frame's v. */
  protocolVersion?: number;
}

export type FakeTaskWorkerExit = { code: number | null; signal: string | null };

export type WorkerClassifiedFrame =
  | { ok: true; frame: WorkerChildFrame; line: string }
  | { ok: false; error: WorkerProtocolError; line: string };

export type WorkerFrameListener = (entry: WorkerClassifiedFrame) => void;

export class FakeTaskWorkerHandle {
  readonly child: ChildProcess;
  /** Every child stdout line, classified through parseWorkerFrame, in order. */
  readonly frames: WorkerClassifiedFrame[] = [];
  /** Diagnostic stderr chunks (never protocol, G3). */
  readonly stderr: string[] = [];

  private readonly listeners = new Set<WorkerFrameListener>();
  private readonly parser = new JsonLineParser();
  private readonly exitPromise: Promise<FakeTaskWorkerExit>;
  private readonly resolveExit: (exit: FakeTaskWorkerExit) => void;

  constructor(child: ChildProcess) {
    let resolveExit!: (exit: FakeTaskWorkerExit) => void;
    const exitPromise = new Promise<FakeTaskWorkerExit>((resolve) => {
      resolveExit = resolve;
    });
    this.child = child;
    this.exitPromise = exitPromise;
    this.resolveExit = resolveExit;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.parser.push(chunk, (line) => this.ingestLine(line));
    });
    child.stdout?.on("close", () => {
      // A trailing partial line at stream end is a death artifact — recorded
      // as a classified violation, never silently swallowed.
      const partial = this.parser.end();
      if (partial !== null) {
        this.record({
          ok: false,
          error: new WorkerProtocolError({
            reason: "unparseable_json_line",
            detail: "partial line at stream end",
          }),
          line: partial,
        });
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr.push(chunk);
    });
    // EPIPE on stdin is expected when the child dies mid-write in crash tests.
    child.stdin?.on("error", () => {});
    child.on("error", () => {
      // Spawn-level failure: no process ever ran.
      this.resolveExit({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => {
      this.resolveExit({ code, signal: signal ?? null });
    });
  }

  /** Subscribe to classified frames; returns an unsubscribe function. */
  onFrame(listener: WorkerFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send one parent frame to the child (no-op once the child has died). */
  send(frame: WorkerParentFrame): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.write(encodeWorkerFrame(frame));
  }

  waitForExit(): Promise<FakeTaskWorkerExit> {
    return this.exitPromise;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child.kill(signal);
  }

  private ingestLine(line: string): void {
    try {
      const frame = parseWorkerFrame(line);
      this.record({ ok: true, frame, line });
    } catch (error) {
      this.record({
        ok: false,
        error:
          error instanceof WorkerProtocolError
            ? error
            : new WorkerProtocolError({ reason: "unparseable_json_line" }),
        line,
      });
    }
  }

  private record(entry: WorkerClassifiedFrame): void {
    this.frames.push(entry);
    for (const listener of this.listeners) listener(entry);
  }
}

function fakeWorkerArgs(options: SpawnFakeTaskWorkerOptions): string[] {
  const args: string[] = [];
  const push = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined) return;
    args.push(`--${key}`, String(value));
  };
  push("run-id", options.runId);
  push("worker-id", options.workerId);
  push("steps", options.steps);
  push("step-delay-ms", options.stepDelayMs);
  push("heartbeat-ms", options.heartbeatMs);
  push("crash-on-step", options.crashOnStep);
  push("error-on-step", options.errorOnStep);
  push("error-class", options.errorClass);
  push("hang-after-step", options.hangAfterStep);
  push("slow-ttft-ms", options.slowTtftMs);
  push("checkpoint-every", options.checkpointEvery);
  push("protocol-version", options.protocolVersion);
  return args;
}

/** Spawn the fake task worker as a real node child process and return the harness. */
export function spawnFakeTaskWorker(options: SpawnFakeTaskWorkerOptions = {}): FakeTaskWorkerHandle {
  const child = spawn(
    process.execPath,
    [FAKE_TASK_WORKER_CHILD_SCRIPT, ...fakeWorkerArgs(options)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return new FakeTaskWorkerHandle(child);
}
