/**
 * Conversations aggregate repository (S07; E12, AC5) — the only place
 * conversations SQL lives.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL: every method takes workspace_id and
 * every SQL statement filters or keys rows by it. A foreign workspace can
 * neither read nor write another workspace's rows; the primary key is
 * (workspace_id, id) so the same conversation id may coexist in different
 * workspaces without cross-talk. A static contract test asserts no statement
 * in this file omits the workspace predicate.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface ConversationRow {
  id: string;
  workspace_id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class ConversationsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  create(row: ConversationRow, exec?: DatabaseSync): ConversationRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO conversations (id, workspace_id, title, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.workspace_id, row.title, row.revision, row.created_at, row.updated_at);
    return row;
  }

  findById(
    workspaceId: string,
    conversationId: string,
    exec?: DatabaseSync,
  ): ConversationRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT id, workspace_id, title, revision, created_at, updated_at
         FROM conversations
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, conversationId) as ConversationRow | undefined;
    return row ?? null;
  }

  list(workspaceId: string, exec?: DatabaseSync): ConversationRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT id, workspace_id, title, revision, created_at, updated_at
         FROM conversations
         WHERE workspace_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(workspaceId) as unknown as ConversationRow[];
  }

  /**
   * Optimistic rename with expected revision: returns the updated row, or
   * null when the row does not exist in THIS workspace or the revision does
   * not match (no row is changed either way).
   */
  rename(
    workspaceId: string,
    conversationId: string,
    expectedRevision: number,
    title: string,
    updatedAt: string,
    exec?: DatabaseSync,
  ): ConversationRow | null {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE conversations
         SET title = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .run(title, updatedAt, workspaceId, conversationId, expectedRevision);
    if (result.changes === 0) {
      return null;
    }
    return this.findById(workspaceId, conversationId, db);
  }

  /**
   * Returns true when the row existed in THIS workspace and was removed;
   * a foreign workspace's row is untouched.
   */
  remove(workspaceId: string, conversationId: string, exec?: DatabaseSync): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare("DELETE FROM conversations WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, conversationId);
    return result.changes > 0;
  }

  countInWorkspace(workspaceId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?")
      .get(workspaceId) as { n: number | bigint } | undefined;
    const n = row?.n;
    return typeof n === "bigint" ? Number(n) : (n ?? 0);
  }
}
