/**
 * Credit ledger repository (S24 chunk 1; D20, D21, D48, AC9, E12, G3) — the
 * only place credit-ledger SQL lives, over the v20 STRICT tables.
 *
 * Writer-side rules keep the ledger honest:
 *  - credit_transaction is APPEND-ONLY (AC9): this module has no UPDATE and
 *    no DELETE statement for it; a correction is a NEW 'adjustment' row
 *    whose corrects_transaction_id names the corrected row. The original
 *    row is never edited.
 *  - the account is THE single account-level balance (D21): one row per
 *    workspace; available is DERIVED (granted − charged − reserved) and
 *    never stored, so the summary cannot drift from the movements.
 *  - every read and write is workspace-scoped (E12); reservation/settlement/
 *    release writers validate the referenced account row in the same
 *    transaction (the v4/v5 discipline — no FOREIGN KEY is declared).
 *  - no secret ever enters a ledger row (G3): provider references, unit
 *    counts, ids, and timestamps only.
 */
import type { SqliteExec, SqliteTransactions } from "./transactions.ts";

/** The append-only movement vocabulary (the migration's CHECK set). */
export type CreditEntryType =
  "grant" | "reservation_hold" | "settlement_charge" | "reservation_release" | "adjustment";

/** The reservation lifecycle (the S02 contract's closed set). */
export type CreditReservationStatus = "reserved" | "settled" | "released";

/** The release reason vocabulary (the S02 contract's closed set). */
export type CreditReleaseReason = "provider_failure" | "task_cancelled" | "unused_estimate";

/** Provider origin (D20: custom providers never consume Shera credits). */
export type CreditProviderOrigin = "platform" | "user";

/** The single account-level balance row (D21). */
export interface CreditAccountRow {
  workspace_id: string;
  granted_units: number;
  charged_units: number;
  reserved_units: number;
  created_at: string;
  updated_at: string;
}

/** One append-only movement row (AC9). */
export interface CreditTransactionRow {
  workspace_id: string;
  transaction_id: string;
  entry_type: CreditEntryType;
  amount_units: number;
  task_id: string | null;
  reservation_id: string | null;
  related_id: string | null;
  corrects_transaction_id: string | null;
  created_at: string;
}

/** One recorded model-call usage row (D20; custom providers charge 0). */
export interface CreditUsageRecordRow {
  workspace_id: string;
  usage_id: string;
  task_id: string;
  provider_id: string;
  model: string;
  provider_origin: CreditProviderOrigin;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  charged_units: number;
  created_at: string;
}

/** One bounded estimate row (the reservation's derivation evidence). */
export interface CostEstimateRow {
  workspace_id: string;
  estimate_id: string;
  task_id: string;
  provider_id: string;
  model: string;
  estimated_units: number;
  basis: string;
  created_at: string;
}

/** One reservation hold row. */
export interface CreditReservationRow {
  workspace_id: string;
  reservation_id: string;
  task_id: string;
  trigger_id: string | null;
  estimate_id: string | null;
  estimated_units: number;
  status: CreditReservationStatus;
  created_at: string;
  settled_at: string | null;
  released_at: string | null;
}

/** One settlement row (actual usage charged against a reservation). */
export interface CreditSettlementRow {
  workspace_id: string;
  settlement_id: string;
  reservation_id: string;
  task_id: string;
  actual_units: number;
  settled_at: string;
}

/** One release row (unused remainder, provider failure, or cancellation). */
export interface CreditReleaseRow {
  workspace_id: string;
  release_id: string;
  reservation_id: string;
  task_id: string;
  released_units: number;
  reason: CreditReleaseReason;
  released_at: string;
}

export interface CreditAccountInsert {
  workspace_id: string;
  created_at: string;
}

export interface CreditGrantInput {
  workspace_id: string;
  transaction_id: string;
  amount_units: number;
  related_id: string | null;
  created_at: string;
}

export interface CreditReservationInsert {
  workspace_id: string;
  reservation_id: string;
  task_id: string;
  trigger_id: string | null;
  /** The held units — the reservation's own truth, independent of whether a
   * cost_estimate detail row accompanies it. */
  estimated_units: number;
  estimate: CostEstimateRow | null;
  created_at: string;
}

export interface CreditUsageInsert {
  workspace_id: string;
  usage_id: string;
  task_id: string;
  provider_id: string;
  model: string;
  provider_origin: CreditProviderOrigin;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  charged_units: number;
  created_at: string;
}

export class CreditLedgerRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CreditLedgerRepositoryError";
    this.code = code;
  }
}

export class CreditLedgerRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // ── Account (the single D21 balance) ───────────────────────────────────────

  /** The workspace's account row, or null when no account exists yet. */
  findAccount(workspaceId: string, exec?: SqliteExec): CreditAccountRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM credit_account WHERE workspace_id = ?")
      .get(workspaceId) as Record<string, unknown> | undefined;
    return row ? this.toAccount(row) : null;
  }

  /** Create the workspace's account row (idempotent — the D21 singleton). */
  insertAccount(input: CreditAccountInsert, exec?: SqliteExec): CreditAccountRow {
    const run = (target: SqliteExec) => {
      const existing = this.findAccount(input.workspace_id, target);
      if (existing) return existing;
      target
        .prepare(
          `INSERT INTO credit_account (workspace_id, granted_units, charged_units, reserved_units, created_at, updated_at)
           VALUES (?, 0, 0, 0, ?, ?)`,
        )
        .run(input.workspace_id, input.created_at, input.created_at);
      const created = this.findAccount(input.workspace_id, target);
      if (!created) throw new CreditLedgerRepositoryError("ACCOUNT_INSERT_FAILED", "no row");
      return created;
    };
    return exec ? run(exec) : this.tx.transaction(run);
  }

  /**
   * Apply one movement's account deltas. The caller has already validated
   * the movement against the derived available balance — this writer only
   * applies the typed delta (granted/charged/reserved never go negative;
   * the CHECKs make a wrong-sign delta unrepresentable).
   */
  applyAccountDelta(
    workspaceId: string,
    delta: { granted?: number; charged?: number; reserved?: number },
    updatedAt: string,
    exec: SqliteExec,
  ): void {
    exec
      .prepare(
        `UPDATE credit_account
         SET granted_units = granted_units + ?,
             charged_units = charged_units + ?,
             reserved_units = reserved_units + ?,
             updated_at = ?
         WHERE workspace_id = ?`,
      )
      .run(delta.granted ?? 0, delta.charged ?? 0, delta.reserved ?? 0, updatedAt, workspaceId);
  }

  // ── credit_transaction (append-only, AC9) ──────────────────────────────────

  /** Append ONE movement row. No update path exists (AC9). */
  insertTransaction(row: CreditTransactionRow, exec?: SqliteExec): CreditTransactionRow {
    const run = (target: SqliteExec) => {
      target
        .prepare(
          `INSERT INTO credit_transaction
             (workspace_id, transaction_id, entry_type, amount_units, task_id, reservation_id, related_id, corrects_transaction_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspace_id,
          row.transaction_id,
          row.entry_type,
          row.amount_units,
          row.task_id,
          row.reservation_id,
          row.related_id,
          row.corrects_transaction_id,
          row.created_at,
        );
      return row;
    };
    return exec ? run(exec) : this.tx.transaction(run);
  }

  /** The workspace's movement rows, newest first. */
  listTransactions(workspaceId: string, limit = 200): CreditTransactionRow[] {
    const rows = this.tx
      .connection()
      .prepare(
        `SELECT * FROM credit_transaction WHERE workspace_id = ?
         ORDER BY created_at DESC, transaction_id DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.toTransaction(row));
  }

  /** One movement row by id (the correction target lookup). */
  findTransaction(
    workspaceId: string,
    transactionId: string,
    exec?: SqliteExec,
  ): CreditTransactionRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM credit_transaction WHERE workspace_id = ? AND transaction_id = ?")
      .get(workspaceId, transactionId) as Record<string, unknown> | undefined;
    return row ? this.toTransaction(row) : null;
  }

  /**
   * The 'grant' movement a control-plane reference already produced (the
   * replay dedup's lookup-before-insert; the UNIQUE partial index is the
   * storage backstop behind it). Related ids are workspace-scoped.
   */
  findGrantByRelatedId(workspaceId: string, relatedId: string, exec?: SqliteExec) {
    const row = (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM credit_transaction
         WHERE workspace_id = ? AND related_id = ? AND entry_type = 'grant'`,
      )
      .get(workspaceId, relatedId) as Record<string, unknown> | undefined;
    return row ? this.toTransaction(row) : null;
  }

  /**
   * The month's NET settled usage, aggregated IN SQL (review F7): the whole
   * month window is summed — never an in-memory page of the newest rows, so
   * a busy account cannot silently truncate the displayed truth. Charges
   * add; adjustments that correct a settlement_charge subtract (the target's
   * entry type is joined, never guessed).
   */
  sumUsedUnitsForMonth(
    workspaceId: string,
    monthStart: string,
    monthEnd: string,
    exec?: SqliteExec,
  ): number {
    const row = (exec ?? this.tx.connection())
      .prepare(
        `SELECT COALESCE(SUM(
           CASE
             WHEN t.entry_type = 'settlement_charge' THEN t.amount_units
             WHEN t.entry_type = 'adjustment'
                  AND tgt.entry_type = 'settlement_charge' THEN -t.amount_units
             ELSE 0
           END), 0) AS used_units
         FROM credit_transaction t
         LEFT JOIN credit_transaction tgt
           ON tgt.workspace_id = t.workspace_id
          AND tgt.transaction_id = t.corrects_transaction_id
         WHERE t.workspace_id = ? AND t.created_at >= ? AND t.created_at < ?`,
      )
      .get(workspaceId, monthStart, monthEnd) as { used_units: number | bigint };
    return Number(row.used_units);
  }

  /** Every movement row of ONE run (the drill-down's own rows — a task's
   * rows are exactly its own, no workspace-wide page stands between). */
  listTransactionsForTask(workspaceId: string, taskId: string, exec?: SqliteExec) {
    const rows = (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM credit_transaction WHERE workspace_id = ? AND task_id = ?
         ORDER BY created_at ASC, transaction_id ASC`,
      )
      .all(workspaceId, taskId) as Record<string, unknown>[];
    return rows.map((row) => this.toTransaction(row));
  }

  /**
   * The per-run movement aggregates, computed IN SQL over EVERY movement
   * (review F7): each run's net charged (charges minus charge-reversing
   * adjustments), released, and last-movement timestamp — no bound can
   * silently drop a run from the picker. Newest movement first.
   */
  summarizeRuns(
    workspaceId: string,
    limit: number,
    exec?: SqliteExec,
  ): Array<{
    task_id: string;
    charged_units: number;
    released_units: number;
    last_movement_at: string;
  }> {
    const rows = (exec ?? this.tx.connection())
      .prepare(
        `SELECT t.task_id AS task_id,
           COALESCE(SUM(
             CASE
               WHEN t.entry_type = 'settlement_charge' THEN t.amount_units
               WHEN t.entry_type = 'adjustment'
                    AND tgt.entry_type = 'settlement_charge' THEN -t.amount_units
               ELSE 0
             END), 0) AS charged_units,
           COALESCE(SUM(
             CASE WHEN t.entry_type = 'reservation_release' THEN t.amount_units ELSE 0 END),
             0) AS released_units,
           MAX(t.created_at) AS last_movement_at
         FROM credit_transaction t
         LEFT JOIN credit_transaction tgt
           ON tgt.workspace_id = t.workspace_id
          AND tgt.transaction_id = t.corrects_transaction_id
         WHERE t.workspace_id = ? AND t.task_id IS NOT NULL
         GROUP BY t.task_id
         ORDER BY last_movement_at DESC, MAX(t.transaction_id) DESC
         LIMIT ?`,
      )
      .all(workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      task_id: String(row["task_id"]),
      charged_units: Number(row["charged_units"]),
      released_units: Number(row["released_units"]),
      last_movement_at: String(row["last_movement_at"]),
    }));
  }

  // ── Reservation / settlement / release ─────────────────────────────────────

  /** Insert ONE reservation hold row (status 'reserved'). */
  insertReservation(input: CreditReservationInsert, exec?: SqliteExec): CreditReservationRow {
    const run = (target: SqliteExec) => {
      if (input.estimate !== null) {
        this.insertCostEstimate(input.estimate, target);
      }
      target
        .prepare(
          `INSERT INTO reservation
             (workspace_id, reservation_id, task_id, trigger_id, estimate_id, estimated_units, status, created_at, settled_at, released_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL)`,
        )
        .run(
          input.workspace_id,
          input.reservation_id,
          input.task_id,
          input.trigger_id,
          input.estimate?.estimate_id ?? null,
          input.estimated_units,
          input.created_at,
        );
      const row = this.findReservation(input.workspace_id, input.reservation_id, target);
      if (!row) throw new CreditLedgerRepositoryError("RESERVATION_INSERT_FAILED", "no row");
      return row;
    };
    return exec ? run(exec) : this.tx.transaction(run);
  }

  findReservation(
    workspaceId: string,
    reservationId: string,
    exec?: SqliteExec,
  ): CreditReservationRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM reservation WHERE workspace_id = ? AND reservation_id = ?")
      .get(workspaceId, reservationId) as Record<string, unknown> | undefined;
    return row ? this.toReservation(row) : null;
  }

  /** Every ACTIVE hold for one run (the run-scoped release/settle paths). */
  listActiveReservationsForTask(
    workspaceId: string,
    taskId: string,
    exec?: SqliteExec,
  ): CreditReservationRow[] {
    const rows = (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM reservation
         WHERE workspace_id = ? AND task_id = ? AND status = 'reserved'
         ORDER BY created_at ASC, reservation_id ASC`,
      )
      .all(workspaceId, taskId) as Record<string, unknown>[];
    return rows.map((row) => this.toReservation(row));
  }

  /** Mark one reservation settled (the row's status transition). */
  markReservationSettled(
    workspaceId: string,
    reservationId: string,
    settledAt: string,
    exec: SqliteExec,
  ): void {
    exec
      .prepare(
        `UPDATE reservation SET status = 'settled', settled_at = ?
         WHERE workspace_id = ? AND reservation_id = ? AND status = 'reserved'`,
      )
      .run(settledAt, workspaceId, reservationId);
  }

  /** Mark one reservation released (the row's status transition). */
  markReservationReleased(
    workspaceId: string,
    reservationId: string,
    releasedAt: string,
    exec: SqliteExec,
  ): void {
    exec
      .prepare(
        `UPDATE reservation SET status = 'released', released_at = ?
         WHERE workspace_id = ? AND reservation_id = ? AND status = 'reserved'`,
      )
      .run(releasedAt, workspaceId, reservationId);
  }

  insertSettlement(row: CreditSettlementRow, exec?: SqliteExec): CreditSettlementRow {
    const run = (target: SqliteExec) => {
      target
        .prepare(
          `INSERT INTO settlement (workspace_id, settlement_id, reservation_id, task_id, actual_units, settled_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspace_id,
          row.settlement_id,
          row.reservation_id,
          row.task_id,
          row.actual_units,
          row.settled_at,
        );
      return row;
    };
    return exec ? run(exec) : this.tx.transaction(run);
  }

  insertRelease(row: CreditReleaseRow, exec?: SqliteExec): CreditReleaseRow {
    const run = (target: SqliteExec) => {
      target
        .prepare(
          `INSERT INTO release (workspace_id, release_id, reservation_id, task_id, released_units, reason, released_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspace_id,
          row.release_id,
          row.reservation_id,
          row.task_id,
          row.released_units,
          row.reason,
          row.released_at,
        );
      return row;
    };
    return exec ? run(exec) : this.tx.transaction(run);
  }

  /** The workspace's settlement rows, newest first (the drill-down read). */
  listSettlements(workspaceId: string, limit = 500): CreditSettlementRow[] {
    const rows = this.tx
      .connection()
      .prepare(
        `SELECT * FROM settlement WHERE workspace_id = ?
         ORDER BY settled_at DESC, settlement_id DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map(
      (row) =>
        ({
          workspace_id: String(row["workspace_id"]),
          settlement_id: String(row["settlement_id"]),
          reservation_id: String(row["reservation_id"]),
          task_id: String(row["task_id"]),
          actual_units: Number(row["actual_units"]),
          settled_at: String(row["settled_at"]),
        }) satisfies CreditSettlementRow,
    );
  }

  /** The workspace's release rows, newest first (the drill-down read). */
  listReleases(workspaceId: string, limit = 500): CreditReleaseRow[] {
    const rows = this.tx
      .connection()
      .prepare(
        `SELECT * FROM release WHERE workspace_id = ?
         ORDER BY released_at DESC, release_id DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      workspace_id: String(row["workspace_id"]),
      release_id: String(row["release_id"]),
      reservation_id: String(row["reservation_id"]),
      task_id: String(row["task_id"]),
      released_units: Number(row["released_units"]),
      reason: row["reason"] as CreditReleaseReason,
      released_at: String(row["released_at"]),
    }));
  }

  // ── Usage + estimates (the D20 measurement records) ────────────────────────

  insertUsageRecord(row: CreditUsageInsert, exec?: SqliteExec): void {
    const run = (target: SqliteExec) => {
      target
        .prepare(
          `INSERT INTO usage_record
             (workspace_id, usage_id, task_id, provider_id, model, provider_origin, input_tokens, output_tokens, latency_ms, charged_units, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspace_id,
          row.usage_id,
          row.task_id,
          row.provider_id,
          row.model,
          row.provider_origin,
          row.input_tokens,
          row.output_tokens,
          row.latency_ms,
          row.charged_units,
          row.created_at,
        );
    };
    if (exec) {
      run(exec);
      return;
    }
    this.tx.transaction(run);
  }

  /** The run-scoped usage rows, oldest first (the per-run drill-down). */
  listUsageForTask(workspaceId: string, taskId: string): CreditUsageRecordRow[] {
    const rows = this.tx
      .connection()
      .prepare(
        `SELECT * FROM usage_record WHERE workspace_id = ? AND task_id = ?
         ORDER BY created_at ASC, usage_id ASC`,
      )
      .all(workspaceId, taskId) as Record<string, unknown>[];
    return rows.map((row) => this.toUsage(row));
  }

  /** Usage rows recorded in the calendar month containing `at` (the D21
   * "used this month" read; the charged movement rows are the authority —
   * this read is the custom-provider visibility surface). */
  listUsageForMonth(
    workspaceId: string,
    monthStart: string,
    monthEnd: string,
  ): CreditUsageRecordRow[] {
    const rows = this.tx
      .connection()
      .prepare(
        `SELECT * FROM usage_record
         WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC, usage_id ASC`,
      )
      .all(workspaceId, monthStart, monthEnd) as Record<string, unknown>[];
    return rows.map((row) => this.toUsage(row));
  }

  insertCostEstimate(row: CostEstimateRow, exec?: SqliteExec): void {
    const run = (target: SqliteExec) => {
      target
        .prepare(
          `INSERT INTO cost_estimate (workspace_id, estimate_id, task_id, provider_id, model, estimated_units, basis, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.workspace_id,
          row.estimate_id,
          row.task_id,
          row.provider_id,
          row.model,
          row.estimated_units,
          row.basis,
          row.created_at,
        );
    };
    if (exec) {
      run(exec);
      return;
    }
    this.tx.transaction(run);
  }

  findCostEstimate(workspaceId: string, estimateId: string): CostEstimateRow | null {
    const row = this.tx
      .connection()
      .prepare("SELECT * FROM cost_estimate WHERE workspace_id = ? AND estimate_id = ?")
      .get(workspaceId, estimateId) as Record<string, unknown> | undefined;
    return row ? this.toEstimate(row) : null;
  }

  // ── Row mappers (the STRICT tables return typed columns; the mappers keep
  // the integer/bigint bridge in one place) ───────────────────────────────────

  private toAccount(row: Record<string, unknown>): CreditAccountRow {
    return {
      workspace_id: String(row["workspace_id"]),
      granted_units: Number(row["granted_units"]),
      charged_units: Number(row["charged_units"]),
      reserved_units: Number(row["reserved_units"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
    };
  }

  private toTransaction(row: Record<string, unknown>): CreditTransactionRow {
    return {
      workspace_id: String(row["workspace_id"]),
      transaction_id: String(row["transaction_id"]),
      entry_type: row["entry_type"] as CreditEntryType,
      amount_units: Number(row["amount_units"]),
      task_id: (row["task_id"] as string | null) ?? null,
      reservation_id: (row["reservation_id"] as string | null) ?? null,
      related_id: (row["related_id"] as string | null) ?? null,
      corrects_transaction_id: (row["corrects_transaction_id"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }

  private toReservation(row: Record<string, unknown>): CreditReservationRow {
    return {
      workspace_id: String(row["workspace_id"]),
      reservation_id: String(row["reservation_id"]),
      task_id: String(row["task_id"]),
      trigger_id: (row["trigger_id"] as string | null) ?? null,
      estimate_id: (row["estimate_id"] as string | null) ?? null,
      estimated_units: Number(row["estimated_units"]),
      status: row["status"] as CreditReservationStatus,
      created_at: String(row["created_at"]),
      settled_at: (row["settled_at"] as string | null) ?? null,
      released_at: (row["released_at"] as string | null) ?? null,
    };
  }

  private toUsage(row: Record<string, unknown>): CreditUsageRecordRow {
    return {
      workspace_id: String(row["workspace_id"]),
      usage_id: String(row["usage_id"]),
      task_id: String(row["task_id"]),
      provider_id: String(row["provider_id"]),
      model: String(row["model"]),
      provider_origin: row["provider_origin"] as CreditProviderOrigin,
      input_tokens: row["input_tokens"] === null ? null : Number(row["input_tokens"]),
      output_tokens: row["output_tokens"] === null ? null : Number(row["output_tokens"]),
      latency_ms: row["latency_ms"] === null ? null : Number(row["latency_ms"]),
      charged_units: Number(row["charged_units"]),
      created_at: String(row["created_at"]),
    };
  }

  private toEstimate(row: Record<string, unknown>): CostEstimateRow {
    return {
      workspace_id: String(row["workspace_id"]),
      estimate_id: String(row["estimate_id"]),
      task_id: String(row["task_id"]),
      provider_id: String(row["provider_id"]),
      model: String(row["model"]),
      estimated_units: Number(row["estimated_units"]),
      basis: String(row["basis"]),
      created_at: String(row["created_at"]),
    };
  }
}
