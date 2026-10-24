/**
 * SessionProcessSpawn (S12 chunk 3) — the production process seam for Agent
 * sessions: the ONLY production file allowed to import node:child_process for
 * sessions (boundary guard PROCESS_BOUNDARY; the D14 fake Pi test double is a
 * named exception of its own).
 *
 * It adapts a CONFIGURED harness command (the executable that will speak the
 * versioned JSONL Pi protocol on stdio — the real Pi adapter arrives in a
 * later slice; tests configure the fake-Pi child script) into the
 * SessionSupervisor's `spawnChild(request)` shape. The ADAPTER conforms to
 * the supervisor's contract, never the reverse: raw stdout lines in, encoded
 * parent frames out, escalation-owned kill, exit awaited.
 *
 * Per-spawn wiring:
 * - `{session_id}` and `{heartbeat_interval_ms}` placeholders in the
 *   configured args are substituted from the spawn request, so harnesses that
 *   take configuration at spawn time (and the fake-Pi test harness, which
 *   must beat at the supervisor's ms-scale watchdog cadence) receive the
 *   request values verbatim. A production harness that needs no arguments
 *   simply configures none.
 * - The D15 compact session context travels through the
 *   `SHERA_SESSION_CONTEXT` environment variable (one JSON document), NOT the
 *   command line: argv is world-readable through process listings, and user
 *   instructions are private prose (G3). The child owns decoding it; the
 *   fake-Pi test harness ignores it.
 *
 * Death artifacts: a killed child can truncate its final stdout line. The
 * trailing partial is DISCARDED here — the exit itself records the crash, and
 * classifying a truncation as a protocol violation would double-count a death
 * as misbehavior (D14: death is detected independently of any final event).
 *
 * Governing records: D13, D14, D15, D23 rule 2, G3.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { JsonLineParser, encodeFrame, type PiParentFrame } from "@shera-bot/pi-protocol";

import type {
  SessionChild,
  SessionChildExit,
  SessionSpawnRequest,
} from "../../modules/sessions/session-supervisor.service.ts";

/** The environment variable carrying the D15 compact session context (JSON). */
export const SHERA_SESSION_CONTEXT_ENV = "SHERA_SESSION_CONTEXT";

/** The configured harness command the supervisor spawns per incarnation. */
export interface SessionHarnessConfig {
  /** Executable path (resolved through the host PATH like any spawn). */
  command: string;
  /**
   * Static arguments, plus the two per-spawn placeholders documented in the
   * header (`{session_id}`, `{heartbeat_interval_ms}`). Split on the config
   * side — never a shell string (no shell interpolation, G3).
   */
  args?: readonly string[];
}

/** One stdio child process wrapped as the supervisor's SessionChild. */
class ProcessSessionChild implements SessionChild {
  private readonly exitPromise: Promise<SessionChildExit>;
  private readonly resolveExit: (exit: SessionChildExit) => void;
  private readonly parser = new JsonLineParser();

  constructor(private readonly child: ChildProcess) {
    let resolveExit!: (exit: SessionChildExit) => void;
    this.exitPromise = new Promise<SessionChildExit>((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = resolveExit;
    // Either event may arrive first depending on the failure; both are
    // honest exits and resolving twice is a no-op.
    child.on("exit", (code, signal) => {
      this.resolveExit({ code, signal: signal ?? null });
    });
    child.on("error", () => {
      // Spawn-level failure (ENOENT, EACCES): no process ever ran. The nulls
      // are the supervisor's cue for its crash/restart policy — a broken
      // harness command surfaces as recorded crash events and a terminal
      // session, never as a silent hang.
      this.resolveExit({ code: null, signal: null });
    });
    // EPIPE on stdin is expected when the child dies mid-write (crash tests,
    // supervised kills); the exit path owns the aftermath.
    child.stdin?.on("error", () => {});
  }

  onLine(listener: (line: string) => void): () => void {
    this.child.stdout?.setEncoding("utf8");
    const onData = (chunk: string): void => {
      this.parser.push(chunk, (line) => listener(line));
    };
    const onClose = (): void => {
      // A trailing partial line at stream end is a death artifact (see
      // header) — discarded, never classified as a protocol violation.
      this.parser.end();
    };
    this.child.stdout?.on("data", onData);
    this.child.stdout?.on("close", onClose);
    return () => {
      this.child.stdout?.off("data", onData);
      this.child.stdout?.off("close", onClose);
    };
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.child.stderr?.setEncoding("utf8");
    const onData = (chunk: string): void => listener(chunk);
    this.child.stderr?.on("data", onData);
    return () => {
      this.child.stderr?.off("data", onData);
    };
  }

  send(frame: PiParentFrame): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.write(encodeFrame(frame));
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  waitForExit(): Promise<SessionChildExit> {
    return this.exitPromise;
  }
}

/**
 * Build the supervisor's spawnChild seam from the configured harness command.
 * Synchronous: the spawn itself is async by nature — a spawn-level failure
 * surfaces through waitForExit (see the error handler above), matching the
 * supervisor's crash/restart policy rather than a thrown address.
 */
export function createSessionProcessSpawn(
  config: SessionHarnessConfig,
): (request: SessionSpawnRequest) => SessionChild {
  return (request: SessionSpawnRequest): SessionChild => {
    const args = (config.args ?? []).map((arg) =>
      arg
        .replaceAll("{session_id}", request.session_id)
        .replaceAll("{heartbeat_interval_ms}", String(request.heartbeat_interval_ms)),
    );
    const child = spawn(config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // The D15 compact context — private prose must not ride argv (G3).
        [SHERA_SESSION_CONTEXT_ENV]: JSON.stringify(request.context),
      },
    });
    return new ProcessSessionChild(child);
  };
}
