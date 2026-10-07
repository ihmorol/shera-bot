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

/**
 * True when the error is the (workspace_id, idempotency_key) primary-key
 * conflict: two concurrent executions of the same key both missed the
 * fast-path receipt read, and the loser's INSERT hit the winner's committed
 * row. The node:sqlite driver surfaces it as ERR_SQLITE_ERROR naming the
 * violated constraint's qualified columns in the message; the caller must
 * then re-read and replay the winner's receipt instead of leaking the raw
 * constraint error (B5). BOTH qualified column names are required (C-4
 * hardening): a future differently-named unique index on this table must
 * never be misread as an idempotency race, and the messages name columns,
 * never user values, so no crafted input can forge a match.
 */
export function isReceiptKeyConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("command_receipts.workspace_id") &&
    error.message.includes("command_receipts.idempotency_key")
  );
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
