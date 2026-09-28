/**
 * Command receipts repository (S07; AC6, D23 rule 6) — the only place
 * command-receipt SQL lives.
 *
 * One row per accepted command, keyed by (workspace_id, idempotency_key) and
 * written in the SAME transaction as the command's effects: a repeated key
 * replays the recorded result instead of duplicating effects, and a crashed
 * attempt leaves no receipt without its effect (and no effect without its
 * receipt).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

export interface CommandReceiptRow {
  workspace_id: string;
  idempotency_key: string;
  command_type: string;
  result_json: string;
  created_at: string;
}

export class CommandReceiptsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  findById(
    workspaceId: string,
    idempotencyKey: string,
    exec?: DatabaseSync,
  ): CommandReceiptRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT workspace_id, idempotency_key, command_type, result_json, created_at
         FROM command_receipts
         WHERE workspace_id = ? AND idempotency_key = ?`,
      )
      .get(workspaceId, idempotencyKey) as CommandReceiptRow | undefined;
    return row ?? null;
  }

  create(row: CommandReceiptRow, exec?: DatabaseSync): CommandReceiptRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO command_receipts
         (workspace_id, idempotency_key, command_type, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.workspace_id, row.idempotency_key, row.command_type, row.result_json, row.created_at);
    return row;
  }

  countInWorkspace(workspaceId: string, exec?: DatabaseSync): number {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE workspace_id = ?")
      .get(workspaceId) as { n: number | bigint } | undefined;
    const n = row?.n;
    return typeof n === "bigint" ? Number(n) : (n ?? 0);
  }
}
