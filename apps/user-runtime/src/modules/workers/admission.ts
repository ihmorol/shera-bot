/**
 * TaskWorker admission gate (S16 chunk 2) — E1 admission control in front of
 * TaskWorkerSupervisor.startWorker, following the S12 policy-object pattern.
 *
 * The gate answers ONE question: may another worker process start right now?
 * Limits (AdmissionPolicy):
 * - maxConcurrentWorkers: process count, counted over LIVE task_workers rows
 *   (rows are inserted before spawn and finalized on exit — the durable truth,
 *   D10), NOT an in-memory approximation.
 * - maxWorkerMemoryBytes / maxTotalWorkersMemoryBytes: per-worker and summed
 *   address-space budgets. maxWorkerMemoryBytes is NOT merely counted — it is
 *   ALSO handed to the spawn request as a REAL kernel limit (prlimit --as,
 *   see worker-process-spawn.ts); this gate's memory check is the SCHEDULING
 *   decision ("does the sum still fit"), the kernel limit is the ENFORCEMENT.
 * - minFreeDiskBytes: free space on the runtime data dir, probed via
 *   node:fs statfsSync before admitting (injectable for tests).
 * - maxConcurrentRunsPerProvider: live workers per provider id, taken from
 *   the run spec's provider snapshot placeholder (in-process spec knowledge —
 *   chunk 3's reconciliation may persist it on rows; documented prototype
 *   scope).
 * - maxWorkerProcesses: per-worker kernel process cap (prlimit --nproc) — a
 *   kernel ENFORCEMENT parameter, not a scheduling decision, so the gate does
 *   not count against it; validation still demands a sane value (G4).
 *
 * Enforcement contract (the never-kill guarantee): the gate only refuses NEW
 * work. A limit reached NEVER touches running workers, their leases, or
 * their children — the supervisor turns a refusal into a durable QUEUED
 * (D8) marking and re-admits oldest-first when capacity frees (bounded
 * internal dequeue, prototype-grade re-check loop, documented there).
 *
 * Validation (G4 honesty): a garbage policy is a typed STARTUP failure
 * (AdmissionPolicyError at construction), naming the offending field — never
 * a silent fallback to unlimited. A disk floor without a way to measure it
 * (no dataDir, no probe) is the same class of failure, not a skipped check.
 *
 * Governing records: E1, D27, D32, D8.
 */
import { statfsSync } from "node:fs";

/** E1 admission limits. All fields are required — no implicit unlimited. */
export interface AdmissionPolicy {
  /** Max LIVE worker processes this runtime admits (durable row count). */
  maxConcurrentWorkers: number;
  /** Per-worker address-space budget — kernel-enforced via prlimit --as. */
  maxWorkerMemoryBytes: number;
  /** Sum of live workers' per-worker budgets the runtime admits. */
  maxTotalWorkersMemoryBytes: number;
  /** Free-bytes floor on the data dir, probed before admitting. */
  minFreeDiskBytes: number;
  /** Max live workers per provider id (from the run spec's snapshot). */
  maxConcurrentRunsPerProvider: number;
  /** Per-worker kernel process cap (prlimit --nproc); enforcement-only. */
  maxWorkerProcesses: number;
}

/**
 * The composition's default admission policy (S16 chunk 3), used when a
 * worker harness is configured without an explicit policy. Values are
 * PROTOTYPE defaults, chosen so a node-based worker child boots under the
 * kernel limits on an ordinary dev box (RLIMIT_NPROC is enforced per real
 * user id — a heavier host raises maxWorkerProcesses through the
 * composition's programmatic policy override):
 *
 *   maxConcurrentWorkers            4        (the process count)
 *   maxWorkerMemoryBytes            2 GiB    (prlimit --as per worker)
 *   maxTotalWorkersMemoryBytes      8 GiB    (the summed budget)
 *   minFreeDiskBytes                0        (no disk floor by default)
 *   maxConcurrentRunsPerProvider    2
 *   maxWorkerProcesses              4096     (prlimit --nproc per worker)
 */
export const DEFAULT_WORKER_ADMISSION_POLICY: AdmissionPolicy = {
  maxConcurrentWorkers: 4,
  maxWorkerMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxTotalWorkersMemoryBytes: 8 * 1024 * 1024 * 1024,
  minFreeDiskBytes: 0,
  maxConcurrentRunsPerProvider: 2,
  maxWorkerProcesses: 4_096,
};

/** Machine-readable queued-reason codes (chunk 3 renders these for the UI). */
export type WorkerQueuedReasonCode =
  "worker_limit_reached" | "memory_limit" | "disk_pressure" | "provider_concurrency";

/** The machine-readable refusal: which limit, what the ceiling is, what the
 * current usage was at decision time. null where the unit differs (e.g. a
 * count limit carries a count current; null fields are validated by the
 * worker.queued payload schema). */
export interface WorkerQueuedReason {
  code: WorkerQueuedReasonCode;
  limit: number | null;
  current: number | null;
}

export interface AdmissionDecision {
  admitted: boolean;
  reason: WorkerQueuedReason | null;
  /** Human text for the UI/log (never secrets, G3). */
  message: string | null;
}

/** Where the gate reads live state from (the supervisor wires the repos). */
export interface AdmissionCounters {
  /** LIVE worker rows across ALL workspaces (the durable process count). */
  liveWorkerCount(): number;
  /**
   * LIVE workers attributed to one provider id (in-process spec knowledge —
   * the provider snapshot lives on the run's worker spec; the supervisor
   * attributes its records). Optional only for policy-validation tests.
   */
  liveWorkerCountForProvider?(providerId: string): number;
}

export interface AdmissionGateOptions {
  /** Injected probe; takes precedence over the statfs default. */
  probeFreeDiskBytes?: (() => number | null) | undefined;
  /** The dir the default statfs probe measures (the runtime data dir). */
  dataDir?: string | undefined;
}

/** What the gate exposes for read models (supervisor.admissionPressure). */
export interface AdmissionGatePressure {
  limits: AdmissionPolicy;
  liveWorkers: number;
  projectedTotalWorkersMemoryBytes: number;
  freeDiskBytes: number | null;
}

/** Typed startup failure for a garbage policy (G4). */
export class AdmissionPolicyError extends Error {
  readonly code = "ADMISSION_POLICY_INVALID" as const;
  readonly category = "state" as const;
  readonly field: string;

  constructor(field: string, constraint: string) {
    super(`ADMISSION_POLICY_INVALID: ${field} ${constraint}`);
    this.name = "AdmissionPolicyError";
    this.field = field;
  }
}

function requireInt(policy: AdmissionPolicy, field: keyof AdmissionPolicy, min: number): number {
  const value = policy[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new AdmissionPolicyError(field, `must be an integer >= ${min}`);
  }
  return value;
}

/** Validate an admission policy eagerly (typed STARTUP failure, G4). */
export function validateAdmissionPolicy(policy: AdmissionPolicy): void {
  requireInt(policy, "maxConcurrentWorkers", 1);
  requireInt(policy, "maxWorkerMemoryBytes", 1);
  requireInt(policy, "maxTotalWorkersMemoryBytes", 1);
  requireInt(policy, "minFreeDiskBytes", 0);
  requireInt(policy, "maxConcurrentRunsPerProvider", 1);
  requireInt(policy, "maxWorkerProcesses", 1);
  if (policy.maxTotalWorkersMemoryBytes < policy.maxWorkerMemoryBytes) {
    throw new AdmissionPolicyError(
      "maxTotalWorkersMemoryBytes",
      "must admit at least ONE worker's own budget (>= maxWorkerMemoryBytes)",
    );
  }
}

export interface AdmissionCheckInput {
  /** Provider id from the run spec's provider snapshot; null = unattributed. */
  providerId: string | null;
}

export interface AdmissionGate {
  /** The validated policy this gate enforces (read for pressure + limits). */
  readonly policy: AdmissionPolicy;
  check(input: AdmissionCheckInput): AdmissionDecision;
  pressure(): AdmissionGatePressure;
}

export class TaskWorkerAdmissionGate implements AdmissionGate {
  readonly policy: AdmissionPolicy;
  private readonly counters: AdmissionCounters;
  private readonly probeFreeDiskBytes: () => number | null;

  constructor(
    policy: AdmissionPolicy,
    counters: AdmissionCounters,
    options: AdmissionGateOptions = {},
  ) {
    validateAdmissionPolicy(policy); // typed startup failure (G4)
    this.policy = { ...policy };
    this.counters = counters;
    if (options.probeFreeDiskBytes !== undefined) {
      this.probeFreeDiskBytes = options.probeFreeDiskBytes;
    } else if (options.dataDir !== undefined && policy.minFreeDiskBytes > 0) {
      const dataDir = options.dataDir;
      this.probeFreeDiskBytes = () => {
        try {
          const stats = statfsSync(dataDir);
          return stats.bavail * stats.bsize;
        } catch {
          // A failed probe is an observability gap, not pressure evidence —
          // skip the check rather than block all work (documented fail-open).
          return null;
        }
      };
    } else if (policy.minFreeDiskBytes > 0) {
      throw new AdmissionPolicyError(
        "minFreeDiskBytes",
        "demands a disk floor but no dataDir or probe was given to measure it",
      );
    } else {
      this.probeFreeDiskBytes = () => null;
    }
  }

  check(input: AdmissionCheckInput): AdmissionDecision {
    // Order: environment (disk) → process count → memory sum → provider.
    if (this.policy.minFreeDiskBytes > 0) {
      const free = this.probeFreeDiskBytes();
      if (free !== null && free < this.policy.minFreeDiskBytes) {
        return {
          admitted: false,
          reason: { code: "disk_pressure", limit: this.policy.minFreeDiskBytes, current: free },
          message:
            `disk pressure: ${free} free bytes on the data dir, ` +
            `floor ${this.policy.minFreeDiskBytes}; run queued`,
        };
      }
    }

    const live = this.counters.liveWorkerCount();
    if (live + 1 > this.policy.maxConcurrentWorkers) {
      return {
        admitted: false,
        reason: {
          code: "worker_limit_reached",
          limit: this.policy.maxConcurrentWorkers,
          current: live,
        },
        message:
          `worker limit reached: ${live} of ${this.policy.maxConcurrentWorkers} ` +
          "concurrent workers in use; run queued",
      };
    }

    const projectedTotal = (live + 1) * this.policy.maxWorkerMemoryBytes;
    if (projectedTotal > this.policy.maxTotalWorkersMemoryBytes) {
      return {
        admitted: false,
        reason: {
          code: "memory_limit",
          limit: this.policy.maxTotalWorkersMemoryBytes,
          current: live * this.policy.maxWorkerMemoryBytes,
        },
        message:
          `memory limit: ${live} live workers at ${this.policy.maxWorkerMemoryBytes} ` +
          `bytes each would exceed the ${this.policy.maxTotalWorkersMemoryBytes} ` +
          "byte total budget; run queued",
      };
    }

    if (input.providerId !== null) {
      // Per-provider counting is in-process spec knowledge (see header); the
      // supervisor attributes its live records through the counters seam so
      // the gate owns no supervisor internals.
      const providerLive = this.counters.liveWorkerCountForProvider?.(input.providerId) ?? 0;
      if (providerLive + 1 > this.policy.maxConcurrentRunsPerProvider) {
        return {
          admitted: false,
          reason: {
            code: "provider_concurrency",
            limit: this.policy.maxConcurrentRunsPerProvider,
            current: providerLive,
          },
          message:
            `provider concurrency: ${providerLive} of ` +
            `${this.policy.maxConcurrentRunsPerProvider} live workers on provider ` +
            `${input.providerId}; run queued`,
        };
      }
    }

    return { admitted: true, reason: null, message: null };
  }

  pressure(): AdmissionGatePressure {
    const liveWorkers = this.counters.liveWorkerCount();
    return {
      limits: { ...this.policy },
      liveWorkers,
      projectedTotalWorkersMemoryBytes: liveWorkers * this.policy.maxWorkerMemoryBytes,
      freeDiskBytes: this.probeFreeDiskBytes(),
    };
  }
}
