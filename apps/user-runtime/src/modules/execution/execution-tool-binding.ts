/**
 * Execution tool bindings (S26 chunk 3; PRD §7, D27, D35, D23 rule 2, G2/G3/
 * G6) — the runtime-owned implementations of the sandboxed code-execution and
 * terminal-execution tool families. They are TOOL BINDINGS: the S21 executor
 * is the ONE execution path, and these bindings only run through its async
 * dispatch (E33's recorded arrival) with the executor-minted authority —
 * their sync `execute` is a typed refusal, so no direct call can perform the
 * effect (AC1).
 *
 * The D27 envelope, assembled here per execution:
 *   - the working directory is resolved and checked against the workspace
 *     scope BEFORE anything spawns and before every file operation (the
 *     sandbox-policy layer: traversal, absolute host paths, planted-symlink
 *     escapes are typed SANDBOX_PATH_ESCAPE refusals);
 *   - the child environment is the fixed allowlist (buildSandboxEnv) — the
 *     runtime's process.env is never consulted (AC5);
 *   - the child runs through the adapters/process spawn seam inside a user+net
 *     namespace (network disabled), under prlimit kernel limits (memory/CPU/
 *     processes/file-size) and the tool's OWN wall-clock (timeout_ms), with
 *     the optional cgroup layer applied by the composition;
 *   - stdout/stderr stream through the S18 TerminalRecorder (redaction and
 *     bounding happen at that boundary — G3) and into a bounded capture for
 *     the result text;
 *   - exit codes and durations are recorded in the result text; a limit death
 *     (kernel SIGXCPU/SIGXFSZ/OOM or the wall clock) is the typed
 *     SANDBOX_LIMIT_EXCEEDED failure; the cancel seam (ctx.signal) kills the
 *     whole process tree (D27 termination).
 *
 * Unprivileged execution posture (D27 "child tasks run under a restricted OS
 * user"): the runtime itself never runs as root — the child inherits the
 * runtime's already-unprivileged uid, and the user namespace maps it to root
 * ONLY inside the namespace (no host privilege). A dedicated sandbox uid via
 * setuid is not available unprivileged; the compose deployment (S35) owns
 * that final hardening. Recorded in E36.
 */
import { accessSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import {
  probeCgroupBaseDir,
  type SandboxExecutionHandle,
  type SandboxSpawnRequest,
} from "../../adapters/process/execution-process-spawn.ts";
import {
  prepareDirectoryInsideScope,
  buildSandboxEnv,
  resolveFileInsideScope,
} from "./sandbox-policy.ts";
import { redactSecrets } from "../terminals/secret-redaction.ts";
import type { TerminalRecorder } from "../terminals/terminal-recorder.service.ts";
import {
  ToolBindingError,
  type ToolBinding,
  type ToolExecutionContext,
  type ToolPreview,
  type ToolBindingResult,
} from "../tools/tool-binding.ts";

/** The redacted operator-fault sink shape (the transport's RedactedLogger). */
export type ExecutionFaultLog = (event: string, fields: Record<string, unknown>) => void;

/** Code-payload size cap (characters) — a tool argument, bounded (G3). */
const CODE_MAX_CHARS = 1_000_000;
/** Shell-command size cap (characters). */
const COMMAND_MAX_CHARS = 65_536;
/** The result text's output head budget (characters; the recorder bounds too). */
const OUTPUT_HEAD_CHARS = 4_096;
/** The adapter's forwarded-output cap for one execution. */
const MAX_FORWARDED_BYTES = 4 * 1024 * 1024;
/**
 * The artifact threshold (AC8): a stream over this size becomes an artifact
 * instead of (only) a bounded head in the history row.
 */
const ARTIFACT_THRESHOLD_CHARS = 64 * 1024;

export interface ExecutionToolDeps {
  /** The sandbox spawn seam (the real adapter; tests may inject). */
  spawn: (request: SandboxSpawnRequest) => SandboxExecutionHandle;
  /** The workspace scopes execution tools may run inside (workspace_id → absolute root). */
  workspaceRoots: Record<string, string>;
  /** The S18 terminal recorder; null skips recording (unit tests). */
  terminalRecorder: TerminalRecorder | null;
  /** The artifact sink for large outputs (chunk 4); null disables it. */
  artifacts: Pick<ArtifactsRepository, "insertArtifact"> | null;
  /** Contained operator-fault sink (callers own the redaction discipline). */
  logFault: ExecutionFaultLog;
  /** Injectable clock for the terminal rows; default wall clock. */
  now?: (() => string) | undefined;
  /** The probed delegated cgroup base (composition); null/undefined = no layer. */
  cgroupBaseDir?: string | null;
}

/** The supported code payload languages (fixed; the interpreter set is probed). */
const LANGUAGES = {
  node: { ext: ".cjs", binary: () => process.execPath },
  python3: {
    ext: ".py",
    binary: () => resolveFirstExisting(["/usr/bin/python3", "/usr/local/bin/python3"]),
  },
  shell: { ext: ".sh", binary: () => "/bin/sh" },
} as const;

type Language = keyof typeof LANGUAGES;

function resolveFirstExisting(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new ToolBindingError(
    "SANDBOX_LAUNCH_FAILED",
    `SANDBOX_LAUNCH_FAILED: no interpreter found (searched: ${candidates.join(", ")})`,
  );
}

/** The sandbox failure vocabulary a binding raises (executor passthrough). */
function sandboxError(
  code: "SANDBOX_PATH_ESCAPE" | "SANDBOX_LAUNCH_FAILED",
  message: string,
): ToolBindingError {
  return new ToolBindingError(code, `${code}: ${message}`);
}

interface DecodedExecution {
  argv: string[];
  /** The human-facing command line for the terminal record and previews. */
  commandLabel: string;
  workdirAbsolute: string;
  workdirDisplay: string;
}

/**
 * Shared pre-flight: resolve the workspace scope, resolve and prepare the
 * working directory inside it (the D27 checks), and build the interpreter
 * argv. Every refusal here is a typed SANDBOX_* failure that NEVER spawns.
 */
function preflight(
  deps: ExecutionToolDeps,
  ctx: ToolExecutionContext,
  requested: { workdir?: unknown },
  build: (workdirAbsolute: string) => { argv: string[]; commandLabel: string },
): DecodedExecution {
  const root = deps.workspaceRoots[ctx.execution.workspace_id];
  if (root === undefined) {
    throw sandboxError(
      "SANDBOX_LAUNCH_FAILED",
      `no workspace scope is configured for ${ctx.execution.workspace_id}`,
    );
  }
  const requestedWorkdir =
    typeof requested.workdir === "string" && requested.workdir !== "" ? requested.workdir : ".";
  let workdir;
  try {
    workdir = prepareDirectoryInsideScope(root, requestedWorkdir);
  } catch (error) {
    if (error instanceof Error && error.name === "SandboxPolicyError") {
      throw sandboxError("SANDBOX_PATH_ESCAPE", error.message);
    }
    throw error;
  }
  // TMPDIR inside the workdir (the env names it; create it so children can use it).
  const tmpdirPath = resolveFileInsideScope(workdir.absolute, ".tmp");
  try {
    mkdirSync(tmpdirPath.absolute, { recursive: true });
  } catch {
    // exists already
  }
  const { argv, commandLabel } = build(workdir.absolute);
  return {
    argv,
    commandLabel,
    workdirAbsolute: workdir.absolute,
    workdirDisplay: workdir.relative,
  };
}

/**
 * The shared execution body: spawn through the sandbox seam, stream the
 * output through the terminal recorder (redaction at that boundary) and a
 * bounded capture, classify the exit, and settle the result. Exit codes and
 * durations are ALWAYS recorded; a limit death or a cancellation is a typed
 * failure; an ordinary non-zero exit is a succeeded tool execution whose exit
 * code is data.
 */
async function runSandboxed(
  deps: ExecutionToolDeps,
  ctx: ToolExecutionContext,
  execution: DecodedExecution,
): Promise<ToolBindingResult> {
  const startedAtMs = Date.now();
  const limits = ctx.resourceLimits;
  const wallClockMs = Math.max(1, ctx.deadline - ctx.nowMs());

  const approvalState =
    ctx.execution.approval_id !== null || ctx.execution.grant_id !== null
      ? "approved"
      : "not_required";

  // The terminal record opens BEFORE the spawn (the D35 facts: command,
  // workdir, the resource policy ACTUALLY enforced, the record-time approval
  // state). A recording failure is contained — it never costs the execution.
  let terminalId: string | null = null;
  if (deps.terminalRecorder !== null) {
    try {
      terminalId = deps.terminalRecorder.startExecution({
        workspace_id: ctx.execution.workspace_id,
        agent_id: ctx.execution.agent_id,
        session_id: null,
        command: execution.commandLabel,
        workdir: execution.workdirAbsolute,
        resource_policy: {
          network: "disabled",
          wall_clock_ms: wallClockMs,
          limits: {
            max_memory_mb: limits.max_memory_mb,
            max_cpu_seconds: limits.max_cpu_seconds,
            max_processes: limits.max_processes,
            max_disk_mb: limits.max_disk_mb,
          },
          enforcement: {
            namespace: "user+net (unshare)",
            rlimits: ["data", "cpu", "nproc", "fsize"],
            cgroup: deps.cgroupBaseDir ? "memory+pids" : "unavailable",
          },
        },
        approval_state: approvalState,
      });
    } catch (error) {
      deps.logFault("execution_terminal_record_failed", {
        execution_id: ctx.execution.execution_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  const recordOutput = (stream: "stdout" | "stderr", chunk: string): void => {
    if (deps.terminalRecorder !== null && terminalId !== null) {
      try {
        deps.terminalRecorder.recordOutput({
          workspace_id: ctx.execution.workspace_id,
          agent_id: ctx.execution.agent_id,
          terminal_id: terminalId,
          stream,
          raw_chunk: chunk,
        });
      } catch (error) {
        deps.logFault("execution_terminal_output_record_failed", {
          execution_id: ctx.execution.execution_id,
          name: error instanceof Error ? error.name : "Error",
        });
      }
    }
  };

  let cancelled = ctx.signal.aborted;

  // The capture accumulates the REDACTED stream (G3: one redaction boundary
  // before every sink — the terminal rows, the artifact bytes, the result
  // head all receive the same redacted text; the recorder's own pass still
  // runs, defense in depth). `totalStreamChars` counts the WHOLE forwarded
  // stream so the artifact threshold is a real size decision; the capture
  // itself is capped (the runtime's memory stays bounded whatever the child
  // emits).
  const capturedChunks: string[] = [];
  let capturedChars = 0;
  let totalStreamChars = 0;
  const CAPTURE_CAP_CHARS = 4 * 1024 * 1024;
  let streamTruncated = false;

  let handle: SandboxExecutionHandle;
  try {
    handle = deps.spawn({
      command: execution.argv,
      cwd: execution.workdirAbsolute,
      env: buildSandboxEnv(execution.workdirAbsolute),
      networkDisabled: true,
      limits: {
        memoryBytes: limits.max_memory_mb * 1024 * 1024,
        cpuSeconds: limits.max_cpu_seconds,
        maxProcesses: limits.max_processes,
        diskBytes: limits.max_disk_mb * 1024 * 1024,
      },
      wallClockMs,
      maxForwardedBytes: MAX_FORWARDED_BYTES,
      cgroupBaseDir: deps.cgroupBaseDir ?? null,
      id: ctx.execution.execution_id,
      onOutput: (stream, chunk) => {
        // G3: redact BEFORE any sink. The recorder re-runs its own pass.
        const redacted = redactSecrets(chunk);
        recordOutput(stream, redacted);
        totalStreamChars += redacted.length;
        if (capturedChars < CAPTURE_CAP_CHARS) {
          const head = redacted.slice(0, CAPTURE_CAP_CHARS - capturedChars);
          capturedChunks.push(stream === "stdout" ? head : `[stderr] ${head}`);
          capturedChars += head.length;
        }
      },
      onTruncated: () => {
        streamTruncated = true;
      },
    });
  } catch (error) {
    throw sandboxError(
      "SANDBOX_LAUNCH_FAILED",
      `the sandbox spawn refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The cancel seam (D27): aborting ctx.signal kills the whole process tree.
  const onAbortKill = (): void => {
    cancelled = true;
    handle.cancel();
  };
  if (ctx.signal.aborted) {
    onAbortKill();
  } else {
    ctx.signal.addEventListener("abort", onAbortKill, { once: true });
  }

  let exit;
  try {
    exit = await handle.waitForExit();
  } finally {
    ctx.signal.removeEventListener("abort", onAbortKill);
  }

  const durationMs = Date.now() - startedAtMs;
  const exitLabel = exit.code !== null ? `exit=${exit.code}` : `signal=${exit.signal ?? "unknown"}`;

  if (deps.terminalRecorder !== null && terminalId !== null) {
    try {
      deps.terminalRecorder.recordExit({
        workspace_id: ctx.execution.workspace_id,
        agent_id: ctx.execution.agent_id,
        terminal_id: terminalId,
        exit_code: exit.code,
        exit_signal: exit.signal ?? null,
      });
    } catch (error) {
      deps.logFault("execution_terminal_exit_record_failed", {
        execution_id: ctx.execution.execution_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  // Typed failures first: the cancel seam, then a limit death, then a spawn
  // refusal. Everything else is a succeeded execution whose exit code is data.
  if (cancelled || exit.cancelled) {
    return {
      ok: false,
      errorCode: "TOOL_EXECUTION_CANCELLED",
      message: "the execution was cancelled; the process tree was terminated",
    };
  }
  if (exit.limitDeath !== null) {
    return {
      ok: false,
      errorCode: "SANDBOX_LIMIT_EXCEEDED",
      message: `the execution hit an enforced limit (${exit.limitDeath}); ${exitLabel}`,
    };
  }
  if (exit.spawnError !== null) {
    return {
      ok: false,
      errorCode: "SANDBOX_LAUNCH_FAILED",
      message: `the sandbox spawn refused: ${exit.spawnError}`,
    };
  }

  // AC8: a stream over the artifact threshold becomes an ARTIFACT whose bytes
  // are the REDACTED captured stream; the result text carries a bounded head
  // plus the artifact pointer — the prompt/history payloads stay bounded
  // whatever the child emitted. A capture truncated by the cap (or the
  // adapter's forwarded-stream cap) says so; the artifact is never dressed up
  // as complete (G4).
  let artifactNote = "";
  if (deps.artifacts !== null && (totalStreamChars > ARTIFACT_THRESHOLD_CHARS || streamTruncated)) {
    try {
      const truncatedNote =
        streamTruncated || capturedChars >= CAPTURE_CAP_CHARS
          ? "\n[output truncated at the capture cap]"
          : "";
      const capturedText = `${capturedChunks.join("")}${truncatedNote}`;
      const ref = deps.artifacts.insertArtifact({
        workspace_id: ctx.execution.workspace_id,
        name: `execution-${ctx.execution.execution_id}-output`,
        artifact_type: "execution_output",
        mime_type: "text/plain; charset=utf-8",
        content: Buffer.from(capturedText, "utf8"),
        producer_agent_id: ctx.execution.agent_id,
        producer_task_id: ctx.execution.task_id,
      });
      artifactNote = `\n[full output (${totalStreamChars} chars) captured as artifact ${ref.artifact_id.slice(0, 8)}…]`;
    } catch (error) {
      // The artifact sink failing never fails the execution — the bounded
      // head still records the result honestly.
      deps.logFault("execution_artifact_write_failed", {
        execution_id: ctx.execution.execution_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  // G3: the result head is the already-redacted capture (redaction happened
  // at the stream boundary, before every sink); the executor's redactAndBound
  // re-covers it — defense in depth.
  const head = capturedChunks.join("").slice(0, OUTPUT_HEAD_CHARS);
  const text = `${exitLabel} duration_ms=${durationMs}${artifactNote}\n${head}`.trimEnd();
  return { ok: true, text };
}

function assertAuthorityAgain(ctx: ToolExecutionContext): void {
  // The dispatch already minted the authority; re-asserting here keeps the
  // binding's own contract honest even if a future caller bypasses the
  // executor's dispatch path construction.
  if (ctx.authority === undefined) {
    throw new ToolBindingError(
      "EXECUTION_AUTHORITY_MISSING",
      "tool bindings execute only through the runtime executor (AC1)",
    );
  }
}

/** Refuse the sync execute path for the process-backed family (AC1). */
function refuseSyncExecute(): ToolBindingResult {
  throw new ToolBindingError(
    "TOOL_BINDING_FAILED",
    "TOOL_BINDING_FAILED: the execution tool family is process-backed and runs only through the executor's async dispatch",
  );
}

/** The D35 preview text: command, working directory, resource policy (data). */
function executionPreview(command: string, workdir: string, limits: unknown): ToolPreview {
  return {
    kind: "command",
    text: `$ ${command}\nworkdir: ${workdir}\nresources: ${JSON.stringify(limits)}`,
  };
}

/**
 * The sandboxed code-execution tool family (tool_code_exec). Arguments:
 * `language` ("node" | "python3" | "shell"), `code` (the payload), optional
 * `workdir` (scope-relative). The payload is written to a runtime-named file
 * inside the checked workdir and executed by the interpreter under the D27
 * envelope.
 */
export function makeCodeExecutionBinding(deps: ExecutionToolDeps): ToolBinding {
  return {
    name: "code-execution",
    preview(args) {
      const language = typeof args.language === "string" ? args.language : "";
      const code = typeof args.code === "string" ? args.code : "";
      const workdir = typeof args.workdir === "string" && args.workdir !== "" ? args.workdir : ".";
      return executionPreview(
        `${language} -c ${JSON.stringify(code.slice(0, 120))}${code.length > 120 ? "…" : ""}`,
        workdir,
        "tool resource_limits",
      );
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertAuthorityAgain(ctx);
      const language = typeof args.language === "string" ? (args.language as Language) : "";
      const code = typeof args.code === "string" ? args.code : "";
      if (!(language in LANGUAGES)) {
        throw sandboxError(
          "SANDBOX_LAUNCH_FAILED",
          `unsupported language ${JSON.stringify(language)} (supported: ${Object.keys(LANGUAGES).join(", ")})`,
        );
      }
      if (code === "" || code.length > CODE_MAX_CHARS) {
        throw sandboxError(
          "SANDBOX_LAUNCH_FAILED",
          `the code payload must be 1..${CODE_MAX_CHARS} characters`,
        );
      }
      const spec = LANGUAGES[language as Language];
      const execution = preflight(deps, ctx, args, (workdirAbsolute) => {
        // The payload file is runtime-named and path-checked inside the workdir
        // (D27: resolution and checks before every file operation).
        const payloadPath = resolveFileInsideScope(
          workdirAbsolute,
          `shera-exec-${ctx.execution.execution_id}${spec.ext}`,
        );
        let interpreter: string;
        try {
          interpreter = spec.binary();
        } catch (error) {
          throw error instanceof ToolBindingError
            ? error
            : sandboxError("SANDBOX_LAUNCH_FAILED", "the interpreter is unavailable");
        }
        try {
          writeFileSync(payloadPath.absolute, code, { mode: 0o600 });
        } catch (error) {
          throw sandboxError(
            "SANDBOX_LAUNCH_FAILED",
            `the payload could not be written: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const argv =
          language === "shell"
            ? ["/bin/sh", payloadPath.absolute]
            : [interpreter, payloadPath.absolute];
        return {
          argv,
          commandLabel: `${language} ${payloadPath.relative} (${code.length} chars)`,
        };
      });
      return runSandboxed(deps, ctx, execution);
    },
  };
}

/**
 * The sandboxed terminal-execution tool family (tool_terminal_exec).
 * Arguments: `command` (one shell line), optional `workdir` (scope-relative).
 * Runs under /bin/sh -c with the same D27 envelope; the output streams live
 * through the terminal recorder so the read-only terminal view shows real
 * executions (the E31 D14 deferral fulfilled).
 */
export function makeTerminalExecutionBinding(deps: ExecutionToolDeps): ToolBinding {
  return {
    name: "terminal-execution",
    preview(args) {
      const command = typeof args.command === "string" ? args.command : "";
      const workdir = typeof args.workdir === "string" && args.workdir !== "" ? args.workdir : ".";
      return executionPreview(
        `$ ${command.slice(0, 120)}${command.length > 120 ? "…" : ""}`,
        workdir,
        "tool resource_limits",
      );
    },
    execute: () => refuseSyncExecute(),
    async executeAsync(args, ctx) {
      assertAuthorityAgain(ctx);
      const command = typeof args.command === "string" ? args.command : "";
      if (command === "" || command.length > COMMAND_MAX_CHARS) {
        throw sandboxError(
          "SANDBOX_LAUNCH_FAILED",
          `the command must be 1..${COMMAND_MAX_CHARS} characters`,
        );
      }
      const execution = preflight(deps, ctx, args, () => ({
        argv: ["/bin/sh", "-c", command],
        commandLabel: command,
      }));
      return runSandboxed(deps, ctx, execution);
    },
  };
}

/**
 * The composition's cgroup-base probe (re-exported so the composition stays
 * in the transport layer without importing the adapter's internals).
 */
export const probeExecutionCgroupBase = probeCgroupBaseDir;

/** The workspace scope join helper for composition-provided roots. */
export function executionWorkspaceRoot(dataDir: string, workspaceId: string): string {
  return join(dataDir, "execution-workspaces", workspaceId);
}
