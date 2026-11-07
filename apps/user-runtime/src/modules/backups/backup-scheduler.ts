/**
 * The backup scheduler (S33 chunk 2; PRD §12 AC18, E11, D11, E37's
 * injected-clock discipline): the runtime OWNS the six-hour backup cadence
 * (D11 — the same runtime-owned scheduling the S28 ledger established; the
 * E27-recorded no-Redis posture applies — no BullMQ, no second datastore).
 *
 * The tick interval is PRD §12's six hours; every tick walks the SAME
 * takeSnapshot path the admin trigger uses (schedule + snapshot-time
 * integrity verification + the keep-seven retention), so a scheduled
 * snapshot and a triggered snapshot are indistinguishable in the ledger
 * apart from their `triggered_by` value.
 *
 * The clock is an INJECTED SEAM (`schedule(delayMs, fn)` returning a cancel
 * handle; the default an unref'd interval timer) — tests drive `tick()`
 * directly against the fake clock, never wall-clock sleeps. The interval
 * anchors at start(): a restarted runtime's cadence re-anchors at ITS boot
 * (the ledger's taken_at instants are the truth; a backup catch-up policy —
 * unlike E5's trigger occurrences — is not recorded anywhere, so none is
 * invented here: the next tick simply fires six hours after boot, G4).
 *
 * A failed tick never stops the schedule: the failure is fault-logged and
 * the next tick fires on time (G4 — the cadence never silently stalls).
 */
import {
  BackupServiceError,
  SIX_HOURS_MS,
  type BackupService,
  type TakeSnapshotResult,
} from "./backup-service.ts";

export type ScheduleClock = (delayMs: number, fn: () => void) => () => void;

/** The production clock: an unref'd interval (never holds the process open). */
export const defaultScheduleClock: ScheduleClock = (delayMs, fn) => {
  const timer = setInterval(fn, delayMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

export interface BackupSchedulerDeps {
  /** The backup service the ticks drive (the ONE snapshot path). */
  service: Pick<BackupService, "takeSnapshot">;
  /** The tick interval. Default: PRD §12's six hours. */
  intervalMs?: number;
  /** The injected clock seam. Default: the unref'd interval timer. */
  schedule?: ScheduleClock | undefined;
  /** The redacted fault sink (a failed tick's log leg, G3). */
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export class BackupScheduler {
  private readonly intervalMs: number;
  private readonly scheduleClock: ScheduleClock;
  private readonly service: Pick<BackupService, "takeSnapshot">;
  private readonly logFault: (event: string, fields: Record<string, unknown>) => void;
  private cancelTick: (() => void) | null = null;

  constructor(deps: BackupSchedulerDeps) {
    this.service = deps.service;
    this.intervalMs = deps.intervalMs ?? SIX_HOURS_MS;
    this.scheduleClock = deps.schedule ?? defaultScheduleClock;
    this.logFault = deps.logFault ?? (() => {});
  }

  /** Start the six-hour cadence. A second start while running is a typed
   * refusal — never a second concurrent tick loop. */
  start(): void {
    if (this.cancelTick !== null) {
      throw new BackupServiceError(
        "BACKUP_SCHEDULER_ALREADY_RUNNING",
        "the backup schedule is already running",
      );
    }
    this.cancelTick = this.scheduleClock(this.intervalMs, () => {
      void this.tick();
    });
  }

  /** Stop the cadence (idempotent). */
  stop(): void {
    if (this.cancelTick !== null) {
      this.cancelTick();
      this.cancelTick = null;
    }
  }

  /** One scheduled tick: one snapshot through the service's recorded path.
   * The clock seam's callback and the tests both drive this. The tick is
   * TOTAL — an operational failure is the typed false result (fault-logged),
   * and even an unexpected throw is contained into the honest false result
   * so the interval callback can never produce an unhandled rejection: the
   * six-hour cadence never silently stalls. */
  async tick(): Promise<TakeSnapshotResult> {
    try {
      const result = await this.service.takeSnapshot({ triggeredBy: "schedule" });
      if (!result.taken) {
        this.logFault("backup_snapshot_failed", {
          snapshot_id: result.snapshot_id,
          stage: `schedule:${result.reason}`,
          reason: result.detail.slice(0, 300),
        });
      }
      return result;
    } catch (error) {
      const detail =
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      this.logFault("backup_tick_failed", {
        name: error instanceof Error ? error.name : "Error",
        reason: detail,
      });
      return {
        taken: false,
        snapshot_id: "unknown",
        taken_at: new Date().toISOString(),
        reason: "tick_failed",
        detail,
        snapshot_dir: null,
      };
    }
  }
}
