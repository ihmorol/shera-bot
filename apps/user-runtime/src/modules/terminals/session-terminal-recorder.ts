/**
 * Session spawn seam terminal recorder (S18 chunk 1) — the wrapper that puts
 * the TerminalRecorder ON the session/harness spawn seam the slice names.
 *
 * The D14 protocol has NO terminal frame (verified: child→parent frames are
 * hello/ready/heartbeat/token/completed/fatal/error only), so nothing in the
 * child's protocol stream can tell the runtime what terminal command an Agent
 * ran, in which directory, under which policy. What the seam DOES already
 * emit — and what this wrapper therefore derives terminal events from, on the
 * runtime side — is:
 *
 *   1. The spawn request itself: the runtime is about to EXECUTE the
 *      configured harness command on the Agent's behalf. The substituted argv
 *      (exactly what createSessionProcessSpawn will pass to the OS), the
 *      child's working directory (it inherits the runtime's — no cwd override
 *      exists at this seam), the supervision policy that bounds the child,
 *      and the honest approval posture (starting an Agent's own session
 *      requires no approval) are all known here.
 *   2. The child's stderr: the only raw output channel this seam exposes
 *      (stdout is the versioned protocol). Chunks stream into the recorder
 *      — through the redaction boundary — while the supervisor's own stderr
 *      consumer keeps working unchanged (the wrapper is transparent).
 *   3. The child's exit: code and/or signal, closing the record.
 *
 * Recorded truthfulness note: `os_resource_limits` is null in the recorded
 * resource policy because NO OS-level resource policy is enforced on session
 * children in this slice (the D27 restricted-child-process work arrives with
 * the execution slices). The supervision bounds that DO constrain the child
 * are recorded alongside — the panel never dresses up a limit that is not
 * enforced (G4).
 *
 * CONTAINMENT: a recording failure must never cost the Agent its session —
 * every recorder call is contained, the fault is logged through the
 * composition's redacted sink, and the child is handed to the supervisor
 * exactly as the unwrapped seam would (the same discipline as the
 * supervisor's own journal containment).
 *
 * Governing records: D10 (row+journal atomic), D14 (no terminal frame), D32
 * layer 2, G3 (redaction before persistence), G4 (record the truth).
 */
import type { SessionHarnessConfig } from "../../adapters/process/session-process-spawn.ts";
import type {
  SessionChild,
  SessionChildExit,
  SessionSpawnRequest,
} from "../sessions/session-supervisor.service.ts";
import type { TerminalRecorder } from "./terminal-recorder.service.ts";

/**
 * The supervision facts recorded with every session-seam execution: the
 * bounds the runtime actually enforces on the child (heartbeat watchdog,
 * bounded stderr forwarding, the escalation ladder). The composition derives
 * them from the merged session policy.
 */
export interface SessionSupervisionRecord {
  heartbeat_interval_ms: number;
  watchdog_window_ms: number;
  stderr_max_bytes: number;
  escalation: "shutdown_frame_then_sigterm_then_sigkill";
}

export interface SessionSpawnObserverDeps {
  recorder: TerminalRecorder;
  /** The configured session harness command (the argv the OS will run). */
  harness: SessionHarnessConfig;
  supervision: SessionSupervisionRecord;
  logFault: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Wrap a spawnChild function so every Agent session child the runtime
 * launches is recorded as one terminal execution. The returned function has
 * the SessionSupervisor's spawnChild signature and is transparent otherwise.
 */
export function observeSessionSpawnWithTerminalRecorder(
  deps: SessionSpawnObserverDeps,
  rawSpawn: (request: SessionSpawnRequest) => SessionChild,
): (request: SessionSpawnRequest) => SessionChild {
  return (request: SessionSpawnRequest): SessionChild => {
    // The substituted argv — verbatim the substitution createSessionProcessSpawn
    // applies, so the recorded command is the command the OS actually runs.
    const argv = (deps.harness.args ?? []).map((arg) =>
      arg
        .replaceAll("{session_id}", request.session_id)
        .replaceAll("{heartbeat_interval_ms}", String(request.heartbeat_interval_ms)),
    );
    const command = [deps.harness.command, ...argv].join(" ");

    let terminalId: string | null = null;
    try {
      terminalId = deps.recorder.startExecution({
        workspace_id: request.workspace_id,
        agent_id: request.agent_id,
        session_id: request.session_id,
        command,
        // No cwd override exists at this seam: the child truthfully inherits
        // the runtime process's working directory.
        workdir: process.cwd(),
        resource_policy: {
          os_resource_limits: null,
          supervision: { ...deps.supervision },
        },
        approval_state: "not_required",
      });
    } catch (error) {
      deps.logFault("terminal_record_start_failed", {
        workspace_id: request.workspace_id,
        agent_id: request.agent_id,
        session_id: request.session_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const child = rawSpawn(request);

    return {
      onLine: (listener) => child.onLine(listener),
      onStderr: (listener) => {
        // The recorder observes the chunk FIRST, the supervisor's own
        // consumer unchanged — the redaction boundary is persistence, not
        // the process pipe.
        return child.onStderr((chunk) => {
          if (terminalId !== null) {
            try {
              deps.recorder.recordOutput({
                workspace_id: request.workspace_id,
                agent_id: request.agent_id,
                terminal_id: terminalId,
                stream: "stderr",
                raw_chunk: chunk,
              });
            } catch (error) {
              deps.logFault("terminal_record_output_failed", {
                workspace_id: request.workspace_id,
                agent_id: request.agent_id,
                terminal_id: terminalId,
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          listener(chunk);
        });
      },
      send: (frame) => child.send(frame),
      kill: (signal) => child.kill(signal),
      waitForExit: () =>
        child.waitForExit().then((exit: SessionChildExit) => {
          if (terminalId !== null) {
            try {
              deps.recorder.recordExit({
                workspace_id: request.workspace_id,
                agent_id: request.agent_id,
                terminal_id: terminalId,
                exit_code: exit.code,
                exit_signal: exit.signal,
              });
            } catch (error) {
              deps.logFault("terminal_record_exit_failed", {
                workspace_id: request.workspace_id,
                agent_id: request.agent_id,
                terminal_id: terminalId,
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return exit;
        }),
    };
  };
}
