/**
 * Production task-worker spawn adapter (S16 chunk 2) — the REAL spawn side of
 * the supervisor's spawnChild seam, with per-worker kernel resource limits
 * (E1 admission control, the AC's REAL-limits demand).
 *
 * Enforcement mechanism: the worker command is wrapped in prlimit(1)
 * (util-linux) exec'd as a BINARY — `prlimit --as=<bytes> --nproc=<count> --
 * <file> <args...>` — never through a shell (no argv injection surface; the
 * argv elements are passed verbatim to execve). `--as` caps the worker's
 * address space (the per-worker memory budget from the admission policy —
 * allocation fails inside the child instead of the runtime growing
 * unbounded); `--nproc` caps process creation (RLIMIT_NPROC; note the kernel
 * enforces it per real user id, so a very low cap denies the child's own
 * boot-time thread creation — the worker dies at the kernel boundary either
 * way, which is the point).
 *
 * Honesty about the environment (G4): prlimit is resolved once through a
 * candidate-path probe; a missing binary is a TYPED error naming the binary
 * and the searched paths — never a silent fall-back to unlimited workers.
 * Composition roots call resolvePrlimitBinary() at startup when admission is
 * configured, turning the gap into a startup failure.
 *
 * Child output discipline (G3): this adapter forwards RAW stdout lines and
 * stderr chunks through the TaskWorkerChild seam only — it journals nothing
 * and interprets nothing; the supervisor owns classification, redaction
 * bounds and the journal.
 *
 * Process spawning lives in the process-adapter boundary per the runtime
 * boundary guard; this file is a NAMED exception there (production adapter,
 * same rationale as the fake worker test double).
 *
 * Governing records: E1, D27, D32, G3, G4.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";

import { JsonLineParser } from "@shera-bot/pi-protocol";

import { encodeWorkerFrame, type WorkerParentFrame } from "./worker-frames.ts";
import type {
  TaskWorkerChild,
  TaskWorkerChildExit,
  TaskWorkerSpawnRequest,
} from "./task-worker-supervisor.service.ts";

/** util-linux install locations probed in order (Ubuntu: /usr/bin/prlimit). */
export const PRLIMIT_BIN_CANDIDATES: readonly string[] = [
  "/usr/bin/prlimit",
  "/bin/prlimit",
  "/usr/local/bin/prlimit",
];

/** Typed startup failure when the kernel-limit binary is unavailable (G4). */
export class PrlimitUnavailableError extends Error {
  readonly code = "PRLIMIT_UNAVAILABLE" as const;
  readonly category = "state" as const;

  constructor(candidates: readonly string[]) {
    super(
      `PRLIMIT_UNAVAILABLE: prlimit binary not found (searched: ${candidates.join(", ")}); ` +
        "per-worker kernel resource limits (E1) require util-linux prlimit",
    );
    this.name = "PrlimitUnavailableError";
  }
}

/** Resolve the prlimit binary; typed failure naming the searched paths (G4). */
export function resolvePrlimitBinary(
  candidates: readonly string[] = PRLIMIT_BIN_CANDIDATES,
): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new PrlimitUnavailableError(candidates);
}

/** The worker command the composition root supplies (file + argv, no shell). */
export interface WorkerCommand {
  file: string;
  args: readonly string[];
}

/**
 * The configured task-worker harness command (S16 chunk 3) — the same shape
 * as the session harness config, parsed from SHERA_WORKER_HARNESS_COMMAND/
 * _ARGS in main.ts. The committed demo worker (fake-task-worker-child.ts) is
 * the harness command for tests and preview; production real workers arrive
 * with the tools slice. Per-spawn placeholders in the args are substituted
 * from the spawn request: `{run_id}`, `{worker_id}`, `{heartbeat_interval_ms}`
 * — never a shell, never an interpolation layer (G3/G4: the elements pass to
 * execve verbatim after substitution).
 */
export interface TaskWorkerHarnessConfig {
  /** Executable path (resolved through the host PATH like any spawn). */
  file: string;
  /** Static arguments, plus the per-spawn placeholders documented above. */
  args?: readonly string[];
}

/** Substitute the documented per-spawn placeholders into the static args. */
export function workerHarnessArgs(config: TaskWorkerHarnessConfig, request: TaskWorkerSpawnRequest): string[] {
  return (config.args ?? []).map((arg) =>
    arg
      .replaceAll("{run_id}", request.run_id)
      .replaceAll("{worker_id}", request.worker_id)
      .replaceAll("{heartbeat_interval_ms}", String(request.heartbeat_interval_ms)),
  );
}

/**
 * Build the supervisor's spawnChild seam from the configured harness command:
 * every incarnation spawns the SAME executable with the per-spawn placeholder
 * substitution, wrapped in prlimit when the request carries kernel limits.
 * `prlimitPath` (resolved once at composition startup — the G4 typed-failure
 * point) is forwarded so spawns never re-probe.
 */
export function createTaskWorkerSpawn(
  config: TaskWorkerHarnessConfig,
  options: { prlimitPath?: string } = {},
): (request: TaskWorkerSpawnRequest) => TaskWorkerChild {
  return (request: TaskWorkerSpawnRequest): TaskWorkerChild =>
    spawnTaskWorkerChild(
      request,
      { file: config.file, args: workerHarnessArgs(config, request) },
      options,
    );
}

/** Wrap one worker command with prlimit per the request's resource limits. */
export function prlimitArgv(
  request: TaskWorkerSpawnRequest,
  command: WorkerCommand,
  prlimitPath: string,
): string[] {
  const limits = request.resourceLimits;
  if (limits === null || limits === undefined) {
    return [command.file, ...command.args];
  }
  return [
    prlimitPath,
    `--as=${limits.memoryBytes}`,
    `--nproc=${limits.maxProcesses}`,
    "--",
    command.file,
    ...command.args,
  ];
}

/**
 * Spawn one task-worker child through the prlimit wrapper (a BINARY exec —
 * no shell) and expose it through the supervisor's raw TaskWorkerChild seam.
 * resourceLimits === null spawns the command unwrapped (chunk-1 behavior
 * when no admission policy is configured).
 */
export function spawnTaskWorkerChild(
  request: TaskWorkerSpawnRequest,
  command: WorkerCommand,
  options: { prlimitPath?: string } = {},
): TaskWorkerChild {
  // prlimit is only NEEDED when the request carries kernel limits — an
  // unlimited worker (no admission policy) spawns unwrapped and must not
  // demand the binary (chunk-1 behavior on hosts without util-linux).
  const prlimitPath =
    request.resourceLimits === null || request.resourceLimits === undefined
      ? null
      : (options.prlimitPath ?? resolvePrlimitBinary());
  const argv = prlimitArgv(request, command, prlimitPath ?? "");
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let resolveExit!: (exit: TaskWorkerChildExit) => void;
  const exitPromise = new Promise<TaskWorkerChildExit>((resolve) => {
    resolveExit = resolve;
  });
  // EPIPE on stdin is expected when the child dies mid-write.
  child.stdin?.on("error", () => {});
  child.on("error", () => {
    // Spawn-level failure (ENOENT etc.): no process ever ran.
    resolveExit({ code: null, signal: null });
  });
  child.on("exit", (code, signal) => {
    resolveExit({ code, signal: signal ?? null });
  });

  const lineListeners = new Set<(line: string) => void>();
  const stderrListeners = new Set<(chunk: string) => void>();

  const parser = new JsonLineParser();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    parser.push(chunk, (line) => lineListeners.forEach((listener) => listener(line)));
  });
  child.stdout?.on("end", () => {
    const partial = parser.end();
    if (partial !== null) lineListeners.forEach((listener) => listener(partial));
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrListeners.forEach((listener) => listener(chunk));
  });

  return {
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onStderr: (listener) => {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    send: (frame: WorkerParentFrame) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.write(encodeWorkerFrame(frame));
    },
    kill: (signal: NodeJS.Signals = "SIGKILL") => {
      child.kill(signal);
    },
    waitForExit: () => exitPromise,
  };
}
