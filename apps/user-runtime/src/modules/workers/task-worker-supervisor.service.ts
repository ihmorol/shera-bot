/**
 * TaskWorkerSupervisor (S16 chunk 1) — the supervised persistent task worker
 * (D32 layer 3), the task-state sibling of the S12 SessionSupervisor.
 *
 * ONE worker process per run, started ON DEMAND by the run flow — nothing
 * spawns at construction or boot. The worker lifecycle follows the TASK
 * STATE, not a chat's idle timer: no idle hibernation, no warm reuse policy —
 * a healthy worker runs until done or stopped (AC25: browser closure and
 * session hibernation never stop it; the AC25 independence is asserted in the
 * suite by composing a SessionSupervisor and this supervisor over the same
 * journal and proving hibernation leaves the worker running). One LIVE worker
 * per run is enforced in-process by coalescing concurrent startWorker calls;
 * successive incarnations across a run's life each get their own worker_id
 * row. Chunk 3 wires run-state transitions to this lifecycle; here the run
 * boundary is the injected TaskRunOperationsSeam (interface only —
 * operations.service.ts is NOT touched by this slice).
 *
 * Health policy (D32, mirroring the D14 session discipline): the heartbeat
 * window is N missed heartbeat intervals — a slow-but-healthy worker (long
 * time-to-progress, heartbeats still arriving) is NEVER killed; a silent
 * worker (no frames within the window) is marked `stalled` on the durable row
 * and escalated (shutdown frame → SIGTERM → SIGKILL, chunk-1 escalation like
 * S12). ANY frame from the child is liveness and renews the lease — a worker
 * that streams progress but forgot heartbeats is alive and working, not
 * stalled. `lease_expires_at` on the task_workers row IS the durability a
 * future recovery slice reads (the lease row survives gateway death; reading
 * and re-arming expired leases is the chunk-3 reconciliation).
 *
 * Durability (D10): every progress frame commits its journal event
 * (`worker.progress` on the run's stream, S13 run-stream semantics) AND the
 * row's last_progress_json in ONE transaction; checkpoints commit
 * (`worker.checkpoint`) with the opaque D33 payload persisted verbatim —
 * NEVER only in process memory. A worker-reported error frame, a protocol
 * violation, a crash exit, a handshake timeout, and a watchdog stall all
 * escalate (where the process is still alive) and leave TWO durable traces:
 * `worker.crashed` in the journal and the run moved through the seam to the
 * DEFINED non-terminal state RECOVERY_REQUIRED (D8) — chosen over FAILED
 * because FAILED is terminal and would foreclose the D32 recovery policy
 * ("worker crash with safe checkpoint → restart and resume"); the recovery
 * slice owns the resume-or-fail decision. For an ESCALATED worker the crash
 * event is journaled only once the escalation completed, so the event marks
 * the complete aftermath (process reaped, row terminal); the run-state write
 * follows the crash evidence, is GUARDED (a terminal run is never
 * resurrected), and a failure in either unit is contained (fault log) — the
 * gap class chunk 3's reconciliation closes. done → `worker.completed` + row
 * `exited` + run SUCCEEDED through the seam.
 *
 * Process-tree note: the child is spawned WITHOUT detached and killed
 * directly for now (full tree cancellation is S22); every kill goes through
 * the injectable killChild seam so S22 can swap in group kill without
 * touching this lifecycle logic.
 *
 * Child processes are reached ONLY through the injected spawnChild seam
 * (boundary guard: process spawning stays in adapters/process; the fake
 * worker factory is a named test exception). Child stderr is forwarded to the
 * injected bounded sink (the sink owns redaction — G3: stderr is diagnostic,
 * never protocol, never journaled raw; protocol-failure details are size-only
 * digests).
 *
 * Events are recorded through the SAME journal seam as every other module
 * (the injected EventsService — no second journal) on the RUN's stream
 * (stream_id = run_id), following the S13 run-stream semantics with one
 * gapless per-run cursor.
 *
 * Admission control (S16 chunk 2, E1): when an admission gate is injected,
 * startWorker consults it in startAttempt AFTER the run validation and
 * BEFORE the worker row insert (one synchronous section — gate check and row
 * insert cannot interleave on the single-threaded event loop, so the gate's
 * live-row count is exact at decision time). A refusal NEVER touches running
 * workers, their leases or their children (the never-kill guarantee — only
 * NEW work queues): the run becomes QUEUED (D8 vocabulary) durably — a
 * `worker.queued` journal event carrying the machine-readable reason
 * ({code, limit, current} + human text) on the run stream, then the run row
 * state through the seam — and the queued run enters a bounded internal
 * dequeue that re-admits OLDEST-FIRST on capacity-free events (worker exit,
 * done, stop) plus the periodic tick as a re-check loop for pressure that
 * clears without a worker exit (disk space). The dequeue awaits each
 * re-admitted start before considering the next entry, so the gate's count
 * is exact between admissions; entries whose run turned terminal are
 * dropped (never resurrected). startWorker resolves a QUEUED result
 * immediately (state "queued" + reason) — chunk 3 wires the run flow around
 * it; coalesced callers receive the same queued result rather than
 * retry-looping against a full gate. The per-worker resource limits from
 * the admission policy travel on the spawn request (resourceLimits) for the
 * spawn adapter to enforce with kernel limits (prlimit — see
 * worker-process-spawn.ts): the gate SCHEDULES, the kernel ENFORCES.
 *
 * Governing records: D32, D33, D10, D8, E1, D27, PRD §19 item 25 (AC25).
 */
import { randomUUID } from "node:crypto";

import { RUN_STATES_TERMINAL, type RunState } from "@shera-bot/contracts";

import type { EventsService } from "../events/events.service.ts";
import type { WorkerQueuedReason } from "../events/events.types.ts";
import type { AdmissionGate, AdmissionPolicy } from "./admission.ts";
import type {
  TaskWorkersRepository,
  TaskWorkerState,
} from "../../adapters/sqlite/task-workers-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  parseWorkerFrame,
  type WorkerChildFrame,
  type WorkerParentFrame,
} from "./worker-frames.ts";
import type { WorkerStopReason } from "../events/events.types.ts";

// ── Public surface ───────────────────────────────────────────────────────────

/** The task configuration a run flow hands its worker process. */
export interface TaskWorkerSpec {
  /**
   * Opaque per-run task configuration for the worker process. Never secrets
   * (G3) — the transport seam decides how it reaches the child, and argv is
   * world-readable.
   */
  config?: Record<string, unknown>;
  /**
   * The run's provider snapshot placeholder (E1 admission control): the
   * provider id the admission gate counts per-provider concurrency against.
   * Placeholder shape — the full provider snapshot arrives with the slice
   * that owns provider resolution; the gate reads only provider_id.
   */
  providerSnapshot?: { provider_id: string; model?: string } | null;
}

/** Per-worker kernel resource limits applied by the spawn adapter (E1). */
export interface TaskWorkerResourceLimits {
  /** Address-space cap for the child (prlimit --as). */
  memoryBytes: number;
  /** Process-creation cap for the child (prlimit --nproc). */
  maxProcesses: number;
}

/** Everything the spawn seam needs to launch one worker incarnation. */
export interface TaskWorkerSpawnRequest {
  workspace_id: string;
  run_id: string;
  /** Fresh per-incarnation identity (durable identity is workspace+run). */
  worker_id: string;
  /** The heartbeat cadence the child should keep (the watchdog's unit). */
  heartbeat_interval_ms: number;
  spec: TaskWorkerSpec;
  /**
   * Kernel resource limits from the admission policy (E1); null when no
   * admission gate is configured (chunk-1 behavior — no prlimit wrapper).
   */
  resourceLimits: TaskWorkerResourceLimits | null;
}

export interface TaskWorkerChildExit {
  code: number | null;
  signal: string | null;
}

/**
 * One child-process incarnation as the supervisor sees it: RAW stdout lines
 * only. The supervisor owns frame classification and version policy; a
 * spawnFakeTaskWorker handle satisfies this through a thin wrapper.
 */
export interface TaskWorkerChild {
  onLine(listener: (line: string) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
  send(frame: WorkerParentFrame): void;
  kill(signal?: NodeJS.Signals): void;
  waitForExit(): Promise<TaskWorkerChildExit>;
}

/** The bounded, redacted stderr sink (G3). Default: discard. */
export interface TaskWorkerStderrSink {
  write(chunk: string): void;
}

/** Contained operator-fault sink (same conduit shape as the S12 fault log). */
export type TaskWorkerFaultLog = (event: string, fields: Record<string, unknown>) => void;

/**
 * The run-boundary seam (interface ONLY — operations.service.ts is not
 * touched in this slice; chunk 3 wires the real adapter over the operations
 * service, resolving a run's operation from the run row).
 */
export interface TaskRunOperationsSeam {
  /** The run's current D8 state, or null when the run is unknown here. */
  runState(workspaceId: string, runId: string): RunState | null;
  /** Authoritative run-state write (the runtime gateway's transition path). */
  applyRunState(workspaceId: string, runId: string, state: RunState): void;
}

export interface TaskWorkerSupervisorPolicy {
  /** The child heartbeat cadence the watchdog expects. */
  heartbeatIntervalMs: number;
  /** Missed intervals that mean "stalled" (window = interval × limit). */
  missedHeartbeatLimit: number;
  /** The lease window renewed on every healthy frame (D32 lease durability). */
  leaseWindowMs: number;
  /** Backstop for a child that never completes hello/ready. */
  handshakeTimeoutMs: number;
  /** Escalation: shutdown frame → SIGTERM after this grace. */
  shutdownGraceMs: number;
  /** Escalation: SIGTERM → SIGKILL after this further grace. */
  killGraceMs: number;
  /** Per-incarnation bound on stderr bytes forwarded to the sink (G3). */
  stderrMaxBytes: number;
  /** Hard cap on one checkpoint payload the runtime persists (opaque JSON). */
  maxCheckpointBytes: number;
}

export const DEFAULT_WORKER_POLICY: TaskWorkerSupervisorPolicy = {
  heartbeatIntervalMs: 5_000,
  // Window: 3 missed intervals = 15s of silence ⇒ stalled. A slow-but-healthy
  // worker keeps beating and is never killed by this (D32: stalled ≠ slow).
  missedHeartbeatLimit: 3,
  leaseWindowMs: 15_000,
  handshakeTimeoutMs: 10_000,
  // Chunk-1 escalation cadence: shutdown frame → SIGTERM at 2s → SIGKILL at 3s.
  shutdownGraceMs: 2_000,
  killGraceMs: 1_000,
  stderrMaxBytes: 8_192,
  maxCheckpointBytes: 64 * 1024,
};

export interface TaskWorkerSupervisorDeps {
  /** The ONLY journal seam (no second journal): worker events append here. */
  events: EventsService;
  /** Shared short-transaction primitive (progress = journal + row, one unit). */
  tx: SqliteTransactions;
  /** The v8 task_workers row store (the lease durability). */
  taskWorkers: TaskWorkersRepository;
  /** The run boundary (run reads + authoritative run-state writes). */
  runControl: TaskRunOperationsSeam;
  /**
   * The E1 admission gate (S16 chunk 2). Omitted = no admission control
   * (chunk-1 behavior): every start attempt spawns. Constructed by the
   * composition root — garbage limits fail typed at gate construction (G4).
   */
  admission?: AdmissionGate | undefined;
  /** The process seam (process spawning stays in adapters/process). */
  spawnChild: (request: TaskWorkerSpawnRequest) => TaskWorkerChild | Promise<TaskWorkerChild>;
  /**
   * The kill seam — defaults to the child's own kill. S22 swaps in process-
   * group kill for full tree cancellation without touching this lifecycle.
   */
  killChild?: ((child: TaskWorkerChild, signal: NodeJS.Signals) => void) | undefined;
  /** Bounded, redacted child-stderr sink (G3). Default: discard. */
  stderrSink?: TaskWorkerStderrSink | undefined;
  /** Contained operator-fault sink. Default: discard. */
  logFault?: TaskWorkerFaultLog | undefined;
  policy?: Partial<TaskWorkerSupervisorPolicy> | undefined;
  /** Injectable clock (ms) for tests; default Date.now. */
  now?: (() => number) | undefined;
}

export interface TaskWorkerSnapshot {
  workspace_id: string;
  run_id: string;
  worker_id: string;
  pid: number;
  state: "running";
}

/**
 * A start REFUSED by the admission gate (E1): the run is durably QUEUED
 * (D8) and waits in the bounded internal dequeue. The machine-readable
 * reason is the same object the worker.queued journal event carries.
 */
export interface TaskWorkerQueuedResult {
  workspace_id: string;
  run_id: string;
  state: "queued";
  reason: WorkerQueuedReason;
  message: string;
}

/** What startWorker resolves: a running worker, or a durably queued run. */
export type TaskWorkerStartResult = TaskWorkerSnapshot | TaskWorkerQueuedResult;

/** Machine-readable pressure read model (chunk-4 UI + pressure coordinators). */
export interface TaskWorkerAdmissionPressure {
  configured: boolean;
  liveWorkers: number;
  queuedRuns: number;
  freeDiskBytes: number | null;
  limits: AdmissionPolicy | null;
  projectedTotalWorkersMemoryBytes: number | null;
  perProviderLive: Array<{ provider_id: string; live_workers: number }>;
}

/** Chunk-4 UI read model of one run's worker in this process. */
export type TaskWorkerPresence = "none" | "starting" | "running" | "stopping";

/** Stable failure codes for the worker boundary (SCREAMING_SNAKE). */
export type TaskWorkerFailureCode =
  "WORKER_NOT_FOUND" | "WORKER_RUN_TERMINAL" | "WORKER_START_FAILED";

export class TaskWorkerError extends Error {
  readonly code: TaskWorkerFailureCode;
  readonly category = "state" as const;

  constructor(code: TaskWorkerFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "TaskWorkerError";
    this.code = code;
  }
}

// ── Internal records ─────────────────────────────────────────────────────────

type HandshakeFailure = { kind: "exit" } | { kind: "timeout" } | { kind: "protocol" };

interface Incarnation {
  worker_id: string;
  child: TaskWorkerChild;
  pid: number | null;
  spawnedAt: number;
  lastFrameAt: number;
  ready: boolean;
  /** Set SYNCHRONOUSLY by whichever path initiates termination first. */
  terminating: boolean;
  doneHandled: boolean;
  /** Last observed progress percent (crash events carry it). */
  lastPercent: number | null;
  escalationTimers: Array<NodeJS.Timeout>;
  unsubscribers: Array<() => void>;
  stderrBytes: number;
  handshake: Promise<HandshakeFailure | null>;
  settleHandshake: (outcome: HandshakeFailure | null) => void;
}

interface WorkerRecord {
  workspace_id: string;
  run_id: string;
  presence: TaskWorkerPresence;
  current: Incarnation | null;
  /** Coalesces concurrent starts onto ONE spawn per run. */
  startPromise: Promise<TaskWorkerStartResult> | null;
  /** The provider id of the CURRENT incarnation's spec (per-provider counting). */
  providerId: string | null;
}

/** One run waiting in the bounded internal dequeue (E1). */
interface QueuedEntry {
  workspace_id: string;
  run_id: string;
  spec: TaskWorkerSpec;
  queuedAtMs: number;
}

function isTerminalRunState(state: RunState): boolean {
  return (RUN_STATES_TERMINAL as readonly string[]).includes(state);
}

function workerRecordKey(workspaceId: string, runId: string): string {
  // Delimited like the S12 session records; ids are runtime-controlled.
  return `${workspaceId}:${runId}`;
}

// ── The supervisor ───────────────────────────────────────────────────────────

export class TaskWorkerSupervisor {
  private readonly policy: TaskWorkerSupervisorPolicy;
  private readonly admission: AdmissionGate | null;
  private readonly records = new Map<string, WorkerRecord>();
  /** The bounded internal dequeue (E1): oldest-first re-admission. */
  private readonly queued: QueuedEntry[] = [];
  private pumping = false;
  private readonly tickTimer: NodeJS.Timeout;

  constructor(private readonly deps: TaskWorkerSupervisorDeps) {
    this.policy = { ...DEFAULT_WORKER_POLICY, ...deps.policy };
    this.admission = deps.admission ?? null;
    // One global tick drives stall detection for every record.
    const tickMs = Math.min(
      1_000,
      Math.max(5, Math.min(this.policy.heartbeatIntervalMs, this.policy.handshakeTimeoutMs) / 4),
    );
    this.tickTimer = setInterval(() => this.tick(), tickMs);
    // An unref'd tick never keeps a process (or a test run) alive by itself.
    this.tickTimer.unref();
  }

  /** Presence of one run's worker — the chunk-4 UI read model. */
  presenceState(workspaceId: string, runId: string): TaskWorkerPresence {
    return this.records.get(workerRecordKey(workspaceId, runId))?.presence ?? "none";
  }

  // ── Start / stop ───────────────────────────────────────────────────────────

  /**
   * Start the ONE worker of this run on demand (the run flow calls this when
   * a run starts). A live worker is reused (coalescing — never a second
   * spawn); a start already in flight is awaited (its result — running OR
   * queued — is returned to every coalesced caller); a start that fails
   * rejects typed for EVERY coalesced caller (workers have no automatic
   * restart — the D32 recovery policy belongs to the recovery slice).
   * E1: a start refused by the admission gate does NOT reject — the run is
   * durably QUEUED with a machine-readable reason and the queued result is
   * returned (the dequeue re-admits it when capacity frees).
   */
  async startWorker(
    workspaceId: string,
    runId: string,
    spec: TaskWorkerSpec = {},
  ): Promise<TaskWorkerStartResult> {
    for (;;) {
      const record = this.recordFor(workspaceId, runId);
      const current = record.current;
      if (current !== null && !current.terminating && current.ready) {
        return this.snapshotOf(record, current);
      }
      if (record.startPromise !== null) {
        // Propagate a failed start to every coalesced caller (no silent
        // retry); a QUEUED result returns to every coalesced caller too —
        // retry-looping against a full gate would spin forever.
        const settled = await record.startPromise;
        if (settled.state === "queued") return settled;
        continue; // resolved → loop to snapshot the fresh incarnation
      }
      if (current?.terminating === true) {
        // A dying incarnation settles on its exit before anything else starts.
        await current.child.waitForExit().catch(() => {});
        continue;
      }
      const started = this.startAttempt(record, spec);
      record.startPromise = started;
      try {
        return await started;
      } finally {
        if (record.startPromise === started) record.startPromise = null;
      }
    }
  }

  /**
   * Graceful stop of one run's worker through the chunk-1 escalation
   * (shutdown frame → SIGTERM → SIGKILL). The RUN's state is the caller's
   * business (the run flow/gateway owns CANCELLING — chunk 3 wires it):
   * this records the stop and reaps the process, nothing else. Stopping an
   * unknown or already-dead worker is a typed no-op (idempotent).
   */
  async stopWorker(
    workspaceId: string,
    runId: string,
    reason: WorkerStopReason = "requested",
  ): Promise<void> {
    const record = this.records.get(workerRecordKey(workspaceId, runId));
    if (record === undefined) return;
    if (record.startPromise !== null) {
      // Settle a start in flight; a FAILED start leaves nothing to stop.
      await record.startPromise.catch(() => {});
    }
    const incarnation = record.current;
    if (incarnation === null) return;
    record.presence = "stopping";
    await this.terminateAndAwaitExit(incarnation);
    this.detachCurrent(record, incarnation);
    if (record.current === null) record.presence = "none";
    // The row reads killed unless the child recorded its own exit first.
    await this.finalizeRowState(workspaceId, runId, incarnation.worker_id, "killed");
    this.recordEvent(record, "worker.stopped", {
      worker_id: incarnation.worker_id,
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      reason,
    });
    // Capacity freed (E1): the dequeue re-admits oldest-first.
    void this.pumpQueue().catch((error) => {
      this.faultLog("task_worker_dequeue_pump_failed", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Stop every live worker (composition shutdown); resolves when all exited. */
  async stopAll(): Promise<void> {
    clearInterval(this.tickTimer);
    const stops: Array<Promise<void>> = [];
    for (const record of this.records.values()) {
      stops.push(this.stopWorker(record.workspace_id, record.run_id, "shutdown"));
    }
    await Promise.all(stops);
  }

  // ── Start pipeline ─────────────────────────────────────────────────────────

  /**
   * One start attempt: validate the run through the seam (unknown run and
   * terminal run are typed refusals — the runtime never spawns a worker for
   * work the gateway has closed), consult the E1 admission gate (a refusal
   * queues the run durably — never touches running workers), insert the
   * starting row, spawn, wait for the hello/ready handshake. The gate check
   * and the row insert are ONE synchronous section: no interleaving on the
   * event loop, so the gate's live-row count is exact at decision time.
   */
  private async startAttempt(
    record: WorkerRecord,
    spec: TaskWorkerSpec,
  ): Promise<TaskWorkerStartResult> {
    const currentState = this.deps.runControl.runState(record.workspace_id, record.run_id);
    if (currentState === null) {
      throw new TaskWorkerError(
        "WORKER_NOT_FOUND",
        `run ${record.run_id} not found in workspace ${record.workspace_id}`,
      );
    }
    if (isTerminalRunState(currentState)) {
      throw new TaskWorkerError(
        "WORKER_RUN_TERMINAL",
        `run ${record.run_id} is ${currentState}; a terminal run never spawns a worker`,
      );
    }

    // E1 admission control: the gate runs BEFORE any worker row insert — a
    // refused start leaves NO row, NO spawn and NO presence change; the run
    // is marked QUEUED durably and waits in the internal dequeue.
    const providerId = spec.providerSnapshot?.provider_id ?? null;
    if (this.admission !== null) {
      const decision = this.admission.check({ providerId });
      if (!decision.admitted) {
        return this.queueRun(record, spec, decision.reason!, decision.message ?? "");
      }
    }

    record.presence = "starting";
    record.providerId = providerId;
    const workerId = `wk-${randomUUID()}`;
    const startedAt = this.now();
    this.deps.taskWorkers.insertWorker({
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      worker_id: workerId,
      pid: null,
      state: "starting",
      heartbeat_at: null,
      lease_expires_at: this.isoAt(startedAt + this.policy.leaseWindowMs),
      last_progress_json: null,
      started_at: this.isoAt(startedAt),
    });

    const incarnation = await this.spawnIncarnation(record, workerId, spec);
    if (incarnation === null) {
      // Spawn itself failed: no process ever ran. Leave the durable trace
      // (row exited + crash event) and reject the caller honestly; the RUN's
      // state is untouched — the start never took the run anywhere.
      this.deps.taskWorkers.updateState(record.workspace_id, record.run_id, workerId, "exited");
      this.recordEvent(record, "worker.crashed", {
        worker_id: workerId,
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        cause: "unexpected_exit",
        exit_code: null,
        signal: null,
        error_class: null,
        last_percent: null,
      });
      record.presence = "none";
      throw new TaskWorkerError(
        "WORKER_START_FAILED",
        `worker ${workerId} for run ${record.run_id} failed to spawn (see the fault log)`,
      );
    }

    const failure = await this.awaitHandshake(incarnation);
    if (failure === null) {
      // Live at ready: row running, measured start journaled (the honest
      // "how long until this run's worker could work" number).
      const startLatencyMs = Math.max(0, Math.round(this.now() - incarnation.spawnedAt));
      try {
        this.deps.tx.transaction((exec: SqliteExec) => {
          this.appendEventStrict(record, "worker.started", {
            worker_id: incarnation.worker_id,
            workspace_id: record.workspace_id,
            run_id: record.run_id,
            pid: incarnation.pid ?? 0,
            start_latency_ms: startLatencyMs,
          });
          this.deps.taskWorkers.updateState(
            record.workspace_id,
            record.run_id,
            incarnation.worker_id,
            "running",
            exec,
          );
        });
      } catch (error) {
        // Contained: the worker stays alive; the row/event gap is reconciliation
        // territory (chunk 3). The start still succeeds — the process is real.
        this.faultLog("task_worker_start_event_failed", {
          workspace_id: record.workspace_id,
          run_id: record.run_id,
          worker_id: incarnation.worker_id,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      record.presence = "running";
      return this.snapshotOf(record, incarnation);
    }

    // Handshake-breaking failure (exit before ready, silence, protocol):
    // escalate the teardown, journal the crash, mark the run RECOVERY_REQUIRED
    // (guarded), and reject the start typed — no automatic restart here.
    await this.terminateAndAwaitExit(incarnation);
    this.detachCurrent(record, incarnation);
    record.presence = "none";
    const cause: "unexpected_exit" | "handshake_timeout" | "protocol_violation" =
      failure.kind === "exit"
        ? "unexpected_exit"
        : failure.kind === "timeout"
          ? "handshake_timeout"
          : "protocol_violation";
    const exit = await incarnation.child.waitForExit();
    await this.finalizeRowState(
      record.workspace_id,
      record.run_id,
      incarnation.worker_id,
      failure.kind === "exit" ? "exited" : "killed",
    );
    this.recordEvent(record, "worker.crashed", {
      worker_id: incarnation.worker_id,
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      cause,
      exit_code: exit.code,
      signal: exit.signal,
      error_class: null,
      last_percent: incarnation.lastPercent,
    });
    this.markRunForRecovery(record);
    throw new TaskWorkerError(
      "WORKER_START_FAILED",
      `worker ${incarnation.worker_id} for run ${record.run_id} never became ready (${cause})`,
    );
  }

  // ── Admission control (E1): queue + bounded dequeue + pressure read ────────

  /**
   * A gate refusal: mark the run QUEUED durably (journal evidence first, then
   * the guarded seam write — the crash-aftermath ordering) and remember the
   * run in the bounded internal dequeue. A run already queued is NOT
   * re-marked and NOT re-journaled (no duplicate durable noise); its entry's
   * spec is refreshed in place and its original queue position kept.
   */
  private queueRun(
    record: WorkerRecord,
    spec: TaskWorkerSpec,
    reason: WorkerQueuedReason,
    message: string,
  ): TaskWorkerQueuedResult {
    const key = workerRecordKey(record.workspace_id, record.run_id);
    const existing = this.queued.find(
      (entry) => workerRecordKey(entry.workspace_id, entry.run_id) === key,
    );
    if (existing !== undefined) {
      existing.spec = spec;
    } else {
      this.queued.push({
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        spec,
        queuedAtMs: this.now(),
      });
      this.markRunQueued(record, reason, message);
    }
    record.presence = "none";
    return {
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      state: "queued",
      reason,
      message,
    };
  }

  /**
   * Durable QUEUED marking: `worker.queued` on the run stream (the
   * machine-readable reason is the UI contract for chunk 3), then the run
   * row state through the seam — GUARDED (a terminal run is never
   * resurrected; an already-QUEUED run is not rewritten). Both units are
   * contained: a journaling or state gap is fault-logged, never thrown into
   * the start path.
   */
  private markRunQueued(record: WorkerRecord, reason: WorkerQueuedReason, message: string): void {
    try {
      this.appendEventStrict(record, "worker.queued", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        reason,
        message: message.slice(0, 500),
      });
    } catch (error) {
      this.faultLog("task_worker_queued_event_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const current = this.deps.runControl.runState(record.workspace_id, record.run_id);
      if (current === null || isTerminalRunState(current) || current === "QUEUED") {
        return;
      }
      this.deps.runControl.applyRunState(record.workspace_id, record.run_id, "QUEUED");
    } catch (error) {
      this.faultLog("task_worker_run_state_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        target: "QUEUED",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The bounded internal dequeue (prototype-grade, documented): on every
   * capacity-free event (worker exit, done, stop) and on the periodic tick
   * (a re-check loop for pressure that clears without a worker exit — disk
   * space), queued runs are re-admitted OLDEST-FIRST. Strict FIFO: the head
   * entry is never skipped past (no starvation). Each admitted start is
   * awaited before the next entry is considered, so the gate's live count is
   * exact between admissions; the head's refusal stops the loop (bounded —
   * one pass per invocation, re-entrancy guarded). Terminal runs are dropped
   * (never resurrected); entries whose run already carries a live worker are
   * dropped (a direct startWorker won the race).
   */
  private async pumpQueue(): Promise<void> {
    if (this.pumping || this.queued.length === 0 || this.admission === null) return;
    this.pumping = true;
    try {
      while (this.queued.length > 0) {
        const entry = this.queued[0]!;
        const state = this.deps.runControl.runState(entry.workspace_id, entry.run_id);
        if (state === null || isTerminalRunState(state)) {
          this.queued.shift();
          continue;
        }
        const record = this.records.get(workerRecordKey(entry.workspace_id, entry.run_id));
        if (record !== undefined && record.current !== null) {
          this.queued.shift(); // a direct startWorker already started this run
          continue;
        }
        const decision = this.admission.check({
          providerId: entry.spec.providerSnapshot?.provider_id ?? null,
        });
        if (!decision.admitted) break;
        this.queued.shift();
        try {
          await this.startWorker(entry.workspace_id, entry.run_id, entry.spec);
        } catch (error) {
          // A failed dequeue start (spawn failure → the run is already in
          // RECOVERY_REQUIRED per the start pipeline) is contained: no
          // automatic restart, no re-queue (chunk-1 rule).
          this.faultLog("task_worker_dequeue_start_failed", {
            workspace_id: entry.workspace_id,
            run_id: entry.run_id,
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Live workers attributed to one provider id (E1 per-provider counting):
   * the in-process spec knowledge the admission gate counts through its
   * counters seam. Public so composition roots can wire the same seam.
   */
  liveWorkerCountByProvider(providerId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      const incarnation = record.current;
      if (incarnation === null || incarnation.terminating) continue;
      if (record.providerId === providerId) count += 1;
    }
    return count;
  }

  /** The E1 pressure read model (machine-readable, chunk-4 UI + coordinators). */
  admissionPressure(): TaskWorkerAdmissionPressure {
    if (this.admission === null) {
      return {
        configured: false,
        liveWorkers: 0,
        queuedRuns: this.queued.length,
        freeDiskBytes: null,
        limits: null,
        projectedTotalWorkersMemoryBytes: null,
        perProviderLive: [],
      };
    }
    const gatePressure = this.admission.pressure();
    const perProvider = new Map<string, number>();
    for (const record of this.records.values()) {
      const incarnation = record.current;
      if (incarnation === null || incarnation.terminating || record.providerId === null) {
        continue;
      }
      perProvider.set(record.providerId, (perProvider.get(record.providerId) ?? 0) + 1);
    }
    return {
      configured: true,
      liveWorkers: gatePressure.liveWorkers,
      queuedRuns: this.queued.length,
      freeDiskBytes: gatePressure.freeDiskBytes,
      limits: gatePressure.limits,
      projectedTotalWorkersMemoryBytes: gatePressure.projectedTotalWorkersMemoryBytes,
      perProviderLive: [...perProvider.entries()]
        .map(([provider_id, live_workers]) => ({ provider_id, live_workers }))
        .sort((a, b) => a.provider_id.localeCompare(b.provider_id)),
    };
  }

  private async spawnIncarnation(
    record: WorkerRecord,
    workerId: string,
    spec: TaskWorkerSpec,
  ): Promise<Incarnation | null> {
    let child: TaskWorkerChild;
    try {
      child = await this.deps.spawnChild({
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: workerId,
        heartbeat_interval_ms: this.policy.heartbeatIntervalMs,
        spec,
        // E1: the gate SCHEDULES, the kernel ENFORCES — the adapter wraps the
        // child in prlimit with these limits (worker-process-spawn.ts).
        resourceLimits:
          this.admission === null
            ? null
            : {
                memoryBytes: this.admission.policy.maxWorkerMemoryBytes,
                maxProcesses: this.admission.policy.maxWorkerProcesses,
              },
      });
    } catch (error) {
      this.faultLog("task_worker_spawn_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: workerId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const now = this.now();
    let settleHandshake!: (outcome: HandshakeFailure | null) => void;
    const handshake = new Promise<HandshakeFailure | null>((resolve) => {
      settleHandshake = resolve;
    });
    const incarnation: Incarnation = {
      worker_id: workerId,
      child,
      pid: null,
      spawnedAt: now,
      lastFrameAt: now,
      ready: false,
      terminating: false,
      doneHandled: false,
      lastPercent: null,
      escalationTimers: [],
      unsubscribers: [],
      stderrBytes: 0,
      handshake,
      settleHandshake,
    };

    incarnation.unsubscribers.push(
      child.onLine((line) => this.handleLineSafe(record, incarnation, line)),
    );
    incarnation.unsubscribers.push(
      child.onStderr((chunk) => this.handleStderr(incarnation, chunk)),
    );
    // Exit observer: deliberate terminations handle their own aftermath; an
    // exit nobody initiated is a crash (death is detected independently of
    // any final event).
    void child
      .waitForExit()
      .then((exit) => this.onChildExit(record, incarnation, exit))
      .catch((error) => {
        this.faultLog("task_worker_exit_observer_failed", {
          workspace_id: record.workspace_id,
          run_id: record.run_id,
          worker_id: workerId,
          name: error instanceof Error ? error.name : "Error",
        });
      });
    record.current = incarnation;
    return incarnation;
  }

  private awaitHandshake(incarnation: Incarnation): Promise<HandshakeFailure | null> {
    return new Promise<HandshakeFailure | null>((resolve) => {
      const remaining = Math.max(
        0,
        this.policy.handshakeTimeoutMs - (this.now() - incarnation.spawnedAt),
      );
      const deadline = setTimeout(() => {
        incarnation.settleHandshake({ kind: "timeout" });
      }, remaining);
      deadline.unref();
      void incarnation.handshake.then((outcome) => {
        clearTimeout(deadline);
        resolve(outcome);
      });
    });
  }

  // ── Frame handling ─────────────────────────────────────────────────────────

  /**
     Containment boundary for frame handling: a persistence failure while
     processing one frame must never escape into the child's stdout 'data'
     handler (an unhandled throw there would kill the runtime). The previous
     durable state stands; the next frame retries.
   */
  private handleLineSafe(record: WorkerRecord, incarnation: Incarnation, line: string): void {
    try {
      this.handleLine(record, incarnation, line);
    } catch (error) {
      this.faultLog("task_worker_frame_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: incarnation.worker_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleLine(record: WorkerRecord, incarnation: Incarnation, line: string): void {
    // ANY line from the child is liveness — even a violating one.
    incarnation.lastFrameAt = this.now();

    let frame: WorkerChildFrame;
    try {
      frame = parseWorkerFrame(line);
    } catch (error) {
      this.onWorkerProtocolError(record, incarnation, error as WorkerProtocolError);
      return;
    }

    if (!incarnation.ready) {
      // Strict handshake order (the supervisor layer's policy).
      if (frame.type === "hello") {
        if (frame.worker_version !== WORKER_PROTOCOL_VERSION) {
          this.onWorkerProtocolError(
            record,
            incarnation,
            new WorkerProtocolError({
              code: "WORKER_PROTOCOL_VERSION",
              reason: "version_mismatch",
              detail: `expected ${WORKER_PROTOCOL_VERSION}, received ${frame.worker_version}`,
            }),
          );
          return;
        }
        incarnation.pid = frame.pid;
        try {
          this.deps.taskWorkers.setPid(
            record.workspace_id,
            record.run_id,
            incarnation.worker_id,
            frame.pid,
          );
        } catch (error) {
          this.faultLog("task_worker_pid_write_failed", {
            workspace_id: record.workspace_id,
            run_id: record.run_id,
            worker_id: incarnation.worker_id,
            name: error instanceof Error ? error.name : "Error",
          });
        }
        return;
      }
      if (frame.type === "ready") {
        if (incarnation.pid === null) {
          // Ready before hello: the child skipped the version announcement.
          this.onWorkerProtocolError(
            record,
            incarnation,
            new WorkerProtocolError({ reason: "ready_before_hello" }),
          );
          return;
        }
        if (frame.worker_id !== incarnation.worker_id) {
          // Identity confusion: the child announced a foreign worker id.
          this.onWorkerProtocolError(
            record,
            incarnation,
            new WorkerProtocolError({ reason: "worker_id_mismatch" }),
          );
          return;
        }
        incarnation.ready = true;
        incarnation.settleHandshake(null);
        return;
      }
      // Any other frame before ready is a handshake violation.
      this.onWorkerProtocolError(
        record,
        incarnation,
        new WorkerProtocolError({ reason: "frame_before_ready", detail: frame.type }),
      );
      return;
    }

    switch (frame.type) {
      case "heartbeat":
        // Liveness + lease renewal only (D32: the lease is renewed while the
        // worker is healthy). Heartbeats carry no work semantics.
        this.renewLease(record, incarnation);
        return;
      case "progress": {
        incarnation.lastPercent = frame.percent;
        const at = this.now();
        // ONE atomic unit (AC2/D10): the journal event and the row's
        // last_progress_json + lease commit together or not at all.
        this.deps.tx.transaction((exec: SqliteExec) => {
          this.appendEventStrict(record, "worker.progress", {
            worker_id: incarnation.worker_id,
            workspace_id: record.workspace_id,
            run_id: record.run_id,
            percent: frame.percent,
            text: frame.text,
          });
          this.deps.taskWorkers.recordProgress(
            record.workspace_id,
            record.run_id,
            incarnation.worker_id,
            JSON.stringify({ percent: frame.percent, text: frame.text }),
            this.isoAt(at),
            this.isoAt(at + this.policy.leaseWindowMs),
            exec,
          );
        });
        return;
      }
      case "checkpoint": {
        const checkpointJson = JSON.stringify(frame.checkpoint);
        if (Buffer.byteLength(checkpointJson, "utf8") > this.policy.maxCheckpointBytes) {
          // An oversized checkpoint is never silently truncated (durable
          // recovery data must be exact) — it is a protocol violation.
          this.onWorkerProtocolError(
            record,
            incarnation,
            new WorkerProtocolError({
              reason: "checkpoint_too_large",
              detail: `${Buffer.byteLength(checkpointJson, "utf8")} bytes; cap ${this.policy.maxCheckpointBytes}`,
            }),
          );
          return;
        }
        const at = this.now();
        // ONE atomic unit: the checkpoint event (payload persisted verbatim)
        // and the lease renewal commit together (D33/D10).
        this.deps.tx.transaction((exec: SqliteExec) => {
          this.appendEventStrict(record, "worker.checkpoint", {
            worker_id: incarnation.worker_id,
            workspace_id: record.workspace_id,
            run_id: record.run_id,
            checkpoint: frame.checkpoint,
          });
          this.deps.taskWorkers.recordHeartbeat(
            record.workspace_id,
            record.run_id,
            incarnation.worker_id,
            this.isoAt(at),
            this.isoAt(at + this.policy.leaseWindowMs),
            exec,
          );
        });
        return;
      }
      case "done":
        this.handleDone(record, incarnation, frame.summary);
        return;
      case "error":
        this.handleWorkerErrorFrame(record, incarnation, frame.failure_class);
        return;
      case "hello":
      case "ready":
        // Duplicate handshakes from a live child: tolerated liveness.
        this.renewLease(record, incarnation);
        return;
    }
  }

  /** done: work finished — completed event + row exited (ONE unit), run SUCCEEDED. */
  private handleDone(record: WorkerRecord, incarnation: Incarnation, summary: string): void {
    if (incarnation.doneHandled || incarnation.terminating) return;
    incarnation.doneHandled = true;
    // Mark terminating FIRST: the child exits by itself right after done, and
    // its exit must never be observed as a crash — a finished worker is not a
    // crashed one, even if the persistence below hits a contained fault.
    incarnation.terminating = true;
    try {
      this.deps.tx.transaction((exec: SqliteExec) => {
        this.appendEventStrict(record, "worker.completed", {
          worker_id: incarnation.worker_id,
          workspace_id: record.workspace_id,
          run_id: record.run_id,
          summary,
        });
        this.deps.taskWorkers.updateState(
          record.workspace_id,
          record.run_id,
          incarnation.worker_id,
          "exited",
          exec,
        );
      });
    } catch (error) {
      this.faultLog("task_worker_done_persist_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: incarnation.worker_id,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.detachCurrent(record, incarnation);
    record.presence = "none";
    this.markRunSucceeded(record);
    // Capacity freed (E1): the dequeue re-admits oldest-first.
    void this.pumpQueue().catch((error) => {
      this.faultLog("task_worker_dequeue_pump_failed", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** The worker reports its own failure: escalate, then journal + recovery. */
  private handleWorkerErrorFrame(
    record: WorkerRecord,
    incarnation: Incarnation,
    failureClass: string,
  ): void {
    if (incarnation.terminating) return;
    incarnation.terminating = true;
    void this.escalateAndJournal(record, incarnation, "worker_error", failureClass.slice(0, 100));
  }

  /** A typed protocol violation from the child (never silently dropped). */
  private onWorkerProtocolError(
    record: WorkerRecord,
    incarnation: Incarnation,
    error: WorkerProtocolError,
  ): void {
    if (incarnation.terminating) return;
    if (!incarnation.ready) {
      // Pre-ready violation: the handshake can never complete on this child.
      incarnation.settleHandshake({ kind: "protocol" });
      return;
    }
    // A live worker that cannot speak its protocol is terminated (unlike a
    // session, there is nothing to prompt it with).
    incarnation.terminating = true;
    void this.escalateAndJournal(record, incarnation, "protocol_violation", error.code);
  }

  // ── Health: stall watchdog (stalled ≠ slow) ────────────────────────────────

  private tick(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      const incarnation = record.current;
      if (incarnation === null) continue;
      // Hang detection (D32: stalled is detected separately from slow).
      // Before ready the threshold is the handshake backstop; after ready,
      // ANY frame counts as liveness and the window is interval × limit.
      const windowMs = this.policy.heartbeatIntervalMs * this.policy.missedHeartbeatLimit;
      const threshold = incarnation.ready
        ? windowMs
        : Math.max(this.policy.handshakeTimeoutMs, windowMs);
      if (now - incarnation.lastFrameAt >= threshold && !incarnation.terminating) {
        incarnation.terminating = true;
        if (incarnation.ready) {
          void this.handleStall(record, incarnation).catch((error) => {
            this.faultLog("task_worker_stall_handler_failed", {
              workspace_id: record.workspace_id,
              run_id: record.run_id,
              worker_id: incarnation.worker_id,
              name: error instanceof Error ? error.name : "Error",
            });
          });
        } else {
          // Pre-ready silence is a handshake timeout: the start pipeline
          // owns the aftermath.
          incarnation.settleHandshake({ kind: "timeout" });
        }
      }
    }
    // E1 dequeue re-check: queued runs re-admit when pressure cleared
    // without a worker exit (e.g. disk space freed). Bounded + guarded.
    void this.pumpQueue().catch((error) => {
      this.faultLog("task_worker_dequeue_pump_failed", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Silent worker: mark stalled on the durable row, escalate, recovery state. */
  private async handleStall(record: WorkerRecord, incarnation: Incarnation): Promise<void> {
    await this.escalateAndJournal(record, incarnation, "hang", null);
  }

  /**
   * Shared escalation aftermath for a live-but-failed worker: (for stalls)
   * the durable stalled marker, then SIGTERM→SIGKILL through the terminate
   * seam, row killed, and ONLY THEN the `worker.crashed` journal event and
   * the guarded run-state write — so when the crash event is visible, the
   * ENTIRE aftermath (process reaped, row terminal, run marked) is already
   * durable. The crash event is therefore the aftermath COMPLETION marker;
   * the initiating handler only sets the synchronous terminating flag.
   */
  private async escalateAndJournal(
    record: WorkerRecord,
    incarnation: Incarnation,
    cause: "hang" | "worker_error" | "protocol_violation",
    errorClass: string | null,
  ): Promise<void> {
    try {
      if (cause === "hang") {
        // The stalled marker is the observable detection state (distinct
        // from killed, which the escalation below produces).
        try {
          this.deps.taskWorkers.updateState(
            record.workspace_id,
            record.run_id,
            incarnation.worker_id,
            "stalled",
          );
        } catch (error) {
          this.faultLog("task_worker_stall_row_failed", {
            workspace_id: record.workspace_id,
            run_id: record.run_id,
            worker_id: incarnation.worker_id,
            name: error instanceof Error ? error.name : "Error",
          });
        }
      }
      const exit = await this.terminateAndAwaitExit(incarnation);
      this.detachCurrent(record, incarnation);
      record.presence = "none";
      await this.finalizeRowState(
        record.workspace_id,
        record.run_id,
        incarnation.worker_id,
        "killed",
      );
      this.recordEvent(record, "worker.crashed", {
        worker_id: incarnation.worker_id,
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        cause,
        exit_code: exit.code,
        signal: exit.signal,
        error_class: errorClass,
        last_percent: incarnation.lastPercent,
      });
      this.markRunForRecovery(record);
      // Capacity freed (E1): the dequeue re-admits oldest-first.
      void this.pumpQueue().catch((pumpError) => {
        this.faultLog("task_worker_dequeue_pump_failed", {
          name: pumpError instanceof Error ? pumpError.name : "Error",
          message: pumpError instanceof Error ? pumpError.message : String(pumpError),
        });
      });
    } catch (error) {
      this.faultLog("task_worker_escalation_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: incarnation.worker_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  // ── Crash handling ─────────────────────────────────────────────────────────

  private onChildExit(
    record: WorkerRecord,
    incarnation: Incarnation,
    exit: TaskWorkerChildExit,
  ): void {
    for (const timer of incarnation.escalationTimers) clearTimeout(timer);
    incarnation.escalationTimers = [];
    for (const unsubscribe of incarnation.unsubscribers) unsubscribe();
    incarnation.unsubscribers = [];
    const wasCurrent = record.current === incarnation;
    this.detachCurrent(record, incarnation);
    if (incarnation.terminating) return; // the initiator owns the aftermath

    // Nobody initiated this death — a crash (D32: worker crash is a defined
    // event, never a silent loss). Exactly one handler wins the flag.
    incarnation.terminating = true;
    if (wasCurrent) record.presence = "none";
    try {
      this.deps.taskWorkers.updateState(
        record.workspace_id,
        record.run_id,
        incarnation.worker_id,
        "exited",
      );
    } catch (error) {
      this.faultLog("task_worker_exit_row_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: incarnation.worker_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
    this.recordEvent(record, "worker.crashed", {
      worker_id: incarnation.worker_id,
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      cause: "unexpected_exit",
      exit_code: exit.code,
      signal: exit.signal,
      error_class: null,
      last_percent: incarnation.lastPercent,
    });
    this.markRunForRecovery(record);
    // Capacity freed (E1): the dequeue re-admits oldest-first.
    void this.pumpQueue().catch((pumpError) => {
      this.faultLog("task_worker_dequeue_pump_failed", {
        name: pumpError instanceof Error ? pumpError.name : "Error",
        message: pumpError instanceof Error ? pumpError.message : String(pumpError),
      });
    });
  }

  // ── Termination ────────────────────────────────────────────────────────────

  /**
   * The chunk-1 escalation: shutdown frame → SIGTERM after shutdownGraceMs →
   * SIGKILL after killGraceMs more, every kill through the injectable kill
   * seam (S22 swaps in process-group kill). Resolves only once the exit is
   * observed — a stopped worker never leaves an orphan.
   */
  private async terminateAndAwaitExit(incarnation: Incarnation): Promise<TaskWorkerChildExit> {
    incarnation.terminating = true;
    incarnation.child.send({ v: WORKER_PROTOCOL_VERSION, type: "shutdown" });
    const kill = this.deps.killChild ?? ((child, signal) => child.kill(signal));
    incarnation.escalationTimers.push(
      setTimeout(() => kill(incarnation.child, "SIGTERM"), this.policy.shutdownGraceMs),
    );
    incarnation.escalationTimers.push(
      setTimeout(
        () => kill(incarnation.child, "SIGKILL"),
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

  // ── Run-state seam (guarded) ───────────────────────────────────────────────

  /**
   * Crash aftermath for the RUN: RECOVERY_REQUIRED — the defined non-terminal
   * state (D8) that says "a worker died mid-run; inspect the last checkpoint
   * and decide". FAILED would foreclose the D32 recovery policy; KEEPING the
   * old state would silently lose the crash. GUARDED: a terminal run is never
   * resurrected and an already-marked run is not re-written. The seam write
   * happens AFTER the crash evidence committed; a failure here is contained
   * (fault log) — chunk 3's reconciliation closes the gap class.
   */
  private markRunForRecovery(record: WorkerRecord): void {
    try {
      const current = this.deps.runControl.runState(record.workspace_id, record.run_id);
      if (current === null || isTerminalRunState(current) || current === "RECOVERY_REQUIRED") {
        return;
      }
      this.deps.runControl.applyRunState(record.workspace_id, record.run_id, "RECOVERY_REQUIRED");
    } catch (error) {
      this.faultLog("task_worker_run_state_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        target: "RECOVERY_REQUIRED",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** done aftermath for the RUN: SUCCEEDED through the seam (guarded). */
  private markRunSucceeded(record: WorkerRecord): void {
    try {
      const current = this.deps.runControl.runState(record.workspace_id, record.run_id);
      if (current === null || isTerminalRunState(current)) {
        return; // never resurrect a cancelled/failed run
      }
      this.deps.runControl.applyRunState(record.workspace_id, record.run_id, "SUCCEEDED");
    } catch (error) {
      this.faultLog("task_worker_run_state_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        target: "SUCCEEDED",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  /** Lease renewal on any healthy frame that carries no other row write. */
  private renewLease(record: WorkerRecord, incarnation: Incarnation): void {
    const at = this.now();
    try {
      this.deps.taskWorkers.recordHeartbeat(
        record.workspace_id,
        record.run_id,
        incarnation.worker_id,
        this.isoAt(at),
        this.isoAt(at + this.policy.leaseWindowMs),
      );
    } catch (error) {
      this.faultLog("task_worker_lease_write_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        worker_id: incarnation.worker_id,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  /**
   * Terminal row write that never clobbers an honest terminal state the exit
   * observer already recorded (a child can exit on its own inside the
   * escalation window).
   */
  private async finalizeRowState(
    workspaceId: string,
    runId: string,
    workerId: string,
    target: TaskWorkerState,
  ): Promise<void> {
    try {
      const row = this.deps.taskWorkers.getWorker(workspaceId, runId, workerId);
      if (row === null) return;
      if (row.state === "exited" || row.state === "killed") return;
      this.deps.taskWorkers.updateState(workspaceId, runId, workerId, target);
    } catch (error) {
      this.faultLog("task_worker_row_state_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        worker_id: workerId,
        target,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  private handleStderr(incarnation: Incarnation, chunk: string): void {
    // Bounded per-incarnation forwarding (G3): the sink owns redaction; the
    // supervisor guarantees a chatty child cannot flood it. Stderr is
    // diagnostic — it is NOT liveness and never journaled raw.
    if (incarnation.stderrBytes >= this.policy.stderrMaxBytes) return;
    const remaining = this.policy.stderrMaxBytes - incarnation.stderrBytes;
    const bounded = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
    // UTF-8 bytes, not UTF-16 code units — the bound is named in bytes.
    incarnation.stderrBytes += Buffer.byteLength(bounded, "utf8");
    this.deps.stderrSink?.write(bounded);
  }

  private detachCurrent(record: WorkerRecord, incarnation: Incarnation): void {
    if (record.current === incarnation) {
      record.current = null;
    }
  }

  private recordFor(workspaceId: string, runId: string): WorkerRecord {
    const key = workerRecordKey(workspaceId, runId);
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        workspace_id: workspaceId,
        run_id: runId,
        presence: "none",
        current: null,
        startPromise: null,
        providerId: null,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private snapshotOf(record: WorkerRecord, incarnation: Incarnation): TaskWorkerSnapshot {
    return {
      workspace_id: record.workspace_id,
      run_id: record.run_id,
      worker_id: incarnation.worker_id,
      pid: incarnation.pid ?? 0,
      state: "running",
    };
  }

  /**
   * Journal append through the SAME EventsService every other module uses, on
   * the RUN's stream (stream_id = run_id — the S13 run-stream semantics). The
   * STRICT variant (used inside atomic units) lets a journal failure roll the
   * whole unit back; the plain variant contains the failure instead (a
   * journaling gap must never take supervision down).
   */
  private recordEvent<
    T extends
      | "worker.started"
      | "worker.queued"
      | "worker.progress"
      | "worker.checkpoint"
      | "worker.crashed"
      | "worker.completed"
      | "worker.stopped",
  >(record: WorkerRecord, type: T, payload: Record<string, unknown>): void {
    try {
      this.appendEventStrict(record, type, payload);
    } catch (error) {
      this.faultLog("task_worker_event_failed", {
        workspace_id: record.workspace_id,
        run_id: record.run_id,
        event_type: type,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private appendEventStrict<
    T extends
      | "worker.started"
      | "worker.queued"
      | "worker.progress"
      | "worker.checkpoint"
      | "worker.crashed"
      | "worker.completed"
      | "worker.stopped",
  >(record: WorkerRecord, type: T, payload: Record<string, unknown>): void {
    this.deps.events.appendEvent({
      event_id: randomUUID(),
      stream_id: record.run_id,
      type,
      payload: payload as never,
      workspace_id: record.workspace_id,
      correlation_id: `task-worker:${record.workspace_id}:${record.run_id}`,
    });
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

  private isoAt(ms: number): string {
    return new Date(ms).toISOString();
  }
}
