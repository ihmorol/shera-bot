/**
 * S03 spike — supervision core shared by BOTH variants. Owns everything that is
 * transport-independent in the D13 supervision seam: heartbeat watchdog (hung
 * detection), bounded token queue with source pause/resume (backpressure),
 * event dispatch, prompt correlation, metrics. The variant files implement only
 * their transport (spawn/parse/write for stdio; sidecar bootstrap + HTTP for B),
 * so per-variant caller code size is honestly comparable.
 */
import { nowMs, randomId, type PiCommand, type PiEvent } from "./contract.ts";

export type SupervisedToken = { seq: number; text: string; recvAtMs: number };

export type ExitInfo = {
  code: number | null;
  signal: string | null;
  detectedAtMs: number;
  /** ms between kill() being requested and death being observed (crash detection). */
  detectLatencyMs: number | null;
};

export type SupervisionMetrics = {
  readyAtMs: number | null;
  lastEventAtMs: number | null;
  hungDetectedAtMs: number | null;
  exit: ExitInfo | null;
  queuePeak: number;
  pauseCount: number;
  resumeCount: number;
  droppedPartialLines: number;
  protocolViolations: number;
};

export type SupervisionCallbacks = {
  onToken: (token: SupervisedToken) => void | Promise<void>;
  onExit: (info: ExitInfo) => void;
  onHung: () => void;
  onCompleted: (lastSeq: number) => void;
};

export type CoreOptions = {
  sessionId: string;
  /** Watchdog: hung if no protocol event for this long (heartbeats feed it). */
  watchdogTimeoutMs: number;
  /** Bounded queue: pause the source when this many tokens await the consumer. */
  maxQueue: number;
  /** Per-token consumer cost (simulates a slow downstream, e.g. WebSocket). */
  consumerDelayMs: number;
};

/** Transport hooks each variant implements. */
export type TransportHooks = {
  send: (cmd: PiCommand) => void;
  setPaused: (paused: boolean) => void;
};

export class PiSupervisorCore {
  protected opts: CoreOptions;
  protected callbacks: SupervisionCallbacks;
  protected hooks: TransportHooks;

  protected queue: SupervisedToken[] = [];
  protected draining = false;
  protected paused = false;
  protected watchdog: NodeJS.Timeout | null = null;
  protected killRequestedAtMs: number | null = null;
  protected dead = false;
  protected hungFired = false;
  /** Set when "completed" arrived while tokens were still queued for the consumer. */
  protected pendingCompleteLastSeq: number | null = null;
  protected promptDone: { resolve: () => void; reject: (e: Error) => void } | null = null;

  metrics: SupervisionMetrics = {
    readyAtMs: null,
    lastEventAtMs: null,
    hungDetectedAtMs: null,
    exit: null,
    queuePeak: 0,
    pauseCount: 0,
    resumeCount: 0,
    droppedPartialLines: 0,
    protocolViolations: 0,
  };

  constructor(opts: CoreOptions, callbacks: SupervisionCallbacks, hooks: TransportHooks) {
    this.opts = opts;
    this.callbacks = callbacks;
    this.hooks = hooks;
  }

  /** Feed one protocol event from the transport into the supervision core. */
  handleEvent(event: PiEvent | { type: "protocol_violation" }): void {
    if (!event || typeof event !== "object" || !("type" in event)) return;
    if (event.type === "protocol_violation") {
      this.metrics.protocolViolations += 1;
      return;
    }
    this.metrics.lastEventAtMs = nowMs();
    switch (event.type) {
      case "token": {
        if (this.queue.length + 1 > this.opts.maxQueue) {
          // Bounded queue overflow: apply backpressure at the source.
          this.paused = true;
          this.metrics.pauseCount += 1;
          this.hooks.setPaused(true);
        }
        this.queue.push({ seq: event.seq, text: event.text, recvAtMs: nowMs() });
        this.metrics.queuePeak = Math.max(this.metrics.queuePeak, this.queue.length);
        void this.drain();
        return;
      }
      case "completed": {
        this.callbacks.onCompleted(event.last_seq);
        if (this.queue.length === 0 && !this.draining) {
          const pending = this.promptDone;
          this.promptDone = null;
          pending?.resolve();
        } else {
          // End-to-end semantics: prompt() resolves only after every token has
          // been delivered to the consumer (stop() must not discard the queue).
          this.pendingCompleteLastSeq = event.last_seq;
        }
        return;
      }
      case "fatal": {
        const pending = this.promptDone;
        this.promptDone = null;
        pending?.reject(new Error(`pi fatal: ${event.error}`));
        return;
      }
      case "heartbeat":
      case "ready": {
        return; // readiness is awaited by the transport; heartbeats feed lastEventAtMs
      }
    }
  }

  /** Transport reported a partial (unterminated) line at stream end. */
  handleDroppedPartial(): void {
    this.metrics.droppedPartialLines += 1;
  }

  /** Transport observed process death (exit event or stream hangup). */
  handleDeath(info: Omit<ExitInfo, "detectLatencyMs">): void {
    if (this.dead) return; // crash detection is recorded once (exit vs hangup race)
    this.dead = true;
    this.stopWatchdog();
    const detectedAtMs = info.detectedAtMs;
    const exit: ExitInfo = {
      ...info,
      detectLatencyMs:
        this.killRequestedAtMs === null ? null : detectedAtMs - this.killRequestedAtMs,
    };
    this.metrics.exit = exit;
    const pending = this.promptDone;
    this.promptDone = null;
    pending?.reject(new Error(`pi died mid-prompt (code=${info.code} signal=${info.signal})`));
    this.callbacks.onExit(exit);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const token = this.queue.shift();
      if (!token) break;
      if (this.opts.consumerDelayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, this.opts.consumerDelayMs));
      }
      await this.callbacks.onToken(token);
      if (this.paused && this.queue.length <= Math.floor(this.opts.maxQueue / 2)) {
        this.paused = false;
        this.metrics.resumeCount += 1;
        this.hooks.setPaused(false);
      }
    }
    this.draining = false;
    if (this.pendingCompleteLastSeq !== null && this.queue.length === 0) {
      this.pendingCompleteLastSeq = null;
      const pending = this.promptDone;
      this.promptDone = null;
      pending?.resolve();
    }
  }

  startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.dead || this.hungFired) return;
      const last = this.metrics.lastEventAtMs;
      if (last !== null && nowMs() - last > this.opts.watchdogTimeoutMs) {
        this.hungFired = true;
        this.metrics.hungDetectedAtMs = nowMs();
        this.callbacks.onHung();
      }
    }, 50);
  }

  stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  markKillRequested(): void {
    this.killRequestedAtMs = nowMs();
  }

  /** Build and dispatch one prompt through the transport. */
  protected dispatchPrompt(text: string, fromSeq: number): Promise<void> {
    const cmd: PiCommand = {
      type: "prompt",
      id: randomId("cmd"),
      session_id: this.opts.sessionId,
      text,
      from_seq: fromSeq,
    };
    const done = new Promise<void>((resolve, reject) => {
      this.promptDone = { resolve, reject };
    });
    this.hooks.send(cmd);
    return done;
  }

  resetRunState(): void {
    this.metrics.readyAtMs = null;
    this.metrics.lastEventAtMs = null;
    this.metrics.hungDetectedAtMs = null;
    this.metrics.exit = null;
    this.dead = false;
    this.hungFired = false;
    this.killRequestedAtMs = null;
    this.pendingCompleteLastSeq = null;
  }
}
