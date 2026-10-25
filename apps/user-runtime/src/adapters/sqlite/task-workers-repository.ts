/**
 * Task workers repository (S16 chunk 1; D32 layer 3, D10) — the only place
 * task-worker SQL lives.
 *
 * One row per supervised worker incarnation (the v8 `task_workers` table),
 * keyed (workspace_id, run_id, worker_id). The row is the LEASE DURABILITY
 * D32 names: `lease_expires_at` is renewed on every healthy frame and is what
 * a future recovery slice reads to find non-terminal work after a gateway
 * restart; `last_progress_json` keeps the latest progress frame so a crash
 * never loses the "where was the work" answer (D10: progress and checkpoints
 * are persisted, never only in process memory). The run's existence is
 * validated by the writer (the operations repositories own the run row), so
 * no FOREIGN KEY is declared — the v4/v5/v6 discipline.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/** The task-state lifecycle of one worker incarnation (D32 layer 3). */
export type TaskWorkerState = "starting" | "running" | "stalled" | "exited" | "killed";

/** Worker states that still describe a live (or possibly-live) process. */
export const LIVE_TASK_WORKER_STATES: readonly TaskWorkerState[] = [
  "starting",
  "running",
  "stalled",
];

export interface TaskWorkerRow {
  workspace_id: string;
  run_id: string;
  /** Fresh per incarnation; durable identity is (workspace_id, run_id). */
  worker_id: string;
  pid: number | null;
  state: TaskWorkerState;
  heartbeat_at: string | null;
  lease_expires_at: string;
  /** The latest progress frame ({ percent, text } today); opaque to this repo. */
  last_progress_json: string | null;
  started_at: string;
}

export class TaskWorkersRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  insertWorker(row: TaskWorkerRow, exec?: DatabaseSync): TaskWorkerRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO task_workers
         (workspace_id, run_id, worker_id, pid, state, heartbeat_at,
          lease_expires_at, last_progress_json, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workspace_id,
      row.run_id,
      row.worker_id,
      row.pid,
      row.state,
      row.heartbeat_at,
      row.lease_expires_at,
      row.last_progress_json,
      row.started_at,
    );
    return row;
  }

  getWorker(
    workspaceId: string,
    runId: string,
    workerId: string,
    exec?: DatabaseSync,
  ): TaskWorkerRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, run_id, worker_id, pid, state, heartbeat_at,
                lease_expires_at, last_progress_json, started_at
         FROM task_workers
         WHERE workspace_id = ? AND run_id = ? AND worker_id = ?`,
      )
      .get(workspaceId, runId, workerId) as TaskWorkerRow | undefined;
    return row ?? null;
  }

  /** Every worker incarnation of one run, oldest first. */
  listByRun(workspaceId: string, runId: string, exec?: DatabaseSync): TaskWorkerRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, run_id, worker_id, pid, state, heartbeat_at,
                lease_expires_at, last_progress_json, started_at
         FROM task_workers
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY started_at, worker_id`,
      )
      .all(workspaceId, runId) as unknown as TaskWorkerRow[];
  }

  /** Every live (starting/running/stalled) worker of one workspace. */
  listLive(workspaceId: string, exec?: DatabaseSync): TaskWorkerRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, run_id, worker_id, pid, state, heartbeat_at,
                lease_expires_at, last_progress_json, started_at
         FROM task_workers
         WHERE workspace_id = ? AND state IN ('starting', 'running', 'stalled')
         ORDER BY started_at, worker_id`,
      )
      .all(workspaceId) as unknown as TaskWorkerRow[];
  }

  setPid(
    workspaceId: string,
    runId: string,
    workerId: string,
    pid: number,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `UPDATE task_workers SET pid = ? WHERE workspace_id = ? AND run_id = ? AND worker_id = ?`,
    ).run(pid, workspaceId, runId, workerId);
  }

  updateState(
    workspaceId: string,
    runId: string,
    workerId: string,
    state: TaskWorkerState,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `UPDATE task_workers SET state = ? WHERE workspace_id = ? AND run_id = ? AND worker_id = ?`,
    ).run(state, workspaceId, runId, workerId);
  }

  /**
   * One heartbeat (or any healthy frame): renew heartbeat_at and the lease.
   * The lease window arithmetic belongs to the caller (the supervisor's
   * policy); this repo only persists the two stamps.
   */
  recordHeartbeat(
    workspaceId: string,
    runId: string,
    workerId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `UPDATE task_workers
       SET heartbeat_at = ?, lease_expires_at = ?
       WHERE workspace_id = ? AND run_id = ? AND worker_id = ?`,
    ).run(heartbeatAt, leaseExpiresAt, workspaceId, runId, workerId);
  }

  /**
   * One progress frame: persist the latest progress JSON AND renew the lease
   * in the SAME statement, so a crash between "progress observed" and "lease
   * renewed" is unrepresentable (D10).
   */
  recordProgress(
    workspaceId: string,
    runId: string,
    workerId: string,
    progressJson: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `UPDATE task_workers
       SET last_progress_json = ?, heartbeat_at = ?, lease_expires_at = ?
       WHERE workspace_id = ? AND run_id = ? AND worker_id = ?`,
    ).run(progressJson, heartbeatAt, leaseExpiresAt, workspaceId, runId, workerId);
  }
}
