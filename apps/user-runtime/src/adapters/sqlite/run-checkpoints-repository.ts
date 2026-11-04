/**
 * Run checkpoints repository (S31 chunk 1; PRD §13, D33) — the only place
 * run-checkpoint SQL lives.
 *
 * One row per taken semantic checkpoint (the v20 `run_checkpoints` table),
 * keyed (workspace_id, task_id, step_id, checkpoint_version) — append-only;
 * retaking a step appends a NEW version rather than overwriting the taken
 * record (recovery evidence is never rewritten). The row is the durable D33
 * field set; the task stream's `checkpoint.taken` envelope (journalled by the
 * CheckpointService in the SAME transaction) is the marker the UI timeline
 * renders. The run's existence is validated by the writer, so no FOREIGN KEY
 * is declared — the v4/v5/v6 discipline.
 *
 * G3: every JSON column holds the service-validated bounded shape — the
 * repository never writes an unvalidated payload.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/** The exact D33 column set (the migration and the repository agree). */
export const CHECKPOINT_COLUMNS: readonly string[] = [
  "workspace_id",
  "task_id",
  "step_id",
  "checkpoint_version",
  "step_kind",
  "completed_actions_json",
  "pending_action_json",
  "artifact_refs_json",
  "provider_usage_json",
  "lease_state_json",
  "approval_state_json",
  "external_effect_state_json",
  "resume_instructions",
  "created_at",
];

export interface RunCheckpointRow {
  workspace_id: string;
  task_id: string;
  step_id: string;
  checkpoint_version: number;
  step_kind: string;
  completed_actions_json: string;
  pending_action_json: string | null;
  artifact_refs_json: string;
  provider_usage_json: string | null;
  lease_state_json: string | null;
  approval_state_json: string | null;
  external_effect_state_json: string | null;
  resume_instructions: string;
  created_at: string;
}

export class RunCheckpointsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  insert(row: RunCheckpointRow, exec?: DatabaseSync): RunCheckpointRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO run_checkpoints
         (workspace_id, task_id, step_id, checkpoint_version, step_kind,
          completed_actions_json, pending_action_json, artifact_refs_json,
          provider_usage_json, lease_state_json, approval_state_json,
          external_effect_state_json, resume_instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.workspace_id,
      row.task_id,
      row.step_id,
      row.checkpoint_version,
      row.step_kind,
      row.completed_actions_json,
      row.pending_action_json,
      row.artifact_refs_json,
      row.provider_usage_json,
      row.lease_state_json,
      row.approval_state_json,
      row.external_effect_state_json,
      row.resume_instructions,
      row.created_at,
    );
    return row;
  }

  countForTask(workspaceId: string, taskId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM run_checkpoints WHERE workspace_id = ? AND task_id = ?`,
      )
      .get(workspaceId, taskId) as { n: number | bigint };
    return typeof row.n === "bigint" ? Number(row.n) : row.n;
  }

  findByStep(
    workspaceId: string,
    taskId: string,
    stepId: string,
    exec?: DatabaseSync,
  ): RunCheckpointRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS.join(", ")}
         FROM run_checkpoints
         WHERE workspace_id = ? AND task_id = ? AND step_id = ?
         ORDER BY checkpoint_version DESC
         LIMIT 1`,
      )
      .get(workspaceId, taskId, stepId) as RunCheckpointRow | undefined;
    return row ?? null;
  }

  /** One task's checkpoints, ascending by checkpoint_version. */
  listForTask(workspaceId: string, taskId: string): RunCheckpointRow[] {
    const db = this.tx.connection();
    return db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS.join(", ")}
         FROM run_checkpoints
         WHERE workspace_id = ? AND task_id = ?
         ORDER BY checkpoint_version, step_id`,
      )
      .all(workspaceId, taskId) as unknown as RunCheckpointRow[];
  }

  latestForTask(workspaceId: string, taskId: string): RunCheckpointRow | null {
    const db = this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${CHECKPOINT_COLUMNS.join(", ")}
         FROM run_checkpoints
         WHERE workspace_id = ? AND task_id = ?
         ORDER BY checkpoint_version DESC, step_id DESC
         LIMIT 1`,
      )
      .get(workspaceId, taskId) as RunCheckpointRow | undefined;
    return row ?? null;
  }
}
