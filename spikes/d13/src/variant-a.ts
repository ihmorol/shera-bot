/**
 * S03 spike — Variant A: Pi as a child process with JSONL over stdin/stdout
 * (the D14 shape). This file is the transport-specific caller code measured by
 * the spike; shared supervision policy lives in supervision-core.ts.
 *
 * Caller responsibilities here: spawn the child, strict JSONL framing on stdout
 * (pi-mono rpc rule: split only on "\n", flush partial on end), command writes
 * to stdin, OS-pipe pause/resume for backpressure, exit-event crash detection.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { JsonLineParser, PROTOCOL_VERSION, nowMs, parseJsonLine } from "./contract.ts";
import {
  PiSupervisorCore,
  type CoreOptions,
  type SupervisionCallbacks,
} from "./supervision-core.ts";

export type { SupervisedToken } from "./supervision-core.ts";

export type VariantAOptions = CoreOptions & {
  stubPath: string;
  emitLog: string;
  heartbeatMs: number;
  tokenDelayMs: number;
  tokens: number;
  /** Forwarded to the stub: hang after the first token (watchdog scenario). */
  hangAfterFirstToken: boolean;
  /** Forwarded to the stub: pad token payloads to ~this many bytes. */
  tokenBytes: number;
};

export class JsonlStdioSupervisor extends PiSupervisorCore {
  private optsA: VariantAOptions;
  private child: ChildProcess | null = null;
  private parser = new JsonLineParser();
  private readyResolver: (() => void) | null = null;

  stderrBytes = 0;

  constructor(optsA: VariantAOptions, callbacks: SupervisionCallbacks) {
    super(
      {
        sessionId: optsA.sessionId,
        watchdogTimeoutMs: optsA.watchdogTimeoutMs,
        maxQueue: optsA.maxQueue,
        consumerDelayMs: optsA.consumerDelayMs,
      },
      callbacks,
      {
        send: (cmd) => {
          this.child?.stdin?.write(JSON.stringify(cmd) + "\n");
        },
        setPaused: (paused) => {
          if (paused) this.child?.stdout?.pause();
          else this.child?.stdout?.resume();
        },
      },
    );
    this.optsA = optsA;
  }

  /** Spawn the Pi child; resolves on the ready handshake. */
  start(): Promise<void> {
    const startedAt = nowMs();
    const child = spawn(
      process.execPath,
      [
        this.optsA.stubPath,
        "--session-id",
        this.optsA.sessionId,
        "--tokens",
        String(this.optsA.tokens),
        "--token-delay-ms",
        String(this.optsA.tokenDelayMs),
        "--heartbeat-ms",
        String(this.optsA.heartbeatMs),
        "--emit-log",
        this.optsA.emitLog,
        "--ttft-delay-ms",
        "20",
        ...(this.optsA.hangAfterFirstToken ? ["--hang-after-first-token", "true"] : []),
        ...(this.optsA.tokenBytes > 0 ? ["--token-bytes", String(this.optsA.tokenBytes)] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.parser = new JsonLineParser();

    const ready = new Promise<void>((resolve, reject) => {
      const failSafe = setTimeout(() => reject(new Error("no ready within 5000ms")), 5000);
      this.readyResolver = () => {
        clearTimeout(failSafe);
        this.metrics.readyAtMs = nowMs() - startedAt;
        this.startWatchdog();
        resolve();
      };
      child.on("error", (err) => {
        clearTimeout(failSafe);
        reject(err);
      });
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.parser.push(chunk, (l) => this.onLine(l)));
    child.stdout?.on("close", () => {
      const partial = this.parser.end();
      if (partial !== null) this.handleDroppedPartial();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrBytes += chunk.length; // diagnostic only; would be redacted (D14)
    });
    child.on("exit", (code, signal) => {
      this.handleDeath({
        code,
        signal,
        detectedAtMs: nowMs(),
      });
    });
    return ready;
  }

  private onLine(line: string): void {
    const event = parseJsonLine(line);
    if (event !== null && typeof event === "object" && "type" in event && event.type === "ready") {
      if (event.proto_version !== PROTOCOL_VERSION) {
        throw new Error(`protocol version mismatch: ${String(event.proto_version)}`);
      }
      this.readyResolver?.();
      this.readyResolver = null;
      return;
    }
    this.handleEvent(event as Parameters<this["handleEvent"]>[0]);
  }

  /** Send one prompt; resolves when the stream completes, rejects on death. */
  prompt(text: string, fromSeq: number): Promise<void> {
    return this.dispatchPrompt(text, fromSeq);
  }

  /** Crash injection: SIGKILL the child (mid-stream in the loss scenario). */
  kill(signal: NodeJS.Signals): void {
    this.markKillRequested();
    this.child?.kill(signal);
  }

  /** Restart after death: new process, same session identity (D32 pattern). */
  async restart(): Promise<void> {
    this.resetRunState();
    await this.start();
  }

  /** Clean shutdown. */
  async stop(): Promise<void> {
    this.stopWatchdog();
    if (this.child && this.child.exitCode === null) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
      await new Promise<void>((r) => setTimeout(r, 50));
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
  }
}
