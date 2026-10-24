/**
 * Fake Pi factory: spawns the stdio child (fake-pi-child.ts) as a real node
 * process and exposes a typed harness around it (D14 rule: tests use fake Pi
 * processes with deterministic events and failures).
 *
 * Every child stdout line is classified through parseFrame, so suites assert
 * both the healthy frame stream and each misbehavior's typed error. The
 * benchmark-only machinery from the S03 spike (emit log, source-side
 * backpressure accounting) stays in the spike; this harness is for
 * correctness tests.
 *
 * Governing records: D13, D14, E17.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PiProtocolError,
  ProtocolVersionError,
  ProtocolViolationError,
} from "./errors.ts";
import { JsonLineParser, encodeFrame, parseFrame } from "./framing.ts";
import {
  PROTOCOL_VERSION,
  isPiChildFrame,
  type HelloFrame,
  type PiChildFrame,
  type PiParentFrame,
} from "./protocol.ts";

/** Child entry script path, resolved relative to this module. */
export const FAKE_PI_CHILD_SCRIPT = fileURLToPath(new URL("./fake-pi-child.ts", import.meta.url));

export type SpawnFakePiOptions = {
  sessionId?: string;
  /** Tokens streamed per prompt. */
  tokens?: number;
  tokenDelayMs?: number;
  ttftDelayMs?: number;
  /** 0 disables heartbeats (the silence misbehavior). */
  heartbeatMs?: number;
  /** Wrong-version misbehavior: announced on hello/ready and every frame's v. */
  protocolVersion?: number;
  /** Emit one line that is not JSON right after ready. */
  invalidJsonLine?: boolean;
  /** Emit one frame with an unknown type right after ready. */
  unknownFrameType?: boolean;
  /** Stop tokens and heartbeats after the first token; keep the process alive. */
  hangAfterFirstToken?: boolean;
  /** Hard-exit once a prompt has emitted this many tokens (intrinsic crash). */
  crashAfterTokens?: number;
  /** Hard-exit(137) on a prompt whose text is exactly "crash". */
  crashOnPrompt?: boolean;
};

export type FakePiExit = { code: number | null; signal: string | null };

export type ClassifiedFrame =
  | { ok: true; frame: PiChildFrame; line: string }
  | { ok: false; error: PiProtocolError; line: string };

export type FrameListener = (entry: ClassifiedFrame) => void;

export class FakePiHandle {
  readonly child: ChildProcess;
  readonly sessionId: string;
  /** Every child stdout line, classified through parseFrame, in arrival order. */
  readonly frames: ClassifiedFrame[] = [];
  /** Diagnostic stderr chunks (D14: stderr is diagnostic, never protocol). */
  readonly stderr: string[] = [];
  /**
   * Resolves on the first hello frame; rejects ProtocolVersionError when the
   * announced protocol_version does not match PROTOCOL_VERSION (negotiation
   * policy is the host's, so validateFrame itself stays structural).
   */
  readonly hello: Promise<HelloFrame>;

  private readonly listeners = new Set<FrameListener>();
  private readonly parser = new JsonLineParser();
  private readonly exitPromise: Promise<FakePiExit>;
  private readonly resolveExit: (exit: FakePiExit) => void;
  private readonly resolveHello: (frame: HelloFrame) => void;
  private readonly rejectHello: (error: Error) => void;
  private helloSettled = false;
  private promptCount = 0;

  constructor(child: ChildProcess, sessionId: string) {
    let resolveExit!: (exit: FakePiExit) => void;
    const exitPromise = new Promise<FakePiExit>((resolve) => {
      resolveExit = resolve;
    });
    let resolveHello!: (frame: HelloFrame) => void;
    let rejectHello!: (error: Error) => void;
    const hello = new Promise<HelloFrame>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    hello.catch(() => {}); // tolerate suites that never await the handshake
    this.child = child;
    this.sessionId = sessionId;
    this.exitPromise = exitPromise;
    this.resolveExit = resolveExit;
    this.resolveHello = resolveHello;
    this.rejectHello = rejectHello;
    this.hello = hello;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.parser.push(chunk, (line) => this.ingestLine(line));
    });
    child.stdout?.on("close", () => {
      const partial = this.parser.end();
      if (partial !== null) {
        this.record({
          ok: false,
          error: new ProtocolViolationError({
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
      if (!this.helloSettled) {
        this.helloSettled = true;
        this.rejectHello(new Error("fake pi failed to spawn"));
      }
      this.resolveExit({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => {
      if (!this.helloSettled) {
        this.helloSettled = true;
        this.rejectHello(new Error("fake pi exited before hello"));
      }
      this.resolveExit({ code, signal: signal ?? null });
    });
  }

  /** Subscribe to classified frames; returns an unsubscribe function. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send one parent frame to the child (no-op once the child has died). */
  send(frame: PiParentFrame): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin?.write(encodeFrame(frame));
  }

  /** Send one prompt; returns its correlation id. */
  prompt(text: string, fromSeq = 0): string {
    const id = `cmd-${++this.promptCount}`;
    this.send({ v: PROTOCOL_VERSION, type: "prompt", id, session_id: this.sessionId, text, from_seq: fromSeq });
    return id;
  }

  /** Graceful stop: shutdown frame, stdin end, then SIGTERM/SIGKILL escalation. */
  async shutdown(): Promise<FakePiExit> {
    this.send({ v: PROTOCOL_VERSION, type: "shutdown" });
    this.child.stdin?.end();
    const escalate = setTimeout(() => this.child.kill("SIGTERM"), 2000);
    const forceKill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    const exit = await this.exitPromise;
    clearTimeout(escalate);
    clearTimeout(forceKill);
    return exit;
  }

  waitForExit(): Promise<FakePiExit> {
    return this.exitPromise;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.child.kill(signal);
  }

  private ingestLine(line: string): void {
    try {
      const frame = parseFrame(line);
      if (isPiChildFrame(frame)) {
        this.record({ ok: true, frame, line });
      } else {
        this.record({
          ok: false,
          error: new ProtocolViolationError({
            reason: "unknown_frame_type",
            detail: `unexpected parent frame from child: ${frame.type}`,
          }),
          line,
        });
      }
    } catch (error) {
      if (error instanceof PiProtocolError) {
        this.record({ ok: false, error, line });
      } else {
        this.record({
          ok: false,
          error: new ProtocolViolationError({
            reason: "unparseable_json_line",
            detail: String(error),
          }),
          line,
        });
      }
    }
  }

  private record(entry: ClassifiedFrame): void {
    this.frames.push(entry);
    for (const listener of this.listeners) listener(entry);
    if (this.helloSettled) return;
    if (entry.ok && entry.frame.type === "hello") {
      this.helloSettled = true;
      if (entry.frame.protocol_version !== PROTOCOL_VERSION) {
        this.rejectHello(
          new ProtocolVersionError({
            expected: PROTOCOL_VERSION,
            received: entry.frame.protocol_version,
          }),
        );
      } else {
        this.resolveHello(entry.frame);
      }
      return;
    }
    // A wrong-version child also stamps the wrong `v` on hello, so the line is
    // rejected at the envelope gate before it can be classified as a hello
    // frame. Negotiation is the host's policy (see validateFrame), so settle
    // the handshake with the ProtocolVersionError when the raw line was
    // intended as hello.
    if (!entry.ok && entry.error instanceof ProtocolVersionError && isHelloIntent(entry.line)) {
      this.helloSettled = true;
      this.rejectHello(entry.error);
    }
  }
}

/** True when the raw line was intended as a hello frame (a handshake attempt). */
function isHelloIntent(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>)["type"] === "hello"
    );
  } catch {
    return false;
  }
}

function fakePiArgs(options: SpawnFakePiOptions): string[] {
  const args: string[] = [];
  const push = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined) return;
    args.push(`--${key}`, String(value));
  };
  push("session-id", options.sessionId);
  push("tokens", options.tokens);
  push("token-delay-ms", options.tokenDelayMs);
  push("ttft-delay-ms", options.ttftDelayMs);
  push("heartbeat-ms", options.heartbeatMs);
  push("protocol-version", options.protocolVersion);
  push("invalid-json-line", options.invalidJsonLine);
  push("unknown-frame-type", options.unknownFrameType);
  push("hang-after-first-token", options.hangAfterFirstToken);
  push("crash-after-tokens", options.crashAfterTokens);
  push("crash-on-prompt", options.crashOnPrompt);
  return args;
}

/** Spawn the fake Pi as a real node child process and return the harness. */
export function spawnFakePi(options: SpawnFakePiOptions = {}): FakePiHandle {
  const sessionId = options.sessionId ?? "fake-pi";
  const child = spawn(process.execPath, [FAKE_PI_CHILD_SCRIPT, ...fakePiArgs(options)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new FakePiHandle(child, sessionId);
}
