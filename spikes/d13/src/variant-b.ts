/**
 * S03 spike — Variant B: Pi behind a local HTTP sidecar (loopback only).
 * This file is the transport-specific caller code measured by the spike;
 * shared supervision policy lives in supervision-core.ts.
 *
 * Caller responsibilities here: spawn the sidecar process AND supervise it
 * (bootstrap-port handshake on its stdout), open and parse the chunked /events
 * stream, POST prompts, reader-level pause for backpressure (stopping reads
 * propagates TCP backpressure to the sidecar), and hangup detection when the
 * sidecar dies. That is one more moving part than variant A: the sidecar is
 * itself a supervised child.
 */
import { spawn, type ChildProcess } from "node:child_process";

import {
  JsonLineParser,
  PROTOCOL_VERSION,
  nowMs,
  parseJsonLine,
  type PiCommand,
} from "./contract.ts";
import {
  PiSupervisorCore,
  type CoreOptions,
  type SupervisionCallbacks,
} from "./supervision-core.ts";

export type { SupervisedToken } from "./supervision-core.ts";

export type VariantBOptions = CoreOptions & {
  sidecarPath: string;
  emitLog: string;
  heartbeatMs: number;
  tokenDelayMs: number;
  tokens: number;
  /** Forwarded to the stub: hang after the first token (watchdog scenario). */
  hangAfterFirstToken: boolean;
  /** Forwarded to the stub: pad token payloads to ~this many bytes. */
  tokenBytes: number;
};

export class HttpSidecarSupervisor extends PiSupervisorCore {
  private optsB: VariantBOptions;
  private sidecar: ChildProcess | null = null;
  private parser = new JsonLineParser();
  private eventsUrl: string | null = null;
  private abort: AbortController | null = null;
  private readyResolver: (() => void) | null = null;
  private stdoutBuffer = "";
  /** Monotonic run generation; stale streams/exits must not report deaths. */
  private generation = 0;

  stderrBytes = 0;

  constructor(optsB: VariantBOptions, callbacks: SupervisionCallbacks) {
    super(
      {
        sessionId: optsB.sessionId,
        watchdogTimeoutMs: optsB.watchdogTimeoutMs,
        maxQueue: optsB.maxQueue,
        consumerDelayMs: optsB.consumerDelayMs,
      },
      callbacks,
      {
        send: (cmd) => {
          void this.postPrompt(cmd);
        },
        setPaused: (paused) => {
          // Backpressure: stop calling reader.read(). The kernel socket buffer
          // fills, the sidecar's res.write() returns false — TCP backpressure.
          this.paused = paused;
        },
      },
    );
    this.optsB = optsB;
  }

  /** Spawn the sidecar, wait for its bootstrap port line, open /events. */
  start(): Promise<void> {
    const startedAt = nowMs();
    this.generation += 1;
    const gen = this.generation;
    this.sidecar = spawn(
      process.execPath,
      [
        this.optsB.sidecarPath,
        "--session-id",
        this.optsB.sessionId,
        "--port",
        "0",
        "--tokens",
        String(this.optsB.tokens),
        "--token-delay-ms",
        String(this.optsB.tokenDelayMs),
        "--heartbeat-ms",
        String(this.optsB.heartbeatMs),
        "--emit-log",
        this.optsB.emitLog,
        "--ttft-delay-ms",
        "20",
        ...(this.optsB.hangAfterFirstToken ? ["--hang-after-first-token", "true"] : []),
        ...(this.optsB.tokenBytes > 0 ? ["--token-bytes", String(this.optsB.tokenBytes)] : []),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.parser = new JsonLineParser();

    const ready = (async () => {
      const port = await this.awaitBootstrapPort(5000);
      this.eventsUrl = `http://127.0.0.1:${port}/events`;
      const readyPromise = new Promise<void>((resolve, reject) => {
        const failSafe = setTimeout(() => reject(new Error("no ready within 5000ms")), 5000);
        this.readyResolver = () => {
          clearTimeout(failSafe);
          resolve();
        };
      });
      // Runs until hangup; resolves readiness via the ready event callback.
      void this.openEventStream();
      await readyPromise;
      this.metrics.readyAtMs = nowMs() - startedAt;
      this.startWatchdog();
    })();

    this.sidecar.on("exit", (code, signal) => {
      if (gen !== this.generation) return; // stale child from a previous run
      this.abort?.abort();
      this.handleDeath({ code, signal, detectedAtMs: nowMs() });
    });
    this.sidecar.stderr?.setEncoding("utf8");
    this.sidecar.stderr?.on("data", (chunk: string) => {
      this.stderrBytes += chunk.length; // diagnostic only; would be redacted (D14)
    });

    return ready;
  }

  /** Parse the sidecar's ONE bootstrap stdout line for its bound port. */
  private awaitBootstrapPort(timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const failSafe = setTimeout(
        () => reject(new Error("sidecar never reported its port")),
        timeoutMs,
      );
      const onData = (chunk: string): void => {
        this.stdoutBuffer += chunk;
        const idx = this.stdoutBuffer.indexOf("\n");
        if (idx === -1) return;
        const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        const msg = parseJsonLine(line) as { type?: string; port?: number };
        if (msg && msg.type === "sidecar_listening" && typeof msg.port === "number") {
          this.sidecar?.stdout?.off("data", onData);
          clearTimeout(failSafe);
          resolve(msg.port);
        }
      };
      this.sidecar?.stdout?.setEncoding("utf8");
      this.sidecar?.stdout?.on("data", onData);
      this.sidecar?.on("error", (err) => {
        clearTimeout(failSafe);
        reject(err);
      });
    });
  }

  /** Open the chunked /events stream and consume it until hangup. */
  private async openEventStream(): Promise<void> {
    const gen = this.generation;
    if (!this.eventsUrl) throw new Error("no events url");
    this.abort = new AbortController();
    this.paused = false;
    try {
      const res = await fetch(this.eventsUrl, { signal: this.abort.signal });
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        // When paused (slow consumer), stop reading: TCP backpressure.
        if (this.paused) {
          await new Promise<void>((r) => setTimeout(r, 5));
          continue;
        }
        const { done, value } = await reader.read();
        if (done) break;
        this.parser.push(decoder.decode(value, { stream: true }), (l) => this.onLine(l));
      }
      // Server closed the stream without process death (unexpected).
      const partial = this.parser.end();
      if (partial !== null) this.handleDroppedPartial();
      if (gen === this.generation && !this.metrics.exit) {
        this.handleDeath({ code: null, signal: null, detectedAtMs: nowMs() });
      }
    } catch (err) {
      if (gen === this.generation && !this.metrics.exit) {
        this.handleDeath({
          code: null,
          signal: null,
          detectedAtMs: nowMs(),
        });
        if (this.metrics.exit) this.metrics.exit.signal = `hangup:${String(err).slice(0, 60)}`;
      }
    }
  }

  private onLine(line: string): void {
    const event = parseJsonLine(line);
    if (event !== null && typeof event === "object" && "type" in event && event.type === "ready") {
      if (event.proto_version !== PROTOCOL_VERSION) {
        throw new Error(`protocol version mismatch: ${String(event.proto_version)}`);
      }
      this.readyResolver?.();
      this.readyResolver = null;
      this.metrics.lastEventAtMs = nowMs();
      this.startWatchdog();
      return;
    }
    this.handleEvent(event as Parameters<this["handleEvent"]>[0]);
  }

  /** POST one prompt to the sidecar's control channel. */
  private async postPrompt(cmd: PiCommand): Promise<void> {
    if (!this.eventsUrl) throw new Error("not started");
    const url = this.eventsUrl.replace("/events", "/prompt");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cmd),
      });
      if (res.status !== 202) throw new Error(`prompt rejected: ${res.status}`);
    } catch (err) {
      // Control-channel failure is a protocol failure, not a silent drop.
      this.metrics.protocolViolations += 1;
      console.error(`[variant-b] prompt POST failed: ${String(err).slice(0, 120)}`);
    }
  }

  /** Send one prompt; resolves when the stream completes, rejects on death. */
  prompt(text: string, fromSeq: number): Promise<void> {
    return this.dispatchPrompt(text, fromSeq);
  }

  /** Crash injection: SIGKILL the sidecar process (mid-stream in loss scenario). */
  kill(signal: NodeJS.Signals): void {
    this.markKillRequested();
    this.sidecar?.kill(signal);
  }

  /** Restart after death: new sidecar process, same session (D32 pattern). */
  async restart(): Promise<void> {
    this.resetRunState();
    await this.start();
  }

  /** Clean shutdown. */
  async stop(): Promise<void> {
    this.stopWatchdog();
    this.abort?.abort();
    if (this.sidecar && this.sidecar.exitCode === null) {
      this.sidecar.kill("SIGTERM");
      await new Promise<void>((r) => setTimeout(r, 100));
      if (this.sidecar.exitCode === null) this.sidecar.kill("SIGKILL");
    }
  }
}
