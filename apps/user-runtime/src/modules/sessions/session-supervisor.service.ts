/**
 * SessionSupervisor (S12 chunk 2) — the supervised warm Agent session
 * (D32 layer 2).
 *
 * One session per (workspace_id, agent_id). NOTHING spawns at construction
 * or boot: the child process starts on the FIRST address (ensureStarted or
 * prompt), is warm-reused while starting/active, hibernates after the idle
 * timeout (graceful shutdown frame → exit → `hibernating`), and restarts
 * transparently on the next address. The supervisor owns NO durable data:
 * the compact session context is re-fetched from the injected
 * contextProvider on EVERY (re)start (D15), so a fresh child process plus
 * the provider is a full reconstruction.
 *
 * Health policy (D14): the heartbeat window is N missed heartbeat intervals
 * — a slow-but-healthy child (reply slower than one interval, heartbeats
 * still arriving) is NEVER killed; a hung child (no frames within the
 * window) is killed and supervised-restarted with a recorded event. Crash
 * restarts are bounded by the consecutive-restart policy (terminal `failed`
 * past the limit within the window). Protocol violations are never silently
 * dropped: every ProtocolVersionError/ProtocolViolationError is recorded as
 * a session.protocol_failure event; past the configured cap the child is
 * killed and restarted ONCE, and any further violation is terminal `failed`.
 *
 * Child processes are reached ONLY through the injected spawnChild seam
 * (boundary guard: process spawning stays in adapters/process) and terminated
 * through the chunk-1 escalation: shutdown frame → SIGTERM after
 * shutdownGraceMs → SIGKILL after killGraceMs more. Child stderr is
 * forwarded to the injected bounded sink (the sink owns redaction — G3:
 * stderr is diagnostic, never protocol, never journaled raw).
 *
 * Events are recorded through the SAME journal seam as every other module
 * (the injected EventsService — no second journal) on
 * `session:<workspace_id>:<agent_id>` streams.
 *
 * Governing records: D14, D15, D32, E17.
 */
import { randomUUID } from "node:crypto";

import {
  PROTOCOL_VERSION,
  ProtocolVersionError,
  ProtocolViolationError,
  PiProtocolError,
  isPiChildFrame,
  parseFrame,
  type PiFrame,
  type PiParentFrame,
} from "@shera-bot/pi-protocol";

import type { EventsService } from "../events/events.service.ts";
import { sessionStreamFor } from "./sessions.events.ts";

/** Presence of the (workspace, agent) session as the UI reads it (chunk 4). */
export type AgentSessionPresence =
  "none" | "starting" | "active" | "hibernating" | "restarting" | "failed";

/** The compact context a session needs to reconstruct itself (D15, for now). */
export interface AgentSessionContext {
  workspace_id: string;
  agent_id: string;
  display_name: string;
  /** The user-owned instructions layer above the pack role. */
  instructions: string | null;
  /** The pinned pack's role profile for this Agent. */
  pack_profile: string | null;
}

/** Everything the spawn seam needs to launch one child incarnation. */
export interface SessionSpawnRequest {
  workspace_id: string;
  agent_id: string;
  /** Fresh per-incarnation session id (durable identity is workspace+agent). */
  session_id: string;
  /** The heartbeat cadence the child should keep (the watchdog's unit). */
  heartbeat_interval_ms: number;
  context: AgentSessionContext;
}

export interface SessionChildExit {
  code: number | null;
  signal: string | null;
}

/**
 * One child-process incarnation as the supervisor sees it: RAW stdout lines
 * only. The supervisor owns protocol classification and version policy (the
 * host side of the D14 negotiation) — chunk-1's parseFrame classifies every
 * line into frames or typed PiProtocolError. A spawnFakePi handle satisfies
 * this through a thin wrapper.
 */
export interface SessionChild {
  onLine(listener: (line: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  send(frame: PiParentFrame): void;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<SessionChildExit>;
}

/**
 * The bounded, redacted stderr sink (G3). The supervisor bounds forwarding
 * per incarnation (stderrMaxBytes); the SINK owns redaction — compose.ts
 * wires the runtime's redacted logger family here in chunk 3.
 */
export interface SessionStderrSink {
  write(chunk: string): void;
}

/**
 * The redacted operator-fault sink (same conduit shape as the transport's
 * RedactedLogger; structurally identical so compose wires it directly).
 * Call sites pass an explicit field allowlist — never secrets (G3).
 */
export type SessionFaultLog = (event: string, fields: Record<string, unknown>) => void;

export interface SessionSupervisorPolicy {
  /** Idle time before a graceful hibernation (D32: warm while used). */
  idleHibernateMs: number;
  /** The child heartbeat cadence the watchdog expects. */
  heartbeatIntervalMs: number;
  /** Missed intervals that mean "hung" (window = interval × limit). */
  missedHeartbeatLimit: number;
  /** Backstop for a child that never completes hello/ready. */
  handshakeTimeoutMs: number;
  /** Supervised crash-restarts allowed per restart window. */
  maxConsecutiveRestarts: number;
  restartWindowMs: number;
  /** Protocol violations allowed on one incarnation before the cap action. */
  maxProtocolViolations: number;
  /** Escalation: shutdown frame → SIGTERM after this grace. */
  shutdownGraceMs: number;
  /** Escalation: SIGTERM → SIGKILL after this further grace. */
  killGraceMs: number;
  /** Per-incarnation bound on stderr bytes forwarded to the sink (G3). */
  stderrMaxBytes: number;
}

export const DEFAULT_SESSION_POLICY: SessionSupervisorPolicy = {
  // D32: warm while actively used; hibernate after two idle minutes.
  idleHibernateMs: 120_000,
  heartbeatIntervalMs: 5_000,
  // Window: 3 missed intervals = 15s of silence ⇒ hung. A slow-but-healthy
  // child keeps beating and is never killed by this.
  missedHeartbeatLimit: 3,
  handshakeTimeoutMs: 10_000,
  // D32 policy: up to 3 supervised crash-restarts per minute; the crash
  // beyond that is terminal `failed` (crash-looping is not "recovered").
  maxConsecutiveRestarts: 3,
  restartWindowMs: 60_000,
  // D14: repeated protocol violations exhaust ONE post-cap restart, then the
  // session is terminal `failed`.
  maxProtocolViolations: 3,
  // Chunk-1 escalation cadence: shutdown frame → SIGTERM at 2s → SIGKILL at 3s.
  shutdownGraceMs: 2_000,
  killGraceMs: 1_000,
  stderrMaxBytes: 8_192,
};

export interface SessionSupervisorDeps {
  /** The ONLY journal seam (no second journal): session events append here. */
  events: EventsService;
  /** The process seam (process spawning stays in adapters/process). */
  spawnChild: (request: SessionSpawnRequest) => SessionChild | Promise<SessionChild>;
  /**
   * The D15 context source — re-fetched on EVERY (re)start. compose.ts wires
   * the agents module's public reads (agent profile/instructions + pack
   * profile); the supervisor never caches the result.
   */
  contextProvider: (
    workspaceId: string,
    agentId: string,
  ) => AgentSessionContext | Promise<AgentSessionContext>;
  /** Bounded, redacted child-stderr sink (G3). Default: discard. */
  stderrSink?: SessionStderrSink | undefined;
  /** Contained operator-fault sink (B-1). Default: discard. */
  logFault?: SessionFaultLog | undefined;
  policy?: Partial<SessionSupervisorPolicy> | undefined;
  /** Injectable clock (ms) for tests; default Date.now. */
  now?: (() => number) | undefined;
}

export interface AgentSessionSnapshot {
  workspace_id: string;
  agent_id: string;
  session_id: string;
  pid: number;
  presence: "active";
}

export interface AgentSessionReply {
  prompt_id: string;
  text: string;
  last_seq: number;
}

/** Terminal session: the policy limit was exhausted; no further restarts. */
export class AgentSessionFailedError extends Error {
  readonly code = "AGENT_SESSION_FAILED" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, agentId: string) {
    super(`agent session for ${agentId} in workspace ${workspaceId} is terminal failed`);
    this.name = "AgentSessionFailedError";
  }
}

/** An in-flight reply died with the child; the session itself is recovering. */
export class AgentSessionInterruptedError extends Error {
  readonly code = "AGENT_SESSION_INTERRUPTED" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, agentId: string) {
    super(
      `agent session reply for ${agentId} in workspace ${workspaceId}` +
        " was interrupted by a session failure; retry on the restarted session",
    );
    this.name = "AgentSessionInterruptedError";
  }
}

interface PromptWaiter {
  id: string;
  tokens: string[];
  lastSeq: number;
  resolve: (reply: AgentSessionReply) => void;
  reject: (error: Error) => void;
}

/**
 * One child incarnation. All health counters are per-incarnation; the
 * record (below) carries the cross-incarnation policy state.
 */
interface Incarnation {
  session_id: string;
  child: SessionChild;
  pid: number | null;
  spawnedAt: number;
  lastFrameAt: number;
  /** True once hello/ready completed — the watchdog's tight window applies. */
  ready: boolean;
  sawAnyFrame: boolean;
  protocolViolations: number;
  /** Set SYNCHRONOUSLY by whichever path initiates termination first. */
  terminating: boolean;
  fatalFrameSeen: boolean;
  prompts: Map<string, PromptWaiter>;
  unsubscribers: Array<() => void>;
  escalationTimers: Array<NodeJS.Timeout>;
  stderrBytes: number;
  /**
   * The handshake outcome: null once ready fired, or the start failure
   * (exit before ready, handshake timeout, pre-ready protocol violation).
   * Settling twice is a harmless no-op.
   */
  handshake: Promise<StartFailure | null>;
  settleHandshake: (outcome: StartFailure | null) => void;
}

type StartFailure =
  { kind: "exit"; exit: SessionChildExit } | { kind: "handshake_timeout" } | { kind: "protocol" };

interface SessionRecord {
  workspace_id: string;
  agent_id: string;
  presence: AgentSessionPresence;
  current: Incarnation | null;
  /** Session id of the most recently detached incarnation (resume events). */
  lastSessionId: string | null;
  /** Coalesces concurrent addresses onto one start attempt. */
  startPromise: Promise<void> | null;
  lastActivityAt: number;
  /** Timestamps of supervised crash-restarts inside the restart window. */
  restartTimestamps: number[];
  /** The one post-cap protocol restart has been spent. */
  protocolRestartUsed: boolean;
}

export class SessionSupervisor {
  private readonly policy: SessionSupervisorPolicy;
  private readonly records = new Map<string, SessionRecord>();
  private readonly tickTimer: NodeJS.Timeout;

  constructor(private readonly deps: SessionSupervisorDeps) {
    this.policy = { ...DEFAULT_SESSION_POLICY, ...deps.policy };
    // One global tick drives hang detection and idle hibernation for every
    // record; the interval derives from the two policy scales it enforces.
    const tickMs = Math.min(
      1_000,
      Math.max(5, Math.min(this.policy.idleHibernateMs, this.policy.heartbeatIntervalMs) / 4),
    );
    this.tickTimer = setInterval(() => this.tick(), tickMs);
    // An unref'd tick never keeps a process (or a test run) alive by itself;
    // stopAll() clears it for real.
    this.tickTimer.unref();
  }

  // ── Public surface (chunk 3 wires compose + conversation send + presence) ──

  /** Presence of one (workspace, agent) session — the chunk-4 UI read model. */
  presenceState(workspaceId: string, agentId: string): AgentSessionPresence {
    return this.records.get(recordKey(workspaceId, agentId))?.presence ?? "none";
  }

  /**
   * D32 layer 2: start the session on demand (FIRST address only — nothing
   * runs before this), reusing a starting/active session warm. A
   * hibernating/restarting session restarts transparently. Terminal failed
   * sessions reject typed; they never spawn again.
   */
  async ensureStarted(workspaceId: string, agentId: string): Promise<AgentSessionSnapshot> {
    for (;;) {
      const record = this.recordFor(workspaceId, agentId);
      if (record.presence === "failed") {
        throw new AgentSessionFailedError(workspaceId, agentId);
      }
      if (record.presence === "active" && record.current !== null) {
        return this.snapshotOf(record);
      }
      if (record.startPromise !== null) {
        // Warm reuse + concurrent-start coalescing: ride the in-flight start.
        // A rejection is re-examined on the next pass (e.g. a context error
        // leaves presence `none` and this caller retries its own address).
        await record.startPromise.catch(() => {});
        continue;
      }
      if (record.presence === "hibernating") {
        // Transparent resume after an idle hibernation (D32): the fresh
        // incarnation replaces the hibernated one and the journal records
        // the continuation so replay sees an unbroken session history.
        const previousSessionId = record.lastSessionId;
        const resumed = this.startAttempt(record, "address");
        record.startPromise = resumed;
        try {
          await resumed;
        } finally {
          if (record.startPromise === resumed) record.startPromise = null;
        }
        const presenceAfterResume = this.presenceState(record.workspace_id, record.agent_id);
        if (presenceAfterResume !== "failed") {
          this.recordEvent(record, "session.restarted", {
            session_id: record.current?.session_id ?? `sess-${randomUUID()}`,
            workspace_id: record.workspace_id,
            agent_id: record.agent_id,
            reason: "idle_resume",
            previous_session_id: previousSessionId,
          });
        }
        continue;
      }
      const started = this.startAttempt(record, "address");
      record.startPromise = started;
      try {
        await started;
      } finally {
        if (record.startPromise === started) record.startPromise = null;
      }
      // Loop once more: the success path snapshots the fresh incarnation,
      // and a child that died between ready and here re-addresses honestly.
    }
  }

  /**
   * Send one prompt through the session. Addresses the session first (so a
   * hibernating session transparently restarts and the conversation
   * continues); activity (send, tokens, completion) resets the idle timer.
   * A reply interrupted by a crash/hang rejects typed; the supervised
   * restart continues the session and the caller may retry.
   */
  async prompt(workspaceId: string, agentId: string, text: string): Promise<AgentSessionReply> {
    await this.ensureStarted(workspaceId, agentId);
    const record = this.records.get(recordKey(workspaceId, agentId))!;
    const incarnation = record.current;
    if (incarnation === null || !incarnation.ready) {
      // The session failed or dropped between the start and this send.
      throw new AgentSessionInterruptedError(workspaceId, agentId);
    }
    const promptId = `prompt-${randomUUID()}`;
    return new Promise<AgentSessionReply>((resolve, reject) => {
      incarnation.prompts.set(promptId, {
        id: promptId,
        tokens: [],
        lastSeq: 0,
        resolve,
        reject,
      });
      this.markActivity(record);
      incarnation.child.send({
        v: PROTOCOL_VERSION,
        type: "prompt",
        id: promptId,
        session_id: incarnation.session_id,
        text,
        from_seq: 0,
      });
    });
  }

  /**
   * Graceful stop of one session through the chunk-1 escalation; presence
   * returns to `none`. No-op when nothing is running (idempotent).
   */
  async stop(workspaceId: string, agentId: string): Promise<void> {
    const record = this.records.get(recordKey(workspaceId, agentId));
    if (record === undefined) return;
    if (record.startPromise !== null) {
      await record.startPromise.catch(() => {});
    }
    const incarnation = record.current;
    if (incarnation === null) return;
    await this.terminateAndAwaitExit(record, incarnation);
    record.presence = "none";
  }

  /** Stop every live session (composition shutdown); resolves when all exited. */
  async stopAll(): Promise<void> {
    clearInterval(this.tickTimer);
    const stops: Array<Promise<void>> = [];
    for (const record of this.records.values()) {
      stops.push(this.stop(record.workspace_id, record.agent_id));
    }
    await Promise.all(stops);
  }

  // ── Start pipeline ────────────────────────────────────────────────────────

  /**
   * One start attempt (foreground address or supervised restart): fetch the
   * context (D15 — every start re-fetches), spawn, wait for the handshake.
   * Handshake-breaking failures (version error, early exit, silence before
   * ready) go through the CONSECUTIVE-RESTART policy; the loop retries while
   * policy allows. Never throws for supervised origins.
   */
  private async startAttempt(
    record: SessionRecord,
    origin: "address" | "supervised",
  ): Promise<void> {
    for (;;) {
      // The measured start latency covers THIS attempt end to end: context
      // fetch (D15), spawn, and handshake — the honest "how long until this
      // Agent could answer" number, journaled on activation (AC).
      const attemptStartedAt = this.now();
      record.presence = origin === "address" ? "starting" : "restarting";
      let context: AgentSessionContext;
      try {
        context = await this.deps.contextProvider(record.workspace_id, record.agent_id);
      } catch (error) {
        record.presence = "none";
        if (origin === "address") throw error;
        // A supervised restart has no caller: the fault is recorded and the
        // session is terminal — nothing can reconstruct without context.
        record.presence = "failed";
        this.faultLog("agent_session_context_failed", {
          workspace_id: record.workspace_id,
          agent_id: record.agent_id,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const incarnation = await this.spawnIncarnation(record, context);
      if (incarnation === null) {
        // Spawn itself failed — the same policy as a child crash.
        if (!this.registerCrashRestart(record)) {
          this.markTerminal(record, "restart_limit", null);
          if (origin === "address")
            throw new AgentSessionFailedError(record.workspace_id, record.agent_id);
          return;
        }
        continue;
      }

      const failure = await this.awaitHandshake(record, incarnation);
      if (failure === null) {
        // A violating line can arrive in the SAME stdout burst as ready and
        // drive the session terminal (cap policy) before this continuation
        // runs — never resurrect a failed/detached session to `active`.
        // (presence is re-read un-narrowed: policy paths mutate it mid-await.)
        const presenceNow = this.presenceState(record.workspace_id, record.agent_id);
        if (record.current === incarnation && presenceNow !== "failed") {
          record.presence = "active";
          this.markActivity(record);
          // The incarnation is live: journal the measured on-demand start
          // (AC — start latency measured and recorded) before anything else
          // can detach it. Paired with the restart/hibernate events so the
          // session stream reads as a complete lifecycle history.
          this.recordEvent(record, "session.started", {
            session_id: incarnation.session_id,
            workspace_id: record.workspace_id,
            agent_id: record.agent_id,
            start_latency_ms: Math.max(0, Math.round(this.now() - attemptStartedAt)),
          });
        }
        return;
      }

      await this.teardownIncarnation(record, incarnation);
      // NOTE: pre-ready protocol failures never drive the session terminal
      // (the cap applies to violations on a LIVE child), so the restart
      // policy below is the only handler for every start failure kind.
      if (!this.registerCrashRestart(record)) {
        this.markTerminal(record, "restart_limit", incarnation.session_id);
        if (origin === "address")
          throw new AgentSessionFailedError(record.workspace_id, record.agent_id);
        return;
      }
      // Loop: another supervised incarnation (presence stays `restarting`).
    }
  }

  private async spawnIncarnation(
    record: SessionRecord,
    context: AgentSessionContext,
  ): Promise<Incarnation | null> {
    const sessionId = `sess-${randomUUID()}`;
    let child: SessionChild;
    try {
      child = await this.deps.spawnChild({
        workspace_id: record.workspace_id,
        agent_id: record.agent_id,
        session_id: sessionId,
        heartbeat_interval_ms: this.policy.heartbeatIntervalMs,
        context,
      });
    } catch (error) {
      this.faultLog("agent_session_spawn_failed", {
        workspace_id: record.workspace_id,
        agent_id: record.agent_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const now = this.now();
    let settleHandshake!: (outcome: StartFailure | null) => void;
    const handshake = new Promise<StartFailure | null>((resolve) => {
      settleHandshake = resolve;
    });
    const incarnation: Incarnation = {
      session_id: sessionId,
      child,
      pid: null,
      spawnedAt: now,
      lastFrameAt: now,
      ready: false,
      sawAnyFrame: false,
      protocolViolations: 0,
      terminating: false,
      fatalFrameSeen: false,
      prompts: new Map(),
      unsubscribers: [],
      escalationTimers: [],
      stderrBytes: 0,
      handshake,
      settleHandshake,
    };

    incarnation.unsubscribers.push(
      child.onLine((line) => this.handleLine(record, incarnation, line)),
    );
    incarnation.unsubscribers.push(
      child.onStderr((chunk) => this.handleStderr(incarnation, chunk)),
    );
    // Exit observer: deliberate terminations handle their own aftermath; an
    // exit nobody initiated is a crash (D14: death is detected independently
    // of any final event).
    void child.waitForExit().then((exit) => {
      this.onChildExit(record, incarnation, exit);
    });
    record.current = incarnation;
    return incarnation;
  }

  /**
   * Wait for hello → ready. Resolves null on success, or the typed start
   * failure. The deadline is the handshake backstop (a child that never
   * completes hello/ready); the watchdog applies the same threshold before
   * ready, so a slow boot is never killed by the tighter heartbeat window.
   */
  private awaitHandshake(
    record: SessionRecord,
    incarnation: Incarnation,
  ): Promise<StartFailure | null> {
    void record;
    return new Promise<StartFailure | null>((resolve) => {
      const remaining = Math.max(
        0,
        this.policy.handshakeTimeoutMs - (this.now() - incarnation.spawnedAt),
      );
      const deadline = setTimeout(() => {
        incarnation.settleHandshake({ kind: "handshake_timeout" });
      }, remaining);
      deadline.unref();
      void incarnation.handshake.then((outcome) => {
        clearTimeout(deadline);
        resolve(outcome);
      });
    });
  }

  // ── Protocol handling (the host side of the D14 negotiation) ─────────────

  private handleLine(record: SessionRecord, incarnation: Incarnation, line: string): void {
    // ANY line from the child is liveness — even a violating one.
    incarnation.lastFrameAt = this.now();
    incarnation.sawAnyFrame = true;

    let frame: PiFrame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      this.onProtocolError(record, incarnation, error as PiProtocolError);
      return;
    }
    if (!isPiChildFrame(frame)) {
      // A parent frame (prompt/shutdown) from the child is a violation —
      // the child never speaks parent frames (chunk-1 harness rule).
      this.onProtocolError(
        record,
        incarnation,
        new ProtocolViolationError({
          reason: "unknown_frame_type",
          detail: `unexpected parent frame from child: ${frame.type}`,
        }),
      );
      return;
    }

    if (!incarnation.ready) {
      // Strict handshake order (the supervisor layer's policy, per the
      // chunk-1 note: validateFrame itself never cross-checks negotiation).
      if (frame.type === "hello") {
        if (frame.protocol_version !== PROTOCOL_VERSION) {
          this.onProtocolError(
            record,
            incarnation,
            new ProtocolVersionError({
              expected: PROTOCOL_VERSION,
              received: frame.protocol_version,
            }),
          );
          return;
        }
        incarnation.pid = frame.pid;
        return;
      }
      if (frame.type === "ready") {
        if (incarnation.pid === null) {
          // Ready before hello: the child skipped the version announcement.
          this.onProtocolError(
            record,
            incarnation,
            new ProtocolVersionError({ expected: PROTOCOL_VERSION, received: 0 }),
          );
          return;
        }
        if (frame.proto_version !== PROTOCOL_VERSION) {
          this.onProtocolError(
            record,
            incarnation,
            new ProtocolVersionError({
              expected: PROTOCOL_VERSION,
              received: frame.proto_version,
            }),
          );
          return;
        }
        incarnation.ready = true;
        // Signal start success: the handshake wait resolves with null.
        incarnation.settleHandshake(null);
        return;
      }
      // Any other frame before ready is a handshake violation.
      this.onProtocolError(
        record,
        incarnation,
        new ProtocolVersionError({ expected: PROTOCOL_VERSION, received: 0 }),
      );
      return;
    }

    switch (frame.type) {
      case "heartbeat":
        // Liveness only (lastFrameAt above); heartbeats are NOT activity and
        // never reset the idle hibernation timer (D32).
        return;
      case "token": {
        this.markActivity(record);
        const waiter = incarnation.prompts.get(frame.id);
        if (waiter) {
          waiter.tokens.push(frame.text);
          waiter.lastSeq = frame.seq;
        }
        return;
      }
      case "completed": {
        this.markActivity(record);
        // A completed reply proves the child healthy: the consecutive
        // crash-restart window resets (only CONSECUTIVE crashes count).
        record.restartTimestamps = [];
        const waiter = incarnation.prompts.get(frame.id);
        if (waiter) {
          incarnation.prompts.delete(frame.id);
          waiter.resolve({
            prompt_id: frame.id,
            text: waiter.tokens.join(""),
            last_seq: frame.last_seq,
          });
        }
        return;
      }
      case "error": {
        // In-band reply failure: the child stays alive; only the reply fails.
        // The frame carries no prompt correlation id (it reuses the fatal
        // field shape), so every in-flight reply on this incarnation rejects.
        this.rejectPrompts(
          incarnation,
          new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
        );
        return;
      }
      case "fatal":
        this.handleFatalFrame(record, incarnation);
        return;
      case "hello":
      case "ready":
        // Duplicate handshakes from a live child: tolerated liveness.
        return;
    }
  }

  /**
   * A typed protocol error from the child (D14: invalid messages are
   * rejected and recorded as protocol failures — never silently dropped).
   * Every violation is journaled; the cap policy applies to violations that
   * arrive while the child is LIVE (post-ready). Handshake-breaking
   * failures fall through to the start pipeline's restart policy.
   */
  private onProtocolError(
    record: SessionRecord,
    incarnation: Incarnation,
    error: PiProtocolError,
  ): void {
    this.recordEvent(record, "session.protocol_failure", {
      session_id: incarnation.session_id,
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      code: error.code,
      reason: error.reason ?? null,
      detail: boundedDetail(error),
    });

    if (incarnation.ready) {
      if (record.protocolRestartUsed) {
        // The one post-cap restart was already spent — terminal.
        this.rejectPrompts(
          incarnation,
          new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
        );
        this.markTerminal(record, "protocol_violation_limit", incarnation.session_id);
        void this.killTerminal(record, incarnation);
        return;
      }
      incarnation.protocolViolations += 1;
      if (incarnation.protocolViolations >= this.policy.maxProtocolViolations) {
        // Cap reached: kill + restart ONCE (D14 policy). Any violation on
        // the fresh incarnation is terminal (protocolRestartUsed above).
        record.protocolRestartUsed = true;
        void this.restartAfterProtocolCap(record, incarnation);
      }
      return;
    }

    // Pre-ready violation: the handshake can never complete on this child.
    // Resolve the handshake wait as a protocol failure; the start pipeline
    // applies the consecutive-restart policy.
    incarnation.settleHandshake({ kind: "protocol" });
  }

  /** Cap action: terminate through the escalation, then one supervised restart. */
  private async restartAfterProtocolCap(
    record: SessionRecord,
    incarnation: Incarnation,
  ): Promise<void> {
    this.rejectPrompts(
      incarnation,
      new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
    );
    await this.terminateAndAwaitExit(record, incarnation);
    this.detachCurrent(record, incarnation);
    if (record.presence === "failed") return;
    this.launchSupervisedRestart(record, "protocol_violation", incarnation.session_id);
  }

  private handleFatalFrame(record: SessionRecord, incarnation: Incarnation): void {
    if (incarnation.terminating) return;
    incarnation.terminating = true;
    incarnation.fatalFrameSeen = true;
    this.rejectPrompts(
      incarnation,
      new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
    );
    void (async () => {
      // The child announced an unrecoverable failure (D14 fatal): record it
      // as a crash and run the supervised restart policy.
      this.recordEvent(record, "session.crashed", {
        session_id: incarnation.session_id,
        workspace_id: record.workspace_id,
        agent_id: record.agent_id,
        cause: "fatal_frame",
        exit_code: null,
        signal: null,
      });
      await this.terminateAndAwaitExit(record, incarnation);
      this.detachCurrent(record, incarnation);
      this.afterCrash(record, incarnation.session_id, "unexpected_exit");
    })();
  }

  // ── Health: watchdog + idle hibernation ──────────────────────────────────

  private tick(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      const incarnation = record.current;
      if (incarnation === null) continue;

      // Hang detection (D14: heartbeats detect hung processes). Before the
      // handshake completes the threshold is the handshake backstop — a
      // slow boot is not a hang. After ready, ANY frame counts as liveness
      // and the window is interval × limit; a slow-but-healthy child keeps
      // beating and is never killed.
      const windowMs = this.policy.heartbeatIntervalMs * this.policy.missedHeartbeatLimit;
      const threshold = incarnation.ready
        ? windowMs
        : Math.max(this.policy.handshakeTimeoutMs, windowMs);
      if (now - incarnation.lastFrameAt >= threshold) {
        if (!incarnation.terminating) {
          incarnation.terminating = true;
          if (incarnation.ready) {
            void this.handleHang(record, incarnation);
          } else {
            // Pre-ready silence is a handshake timeout: the start pipeline
            // owns the aftermath (the hang path below needs a ready child).
            incarnation.settleHandshake({ kind: "handshake_timeout" });
          }
        }
        continue;
      }

      // Idle hibernation (D32): activity — send/prompt/reply — resets the
      // timer; heartbeats do not. Only ACTIVE sessions hibernate.
      if (
        record.presence === "active" &&
        now - record.lastActivityAt >= this.policy.idleHibernateMs
      ) {
        if (!incarnation.terminating) {
          incarnation.terminating = true;
          void this.handleIdleHibernate(record, incarnation);
        }
      }
    }
  }

  /** Hung child: kill, record the event, supervised restart. */
  private async handleHang(record: SessionRecord, incarnation: Incarnation): Promise<void> {
    this.rejectPrompts(
      incarnation,
      new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
    );
    incarnation.child.kill("SIGKILL");
    const exit = await incarnation.child.waitForExit();
    await this.teardownIncarnation(record, incarnation);
    this.detachCurrent(record, incarnation);
    this.recordEvent(record, "session.crashed", {
      session_id: incarnation.session_id,
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      cause: "hang",
      exit_code: exit.code,
      signal: exit.signal,
    });
    this.afterCrash(record, incarnation.session_id, "hang");
  }

  /** Idle timeout: graceful shutdown frame → escalation → `hibernating`. */
  private async handleIdleHibernate(
    record: SessionRecord,
    incarnation: Incarnation,
  ): Promise<void> {
    const idleMs = Math.max(0, this.now() - record.lastActivityAt);
    this.rejectPrompts(
      incarnation,
      new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
    );
    await this.terminateAndAwaitExit(record, incarnation);
    this.detachCurrent(record, incarnation);
    record.presence = "hibernating";
    // Durable state is untouched (the supervisor owns none) — the next
    // ensureStarted transparently restarts and the conversation continues.
    this.recordEvent(record, "session.hibernate", {
      session_id: incarnation.session_id,
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      idle_ms: Math.round(idleMs),
    });
  }

  // ── Crash handling ────────────────────────────────────────────────────────

  private onChildExit(
    record: SessionRecord,
    incarnation: Incarnation,
    exit: SessionChildExit,
  ): void {
    for (const timer of incarnation.escalationTimers) clearTimeout(timer);
    incarnation.escalationTimers = [];
    for (const unsubscribe of incarnation.unsubscribers) unsubscribe();
    incarnation.unsubscribers = [];
    this.detachCurrent(record, incarnation);
    if (incarnation.terminating) return; // the initiator owns the aftermath

    // Nobody initiated this death. Exactly one handler wins the synchronous
    // flag (D14: death is detected independently of any final event).
    incarnation.terminating = true;
    if (!incarnation.ready) {
      // Never became active: record the crash — a death before hello IS a
      // crash — and hand the policy to the waiting start pipeline.
      this.recordEvent(record, "session.crashed", {
        session_id: incarnation.session_id,
        workspace_id: record.workspace_id,
        agent_id: record.agent_id,
        cause: "unexpected_exit",
        exit_code: exit.code,
        signal: exit.signal,
      });
      incarnation.settleHandshake({ kind: "exit", exit });
      return;
    }
    this.rejectPrompts(
      incarnation,
      new AgentSessionInterruptedError(record.workspace_id, record.agent_id),
    );
    this.recordEvent(record, "session.crashed", {
      session_id: incarnation.session_id,
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      cause: incarnation.fatalFrameSeen ? "fatal_frame" : "unexpected_exit",
      exit_code: exit.code,
      signal: exit.signal,
    });
    this.afterCrash(record, incarnation.session_id, "unexpected_exit");
  }

  /**
   * Shared crash aftermath: the consecutive-restart policy — up to
   * maxConsecutiveRestarts per window (a completed reply resets the window);
   * beyond it the session is terminal `failed`. Presence moves to
   * `restarting` SYNCHRONOUSLY and the start attempt is registered on the
   * record, so a concurrent address coalesces onto the supervised restart
   * instead of spawning a second child.
   */
  private afterCrash(
    record: SessionRecord,
    previousSessionId: string,
    cause: "unexpected_exit" | "hang",
  ): void {
    if (record.presence === "failed") return;
    if (!this.registerCrashRestart(record)) {
      this.markTerminal(record, "restart_limit", previousSessionId);
      return;
    }
    this.launchSupervisedRestart(record, cause === "hang" ? "hang" : "crash", previousSessionId);
  }

  /**
   * One supervised restart: presence `restarting`, the start attempt on the
   * record (coalescing), and the session.restarted event journaled once the
   * fresh incarnation is active.
   */
  private launchSupervisedRestart(
    record: SessionRecord,
    reason: "crash" | "hang" | "protocol_violation",
    previousSessionId: string,
  ): void {
    record.presence = "restarting";
    const restarted = this.startAttempt(record, "supervised");
    record.startPromise = restarted;
    restarted.then(
      () => {
        if (record.startPromise === restarted) record.startPromise = null;
        if (record.presence === "failed") return;
        this.recordEvent(record, "session.restarted", {
          session_id: record.current?.session_id ?? `sess-${randomUUID()}`,
          workspace_id: record.workspace_id,
          agent_id: record.agent_id,
          reason,
          previous_session_id: previousSessionId,
        });
      },
      () => {
        // Supervised starts never reject; containment guard anyway.
        if (record.startPromise === restarted) record.startPromise = null;
      },
    );
  }

  /** Prune + apply the consecutive-restart window policy. False ⇒ failed. */
  private registerCrashRestart(record: SessionRecord): boolean {
    const now = this.now();
    record.restartTimestamps = record.restartTimestamps.filter(
      (at) => now - at < this.policy.restartWindowMs,
    );
    if (record.restartTimestamps.length >= this.policy.maxConsecutiveRestarts) {
      return false;
    }
    record.restartTimestamps.push(now);
    return true;
  }

  private markTerminal(
    record: SessionRecord,
    reason: "restart_limit" | "protocol_violation_limit",
    sessionId: string | null,
  ): void {
    record.presence = "failed";
    this.recordEvent(record, "session.failed", {
      session_id: sessionId ?? record.current?.session_id ?? `sess-${randomUUID()}`,
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      reason,
    });
  }

  /** Protocol-cap terminal: mark failed, then SIGKILL the violating child. */
  private async killTerminal(record: SessionRecord, incarnation: Incarnation): Promise<void> {
    await this.terminateAndAwaitExit(record, incarnation);
    this.detachCurrent(record, incarnation);
  }

  // ── Termination ───────────────────────────────────────────────────────────

  /**
   * The chunk-1 escalation: shutdown frame → SIGTERM after shutdownGraceMs →
   * SIGKILL after killGraceMs more. Resolves only once the exit is observed
   * — a stopped/hibernated session never leaves an orphan.
   */
  private async terminateAndAwaitExit(
    record: SessionRecord,
    incarnation: Incarnation,
  ): Promise<SessionChildExit> {
    incarnation.terminating = true;
    incarnation.child.send({ v: PROTOCOL_VERSION, type: "shutdown" });
    incarnation.escalationTimers.push(
      setTimeout(() => incarnation.child.kill("SIGTERM"), this.policy.shutdownGraceMs),
    );
    incarnation.escalationTimers.push(
      setTimeout(
        () => incarnation.child.kill("SIGKILL"),
        this.policy.shutdownGraceMs + this.policy.killGraceMs,
      ),
    );
    const exit = await incarnation.child.waitForExit();
    for (const timer of incarnation.escalationTimers) clearTimeout(timer);
    incarnation.escalationTimers = [];
    for (const unsubscribe of incarnation.unsubscribers) unsubscribe();
    incarnation.unsubscribers = [];
    return exit;
  }

  private async teardownIncarnation(
    record: SessionRecord,
    incarnation: Incarnation,
  ): Promise<void> {
    for (const timer of incarnation.escalationTimers) clearTimeout(timer);
    incarnation.escalationTimers = [];
    for (const unsubscribe of incarnation.unsubscribers) unsubscribe();
    incarnation.unsubscribers = [];
    this.detachCurrent(record, incarnation);
    if (!incarnation.terminating) {
      incarnation.terminating = true;
      incarnation.child.kill("SIGKILL");
      await incarnation.child.waitForExit();
    }
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private handleStderr(incarnation: Incarnation, chunk: string): void {
    // Bounded per-incarnation forwarding (G3): the sink owns redaction; the
    // supervisor guarantees a chatty child cannot flood it. Stderr is
    // diagnostic — it is NOT liveness and never journaled raw.
    if (incarnation.stderrBytes >= this.policy.stderrMaxBytes) return;
    const remaining = this.policy.stderrMaxBytes - incarnation.stderrBytes;
    const bounded = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
    incarnation.stderrBytes += bounded.length;
    this.deps.stderrSink?.write(bounded);
  }

  private rejectPrompts(incarnation: Incarnation, error: AgentSessionInterruptedError): void {
    for (const waiter of incarnation.prompts.values()) {
      waiter.reject(error);
    }
    incarnation.prompts.clear();
  }

  private markActivity(record: SessionRecord): void {
    record.lastActivityAt = this.now();
  }

  /**
   * Detach an incarnation from its record, remembering its session id so a
   * restart/resume event can reference the incarnation it replaced.
   */
  private detachCurrent(record: SessionRecord, incarnation: Incarnation): void {
    if (record.current === incarnation) {
      record.lastSessionId = incarnation.session_id;
      record.current = null;
    }
  }

  private recordFor(workspaceId: string, agentId: string): SessionRecord {
    const key = recordKey(workspaceId, agentId);
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        workspace_id: workspaceId,
        agent_id: agentId,
        presence: "none",
        current: null,
        lastSessionId: null,
        startPromise: null,
        lastActivityAt: this.now(),
        restartTimestamps: [],
        protocolRestartUsed: false,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private snapshotOf(record: SessionRecord): AgentSessionSnapshot {
    return {
      workspace_id: record.workspace_id,
      agent_id: record.agent_id,
      session_id: record.current?.session_id ?? "unknown",
      pid: record.current?.pid ?? 0,
      presence: "active",
    };
  }

  /**
   * Journal append through the SAME EventsService every other module uses.
   * A journal failure is contained (the fault is logged, supervision
   * continues) — a child crashing must never take the runtime down with it.
   */
  private recordEvent<
    T extends
      | "session.started"
      | "session.hibernate"
      | "session.crashed"
      | "session.restarted"
      | "session.protocol_failure"
      | "session.failed",
  >(record: SessionRecord, type: T, payload: Record<string, unknown>): void {
    try {
      this.deps.events.appendEvent({
        event_id: randomUUID(),
        stream_id: sessionStreamFor(record.workspace_id, record.agent_id),
        type,
        payload: payload as never,
        workspace_id: record.workspace_id,
        correlation_id: `agent-session:${record.workspace_id}:${record.agent_id}`,
      });
    } catch (error) {
      this.faultLog("agent_session_event_failed", {
        workspace_id: record.workspace_id,
        agent_id: record.agent_id,
        event_type: type,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private faultLog(event: string, fields: Record<string, unknown>): void {
    try {
      this.deps.logFault?.(event, fields);
    } catch {
      // The fault sink itself must never break supervision.
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

function recordKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}${agentId}`;
}

/** Bounded typed detail (≤ 200 chars) — never raw child output (G3). */
function boundedDetail(error: PiProtocolError): string | null {
  if (error instanceof ProtocolVersionError) {
    return `expected ${error.expected}, received ${error.received}`;
  }
  const detail = (error as { detail?: string | undefined }).detail;
  if (detail === undefined) return null;
  return detail.length <= 200 ? detail : detail.slice(0, 200);
}
