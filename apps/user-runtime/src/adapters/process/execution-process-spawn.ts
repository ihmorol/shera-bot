/**
 * The sandboxed execution spawn seam (S26 chunk 1; D23 rule 2, D27, E1
 * kernel-enforcement precedent, G3/G4) — the ONE place the execution tools
 * touch `node:child_process`, inside the adapters/process boundary exactly
 * like the session spawn (S12), the worker spawn (S16), and the
 * validation-command spawn (S19). Nothing in modules/ spawns processes.
 *
 * The D27 sandbox envelope this adapter builds (the machine-reality story is
 * recorded in E36; every layer is probed, never assumed):
 *
 *   1. NETWORK DISABLED BY DEFAULT — the command is exec'd inside a new user
 *      + network namespace (`unshare --user --map-root-user --net`), where the
 *      loopback device exists but is DOWN and no route exists: a real outbound
 *      connect fails with ENETUNREACH (pinned by test). The namespace is the
 *      kernel's own boundary — the runtime does not filter traffic. When the
 *      unshare binary or the kernel refuses, the spawn FAILS CLOSED (typed
 *      error surfaced through the exit) — never a silent networked child.
 *      Compose deployments (S35) add `network: none` at the container layer.
 *   2. KERNEL RESOURCE LIMITS — the command is wrapped in prlimit(1) exec'd as
 *      a BINARY (no shell; argv elements pass to execve verbatim, the S16
 *      pattern): `--data` (RLIMIT_DATA: the heap/anonymous-memory growth cap —
 *      chosen over --as because interpreters reserve large VIRTUAL address
 *      space; on this box node v24 boots at data>=1GiB but not at as<2GiB),
 *      `--cpu` (RLIMIT_CPU: SIGXCPU at the ceiling), `--nproc` (RLIMIT_NPROC —
 *      inside the user namespace the kernel counts the namespace's own
 *      processes, pinned by test), `--fsize` (RLIMIT_FSIZE: SIGXFSZ).
 *      The applied soft limits are VERIFIED against /proc/<pid>/limits right
 *      after spawn and surfaced on the exit (demonstrated enforcement).
 *   3. CGROUP LAYER (best-effort, honestly recorded) — when the composition
 *      provides a delegated cgroup-v2 subtree (probed under
 *      user@1000.service on this box), the child is moved into a per-execution
 *      leaf with memory.max and pids.max written BEFORE the move: the kernel
 *      OOM-kills a real memory hog (SIGKILL) where RLIMIT_DATA only refuses
 *      allocations, and pids.max bounds the tree from OUTSIDE the namespace.
 *      A missing delegation leaves the layer null — recorded, never faked.
 *   4. WALL CLOCK + PROCESS-TREE TERMINATION — the child runs detached (its
 *      own process group); the wall-clock ceiling and cancel() both
 *      SIGKILL the WHOLE group (`kill(-pid)`, the S19 detached+group-kill
 *      pattern with its post-exit reap), so no descendant survives.
 *
 * Child output discipline (G3): this adapter forwards RAW stdout/stderr
 * chunks through the request's sink and interprets nothing; the binding owns
 * redaction, bounds, the terminal record, and the history. Forwarding is
 * capped at `maxForwardedBytes` after which the sink stops receiving (the
 * final `onTruncated()` marker fires once) — a runaway child cannot inflate
 * the runtime's memory or the journal.
 *
 * The child environment is EXACTLY `request.env` — the adapter never spreads
 * `process.env` (the runtime's environment must be invisible to executed
 * code; AC5's planted-secret pin).
 *
 * Governing records: D23 rule 2, D27, E1 (prlimit precedent), E13, G3, G4.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** util-linux unshare install locations probed in order (Ubuntu: /usr/bin). */
export const UNSHARE_BIN_CANDIDATES: readonly string[] = [
  "/usr/bin/unshare",
  "/bin/unshare",
  "/usr/sbin/unshare",
];

/** util-linux prlimit install locations (same probe as the S16 adapter). */
export const EXECUTION_PRLIMIT_CANDIDATES: readonly string[] = [
  "/usr/bin/prlimit",
  "/bin/prlimit",
  "/usr/local/bin/prlimit",
];

/** Typed failure when a required enforcement binary is unavailable (G4). */
export class UnshareUnavailableError extends Error {
  readonly code = "UNSHARE_UNAVAILABLE";
  constructor(candidates: readonly string[]) {
    super(
      `UNSHARE_UNAVAILABLE: unshare binary not found (searched: ${candidates.join(", ")}); ` +
        "D27 network-disabled execution requires util-linux unshare",
    );
    this.name = "UnshareUnavailableError";
  }
}

export class ExecutionPrlimitUnavailableError extends Error {
  readonly code = "EXECUTION_PRLIMIT_UNAVAILABLE";
  constructor(candidates: readonly string[]) {
    super(
      `EXECUTION_PRLIMIT_UNAVAILABLE: prlimit binary not found (searched: ${candidates.join(", ")}); ` +
        "D27 kernel resource limits require util-linux prlimit",
    );
    this.name = "ExecutionPrlimitUnavailableError";
  }
}

function resolveBinary(
  candidates: readonly string[],
  error: new (c: readonly string[]) => Error,
): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new error(candidates);
}

/** Resolve the unshare binary; typed failure naming the searched paths (G4). */
export function resolveUnshareBinary(
  candidates: readonly string[] = UNSHARE_BIN_CANDIDATES,
): string {
  return resolveBinary(candidates, UnshareUnavailableError);
}

/** Resolve the prlimit binary for the execution envelope (G4). */
export function resolveExecutionPrlimitBinary(
  candidates: readonly string[] = EXECUTION_PRLIMIT_CANDIDATES,
): string {
  return resolveBinary(candidates, ExecutionPrlimitUnavailableError);
}

/** The kernel resource limits the D27 envelope enforces on one execution. */
export interface SandboxKernelLimits {
  /** RLIMIT_DATA soft ceiling in bytes (heap/anonymous growth); null = unset. */
  memoryBytes: number | null;
  /** RLIMIT_CPU soft ceiling in seconds (SIGXCPU); null = unset. */
  cpuSeconds: number | null;
  /** RLIMIT_NPROC soft ceiling (processes); null = unset. */
  maxProcesses: number | null;
  /** RLIMIT_FSIZE soft ceiling in bytes (SIGXFSZ); null = unset. */
  diskBytes: number | null;
}

/** The spawn request: everything the sandbox needs, nothing else (G3). */
export interface SandboxSpawnRequest {
  /** The argv elements, passed to execve verbatim — NEVER a shell string. */
  command: readonly string[];
  /** The resolved, policy-checked working directory (policy layer's duty). */
  cwd: string;
  /** The child environment, verbatim — never merged with process.env (AC5). */
  env: Record<string, string>;
  /** When true (the D27 default) the child runs inside a user+net namespace. */
  networkDisabled: boolean;
  limits: SandboxKernelLimits;
  /** The wall-clock ceiling in ms (SIGKILL to the whole group); null = unset. */
  wallClockMs: number | null;
  /** Raw output sink (the binding owns redaction and bounds). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Fired once when forwarding hit the cap (the child kept its output). */
  onTruncated?: () => void;
  /** Total forwarded-bytes cap (default 4 MiB). */
  maxForwardedBytes?: number;
  /** Delegated cgroup-v2 subtree for the memory/pids leaf; null = no layer. */
  cgroupBaseDir?: string | null;
  /** Stable id naming the cgroup leaf (an execution id). */
  id?: string;
}

/** One verified rlimit row from /proc/<pid>/limits. */
export interface VerifiedLimit {
  soft: string;
  hard: string;
  units: string;
}

export interface SandboxExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The wall-clock ceiling fired and killed the group. */
  timedOut: boolean;
  /** cancel() fired (the D27 termination seam), whatever the exit shape. */
  cancelled: boolean;
  /**
   * The typed limit-death classification: the kernel (or the wall clock)
   * ended the process at an enforced boundary. Null = an ordinary exit.
   */
  limitDeath: "wall_clock" | "cpu" | "disk" | "memory_oom" | "sigkill" | null;
  /** /proc/<pid>/limits rows read right after spawn (best effort). */
  verifiedLimits: Record<string, VerifiedLimit> | null;
  /** The cgroup layer's applied bounds (null when the layer is absent). */
  cgroupApplied: { cgroup_path: string; memory_max: string; pids_max: string } | null;
  /** Spawn-level failure detail (ENOENT etc.) — no process ever ran. */
  spawnError: string | null;
}

export interface SandboxExecutionHandle {
  pid: number;
  waitForExit(): Promise<SandboxExit>;
  /** The D27 process-tree termination seam: SIGKILL the whole group. */
  cancel(): void;
}

interface CgroupLeaf {
  path: string;
  memory_max: string;
  pids_max: string;
}

/**
 * Prepare the delegated cgroup leaf for one execution. Every step is
 * best-effort: any refusal (no delegation, no controller, read-only fs)
 * returns null and the execution proceeds with the prlimit layer alone —
 * the honest posture is recorded on the exit, never faked (G4).
 */
function applyCgroupLayer(
  baseDir: string,
  id: string,
  limits: SandboxKernelLimits,
  pid: number,
): CgroupLeaf | null {
  try {
    // Controllers must be enabled on the base's subtree_control for the
    // leaf to carry memory.max/pids.max (idempotent; EEXIST tolerated).
    const wanted: string[] = [];
    if (limits.memoryBytes !== null) wanted.push("+memory");
    if (limits.maxProcesses !== null) wanted.push("+pids");
    if (wanted.length === 0) return null;
    try {
      writeFileSync(join(baseDir, "cgroup.subtree_control"), wanted.join(" ") + "\n");
    } catch {
      // Already-enabled controllers write EEXIST-style failures on some
      // kernels; the leaf file existence check below is the real verdict.
    }
    const leaf = join(baseDir, `exec-${id}`);
    mkdirSync(leaf, { recursive: true });
    let memoryMax = "max";
    let pidsMax = "max";
    if (limits.memoryBytes !== null) {
      writeFileSync(join(leaf, "memory.max"), String(limits.memoryBytes));
      memoryMax = String(limits.memoryBytes);
    }
    if (limits.maxProcesses !== null) {
      writeFileSync(join(leaf, "pids.max"), String(limits.maxProcesses));
      pidsMax = String(limits.maxProcesses);
    }
    writeFileSync(join(leaf, "cgroup.procs"), String(pid));
    return { path: leaf, memory_max: memoryMax, pids_max: pidsMax };
  } catch {
    return null;
  }
}

/** Best-effort leaf teardown: kill anything left, then remove the dir. */
function teardownCgroupLeaf(leaf: CgroupLeaf): void {
  try {
    writeFileSync(join(leaf.path, "cgroup.kill"), "1");
  } catch {
    // best effort
  }
  try {
    rmSync(leaf.path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Read the child's soft limits from /proc/<pid>/limits (best effort). The
 * exec chain (unshare -> prlimit -> command) applies the limits a few
 * instructions after spawn returns, so the first read may still see the
 * RUNTIME's inherited limits: poll briefly (non-blocking) until the requested
 * ceilings appear, the child (and its /proc entry) disappears — the last
 * observation is returned — or the bounded budget expires. The returned rows
 * are the honest observation either way.
 */
async function pollVerifiedLimits(
  pid: number,
  limits: SandboxKernelLimits,
): Promise<Record<string, VerifiedLimit> | null> {
  const requested: Array<[string, string]> = [];
  if (limits.memoryBytes !== null) requested.push(["Max data size", String(limits.memoryBytes)]);
  if (limits.cpuSeconds !== null) requested.push(["Max cpu time", String(limits.cpuSeconds)]);
  if (limits.maxProcesses !== null) requested.push(["Max processes", String(limits.maxProcesses)]);
  if (limits.diskBytes !== null) requested.push(["Max file size", String(limits.diskBytes)]);
  const deadline = Date.now() + 2_000;
  let last: Record<string, VerifiedLimit> | null = null;
  for (;;) {
    const rows = readLimitsOnce(pid);
    if (rows === null) return last; // the child (and its /proc entry) is gone
    last = rows;
    const allMatch = requested.every(([name, value]) => rows[name]?.soft === value);
    if (allMatch || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readLimitsOnce(pid: number): Record<string, VerifiedLimit> | null {
  try {
    const text = readFileSync(`/proc/${pid}/limits`, "utf8");
    const rows: Record<string, VerifiedLimit> = {};
    for (const line of text.split("\n")) {
      // "Max cpu time            1            1            seconds"
      const match = /^(Max [a-z ]+?)\s{2,}(\S+)\s{2,}(\S+)\s{2,}(\S+)\s*$/.exec(line);
      if (match) {
        rows[match[1]!] = { soft: match[2]!, hard: match[3]!, units: match[4]! };
      }
    }
    return Object.keys(rows).length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Spawn one sandboxed execution through the D27 envelope. Synchronous spawn,
 * async exit (the S16 adapter shape): the handle is returned immediately,
 * `waitForExit` resolves when the child's stdio closes and the group is
 * reaped. `deps` injects the resolved binaries — composition roots resolve
 * them once at startup (the G4 typed-failure point); tests may override.
 */
export function spawnSandboxedExecution(
  request: SandboxSpawnRequest,
  deps: {
    unsharePath?: string;
    prlimitPath?: string;
    onCgroupApplied?: (applied: {
      cgroup_path: string;
      memory_max: string;
      pids_max: string;
    }) => void;
  } = {},
): SandboxExecutionHandle {
  const maxForwardedBytes = request.maxForwardedBytes ?? 4 * 1024 * 1024;

  // Fail-closed posture: a network-disabled request with no unshare binary
  // cannot silently fall back to a networked child (G4). The typed error is
  // surfaced through the exit (no process ever ran).
  let unsharePath: string | null = null;
  let spawnErrorMessage: string | null = null;
  if (request.networkDisabled) {
    try {
      unsharePath = deps.unsharePath ?? resolveUnshareBinary();
    } catch (error) {
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  const hasLimits =
    request.limits.memoryBytes !== null ||
    request.limits.cpuSeconds !== null ||
    request.limits.maxProcesses !== null ||
    request.limits.diskBytes !== null;
  let prlimitPath: string | null = null;
  if (hasLimits && spawnErrorMessage === null) {
    try {
      prlimitPath = deps.prlimitPath ?? resolveExecutionPrlimitBinary();
    } catch (error) {
      spawnErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  const argv: string[] = [];
  if (spawnErrorMessage === null && unsharePath !== null) {
    argv.push(unsharePath, "--user", "--map-root-user", "--net", "--");
  }
  if (spawnErrorMessage === null && prlimitPath !== null) {
    argv.push(prlimitPath);
    if (request.limits.memoryBytes !== null) argv.push(`--data=${request.limits.memoryBytes}`);
    if (request.limits.cpuSeconds !== null) {
      // soft:hard — with soft == hard the kernel's SIGKILL-at-hard races the
      // SIGXCPU-at-soft and the death signal is the untyped SIGKILL; with
      // hard one second above soft, SIGXCPU (the TYPED limit boundary) is the
      // terminal signal for any child that does not install a handler.
      const soft = request.limits.cpuSeconds;
      argv.push(`--cpu=${soft}:${soft + 1}`);
    }
    if (request.limits.maxProcesses !== null) argv.push(`--nproc=${request.limits.maxProcesses}`);
    if (request.limits.diskBytes !== null) argv.push(`--fsize=${request.limits.diskBytes}`);
    argv.push("--");
  }
  if (spawnErrorMessage === null) {
    argv.push(...request.command);
  }

  let child: ChildProcess | null = null;
  if (spawnErrorMessage === null) {
    child = spawn(argv[0]!, argv.slice(1), {
      cwd: request.cwd,
      env: request.env, // verbatim — never process.env (AC5)
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group: the wall clock and cancel() kill the WHOLE tree
      // (the S19 rationale — a bare kill of the leader leaves descendants
      // holding the stdio pipes and the close never settles).
      detached: true,
    });
    // EPIPE/etc on stdio is expected when the child dies mid-write.
    child.stdin?.on("error", () => {});
  }

  const pid = child?.pid ?? 0;

  // The cgroup layer moves the ALREADY-spawned child into its leaf (the
  // pre-move window is covered by the prlimit layer, which was active from
  // exec). Best-effort: refusal leaves the layer null, honestly recorded.
  let cgroupLeaf: CgroupLeaf | null = null;
  if (
    child !== null &&
    request.cgroupBaseDir != null &&
    request.id !== undefined &&
    (request.limits.memoryBytes !== null || request.limits.maxProcesses !== null)
  ) {
    cgroupLeaf = applyCgroupLayer(request.cgroupBaseDir, request.id, request.limits, pid);
    if (cgroupLeaf !== null) {
      deps.onCgroupApplied?.({
        cgroup_path: cgroupLeaf.path,
        memory_max: cgroupLeaf.memory_max,
        pids_max: cgroupLeaf.pids_max,
      });
    }
  }

  let resolveExit!: (exit: SandboxExit) => void;
  const exitPromise = new Promise<SandboxExit>((resolve) => {
    resolveExit = resolve;
  });

  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let forwarded = 0;
  let truncationFired = false;

  const forward = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    if (truncationFired) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (forwarded + text.length > maxForwardedBytes) {
      const remaining = maxForwardedBytes - forwarded;
      if (remaining > 0) request.onOutput?.(stream, text.slice(0, remaining));
      truncationFired = true;
      request.onTruncated?.();
      return;
    }
    forwarded += text.length;
    request.onOutput?.(stream, text);
  };

  if (child !== null) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => forward("stdout", chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => forward("stderr", chunk));
  }

  const killTree = (): void => {
    if (child === null || child.pid === undefined) return;
    try {
      // The whole group: unshare/prlimit exec'd into the command (same pid),
      // so the group leader IS the command and the group IS the tree.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group may already be gone; a direct kill is the fallback.
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  };

  const wallClockTimer =
    request.wallClockMs !== null && child !== null
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, request.wallClockMs)
      : null;

  const settle = (exit: SandboxExit): void => {
    if (settled) return;
    settled = true;
    if (wallClockTimer !== null) clearTimeout(wallClockTimer);
    resolveExit(exit);
  };

  if (child === null) {
    // Spawn refused before any process existed (missing binary, typed above).
    setImmediate(() =>
      settle({
        code: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        limitDeath: null,
        verifiedLimits: null,
        cgroupApplied: null,
        spawnError: spawnErrorMessage,
      }),
    );
    return {
      pid: 0,
      waitForExit: () => exitPromise,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  const verifiedLimitsPromise = pollVerifiedLimits(pid, request.limits);

  const classify = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): SandboxExit["limitDeath"] => {
    if (timedOut) return "wall_clock";
    if (signal === "SIGXCPU") return "cpu";
    if (signal === "SIGXFSZ") return "disk";
    if (signal === "SIGKILL" && !cancelled) {
      // A SIGKILL we did not deliver: the kernel OOM killer at the cgroup
      // memory.max when that layer is active, else an unattributed kill.
      return cgroupLeaf !== null && cgroupLeaf.memory_max !== "max" ? "memory_oom" : "sigkill";
    }
    return null;
  };

  child.on("error", async (error) => {
    settle({
      code: null,
      signal: null,
      timedOut,
      cancelled,
      limitDeath: null,
      verifiedLimits: await verifiedLimitsPromise,
      cgroupApplied: cgroupLeaf
        ? {
            cgroup_path: cgroupLeaf.path,
            memory_max: cgroupLeaf.memory_max,
            pids_max: cgroupLeaf.pids_max,
          }
        : null,
      spawnError: error.message,
    });
    if (cgroupLeaf !== null) teardownCgroupLeaf(cgroupLeaf);
  });

  child.on("close", (code, signal) => {
    // Post-exit reap (the S19 pattern): stragglers of the group holding no
    // stdio would otherwise survive the close. One extra group SIGKILL after
    // a short sweep, then the group is checked by the callers' own probes.
    const reap = (): void => {
      try {
        process.kill(-pid, 0);
        // Group still has members: kill again.
        killTree();
      } catch {
        // ESRCH — the group is gone.
      }
    };
    setTimeout(() => {
      reap();
      void verifiedLimitsPromise.then((verifiedLimits) => {
        settle({
          code,
          signal: signal ?? null,
          timedOut,
          cancelled,
          limitDeath: classify(code, signal ?? null),
          verifiedLimits,
          cgroupApplied: cgroupLeaf
            ? {
                cgroup_path: cgroupLeaf.path,
                memory_max: cgroupLeaf.memory_max,
                pids_max: cgroupLeaf.pids_max,
              }
            : null,
          spawnError: null,
        });
        if (cgroupLeaf !== null) teardownCgroupLeaf(cgroupLeaf);
      });
    }, 50);
  });

  return {
    pid,
    waitForExit: () => exitPromise,
    cancel: () => {
      cancelled = true;
      killTree();
    },
  };
}

/** The cgroup base probe shared by the composition (honest null when absent). */
export function probeCgroupBaseDir(candidateBases?: readonly string[]): string | null {
  const bases = candidateBases ?? ["/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service"];
  for (const base of bases) {
    const probe = join(base, "shera-exec-probe");
    try {
      mkdirSync(probe, { recursive: true });
      rmSync(probe, { force: true });
      // The composition's stable base dir (leaves are created per execution).
      const stable = join(base, "shera-exec");
      mkdirSync(stable, { recursive: true });
      return stable;
    } catch {
      // No delegated subtree under this base; try the next.
    }
  }
  return null;
}
