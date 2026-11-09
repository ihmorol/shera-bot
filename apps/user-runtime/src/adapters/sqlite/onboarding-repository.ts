/**
 * S30 — the onboarding state repository (D16, E43). One row per workspace:
 * the resumable interview progress. The rows are UI-progress records, not
 * product state: every EFFECT of an answer rides the shared settings command
 * surfaces (D16), never this table.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export type OnboardingStatusRow = "pending" | "completed" | "dismissed";

export interface OnboardingStateRow {
  workspace_id: string;
  status: OnboardingStatusRow;
  current_step: string | null;
  answers_json: string;
  updated_at: string;
}

export class OnboardingRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  get(workspaceId: string, exec?: DatabaseSync): OnboardingStateRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, status, current_step, answers_json, updated_at
         FROM onboarding_state
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as OnboardingStateRow | undefined;
    return row ?? null;
  }

  put(
    workspaceId: string,
    state: { status: OnboardingStatusRow; current_step: string | null; answers_json: string },
    updatedAt: string,
    exec?: DatabaseSync,
  ): OnboardingStateRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO onboarding_state
         (workspace_id, status, current_step, answers_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         status = excluded.status,
         current_step = excluded.current_step,
         answers_json = excluded.answers_json,
         updated_at = excluded.updated_at`,
    ).run(workspaceId, state.status, state.current_step, state.answers_json, updatedAt);
    const row = this.get(workspaceId, db);
    if (!row) {
      throw new Error("onboarding state: put reported success but the row is absent");
    }
    return row;
  }
}
