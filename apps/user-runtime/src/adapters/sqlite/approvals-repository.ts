/**
 * Approvals repository (S20 chunk 1; D9, PRD §8, E3, E12, G3) — the only place
 * approval SQL lives.
 *
 * Four durable tables (the v9 migration): approval_requests, approval_grants,
 * approval_reminders, approval_mutes. The request and grant rows mirror the
 * contracts shapes one-to-one (this repository accepts and returns the
 * contract records; the storage mapping — Actor JSON, boolean↔INTEGER, absent
 * optional fields ↔ NULL — stays here). G3: there is NO raw-arguments column;
 * approval records carry the sha256 args_digest only. Every table is
 * workspace-scoped as PRIMARY KEY prefix (E12); task/conversation/approval
 * references are validated by the writers in the same workspace, so no
 * FOREIGN KEY is declared — the v4/v5/v6/v8 discipline.
 *
 * Chunk-1 surface: insert/get/list for requests (by task and by status),
 * insert/list/revoke for grants, and basic reminder + mute accessors. The
 * decision application, invalidation rules, reminder firing, and mute
 * enforcement are later chunks' logic against this same schema.
 *
 * Chunk-2 addition (S20; D9, G3): grants carry a nullable `args_digest`
 * adjacency column (v10) so ONE-TIME grants match the exact argument set — a
 * changed argument set invalidates a one-time approval. Reusable grants store
 * NULL (deliberately argument-agnostic). The contracts ApprovalGrant is
 * untouched; `ApprovalGrantRecord` = contract record + the digest. Requests
 * gain `resolveRequest`, the one writer that stamps status + resolved_at +
 * resolved_by_choice (decisions are immutable — D9).
 *
 * Chunk-3 additions (S20; D9, E3): grants carry a nullable `consumed_at`
 * stamp (v11) — `consumeGrant` is the ONE writer that sets it, and only on
 * rows whose stamp is still NULL (write-once, like the decision resolution).
 * Reminders gain the due-scan accessor (`listDueUndeliveredReminders`) and the
 * delivery stamp (`markReminderDelivered`, write-once as well) the service's
 * reminder scan fires through.
 *
 * Review-round addition (S20; F2): mutes gain a nullable `created_by` audit
 * column (v12) — every new mute is recorded with its creating user actor's id
 * (the service refuses actorless or non-user mutes); legacy rows read NULL.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Actor, ApprovalChoice, ApprovalGrant, ApprovalRequest } from "@shera-bot/contracts";

import type { SqliteTransactions } from "./transactions.ts";

/** The contract status vocabulary of an approval request. */
export type ApprovalRequestStatus = ApprovalRequest["status"];

/**
 * One durable approval grant: the contracts ApprovalGrant record plus the
 * v10 args_digest adjacency column (null for reusable grants — they are
 * deliberately argument-agnostic; digest-only even here, never raw args — G3)
 * and the v11 consumption stamp (set once, when the approved execution of a
 * ONE-TIME grant completes; reusable grants stay NULL forever).
 */
export type ApprovalGrantRecord = ApprovalGrant & {
  args_digest: string | null;
  consumed_at: string | null;
};

/** The resolution a decision stamps on one request (status moves off pending). */
export interface ApprovalRequestResolution {
  status: Exclude<ApprovalRequestStatus, "pending">;
  resolved_at: string;
  resolved_by_choice: ApprovalChoice;
}

/** One E3 reminder slot of one approval request (the v9 reminder table). */
export interface ApprovalReminderRow {
  workspace_id: string;
  approval_id: string;
  /** 0-4 onto APPROVAL_REMINDER_SCHEDULE_SECONDS. */
  reminder_index: number;
  due_at: string;
  delivered_at: string | null;
}

/** The reminder-silencing scope of one mute (chunk 3 enforces it). */
export type ApprovalMuteScope = "approval" | "task" | "all";

/**
 * One row of the v9 approval_mutes table. The v12 audit column records the
 * creating user actor's id (the service requires it on every new mute);
 * pre-v12 creatorless rows read NULL — a legacy mute is never attributed.
 */
export interface ApprovalMuteRow {
  workspace_id: string;
  mute_id: string;
  scope: ApprovalMuteScope;
  /** The approval/task id the mute targets; null only for the 'all' scope. */
  target_id: string | null;
  created_at: string;
  /** The creating user actor's id (v12 audit); null only on legacy rows. */
  created_by: string | null;
}

const REQUEST_COLUMNS = `
  workspace_id, approval_id, task_id, conversation_id, tool_id, tool_version,
  capability, risk_class, resource_scope, args_digest, side_effect_summary,
  requested_by_json, requested_at, status, resolved_at, resolved_by_choice`;

const GRANT_COLUMNS = `
  workspace_id, grant_id, source_choice, principal_type, principal_id,
  tool_id, tool_version, capability, resource_scope, conversation_scope,
  workspace_scope, expires_at, one_time, created_by_json, approved_at, revoked_at,
  args_digest, consumed_at`;

function requestRowToRecord(row: Record<string, unknown>): ApprovalRequest {
  return {
    workspace_id: row.workspace_id as string,
    approval_id: row.approval_id as string,
    task_id: row.task_id as string,
    conversation_id: row.conversation_id as string,
    tool_id: row.tool_id as string,
    tool_version: row.tool_version as string,
    capability: row.capability as string,
    risk_class: row.risk_class as ApprovalRequest["risk_class"],
    resource_scope: row.resource_scope as string,
    args_digest: row.args_digest as string,
    side_effect_summary: row.side_effect_summary as string,
    requested_by: JSON.parse(row.requested_by_json as string) as Actor,
    requested_at: row.requested_at as string,
    status: row.status as ApprovalRequestStatus,
    ...(typeof row.resolved_at === "string" ? { resolved_at: row.resolved_at } : {}),
    ...(typeof row.resolved_by_choice === "string"
      ? { resolved_by_choice: row.resolved_by_choice as ApprovalRequest["resolved_by_choice"] }
      : {}),
  };
}

function grantRowToRecord(row: Record<string, unknown>): ApprovalGrantRecord {
  return {
    workspace_id: row.workspace_id as string,
    grant_id: row.grant_id as string,
    source_choice: row.source_choice as ApprovalGrant["source_choice"],
    principal_type: row.principal_type as ApprovalGrant["principal_type"],
    principal_id: row.principal_id as string,
    tool_id: row.tool_id as string,
    tool_version: row.tool_version as string,
    capability: row.capability as string,
    resource_scope: row.resource_scope as string,
    conversation_scope: row.conversation_scope as ApprovalGrant["conversation_scope"],
    workspace_scope: row.workspace_scope as string,
    expires_at: (row.expires_at as string | null) ?? null,
    one_time: row.one_time === 1,
    created_by: JSON.parse(row.created_by_json as string) as Actor,
    approved_at: row.approved_at as string,
    revoked_at: (row.revoked_at as string | null) ?? null,
    args_digest: (row.args_digest as string | null) ?? null,
    consumed_at: (row.consumed_at as string | null) ?? null,
  };
}

export class ApprovalsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // -------------------------------------------------------------------------
  // Approval requests (D9)
  // -------------------------------------------------------------------------

  insertRequest(record: ApprovalRequest, exec?: DatabaseSync): ApprovalRequest {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_requests
         (${REQUEST_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.workspace_id,
      record.approval_id,
      record.task_id,
      record.conversation_id,
      record.tool_id,
      record.tool_version,
      record.capability,
      record.risk_class,
      record.resource_scope,
      record.args_digest,
      record.side_effect_summary,
      JSON.stringify(record.requested_by),
      record.requested_at,
      record.status,
      record.resolved_at ?? null,
      record.resolved_by_choice ?? null,
    );
    return record;
  }

  getRequest(workspaceId: string, approvalId: string, exec?: DatabaseSync): ApprovalRequest | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${REQUEST_COLUMNS}
         FROM approval_requests
         WHERE workspace_id = ? AND approval_id = ?`,
      )
      .get(workspaceId, approvalId) as Record<string, unknown> | undefined;
    return row ? requestRowToRecord(row) : null;
  }

  /** Every approval request of one task, oldest first. */
  listRequestsByTask(workspaceId: string, taskId: string, exec?: DatabaseSync): ApprovalRequest[] {
    const db = exec ?? this.tx.connection();
    return (
      db
        .prepare(
          `SELECT ${REQUEST_COLUMNS}
           FROM approval_requests
           WHERE workspace_id = ? AND task_id = ?
           ORDER BY requested_at, approval_id`,
        )
        .all(workspaceId, taskId) as unknown as Record<string, unknown>[]
    ).map(requestRowToRecord);
  }

  /** Every approval request of one workspace in one status, oldest first. */
  listRequestsByStatus(
    workspaceId: string,
    status: ApprovalRequestStatus,
    exec?: DatabaseSync,
  ): ApprovalRequest[] {
    const db = exec ?? this.tx.connection();
    return (
      db
        .prepare(
          `SELECT ${REQUEST_COLUMNS}
           FROM approval_requests
           WHERE workspace_id = ? AND status = ?
           ORDER BY requested_at, approval_id`,
        )
        .all(workspaceId, status) as unknown as Record<string, unknown>[]
    ).map(requestRowToRecord);
  }

  /**
   * Stamp the ONE resolution of a request (S20 chunk 2): status moves off
   * pending with resolved_at + resolved_by_choice in the same update.
   * Decisions are immutable (D9) — the service refuses a second resolution
   * before ever reaching this writer, AND the writer is guarded anyway
   * (S20 review fix F4a): only a row still PENDING is updated, so a raced
   * second write is an idempotent no-op that cannot re-stamp the first
   * resolution. False when no pending row matched (E12-scoped).
   */
  resolveRequest(
    workspaceId: string,
    approvalId: string,
    resolution: ApprovalRequestResolution,
    exec?: DatabaseSync,
  ): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE approval_requests
         SET status = ?, resolved_at = ?, resolved_by_choice = ?
         WHERE workspace_id = ? AND approval_id = ? AND status = 'pending'`,
      )
      .run(
        resolution.status,
        resolution.resolved_at,
        resolution.resolved_by_choice,
        workspaceId,
        approvalId,
      );
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Approval grants (D9 — created by the decision application, later chunk)
  // -------------------------------------------------------------------------

  insertGrant(record: ApprovalGrantRecord, exec?: DatabaseSync): ApprovalGrantRecord {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_grants
         (${GRANT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.workspace_id,
      record.grant_id,
      record.source_choice,
      record.principal_type,
      record.principal_id,
      record.tool_id,
      record.tool_version,
      record.capability,
      record.resource_scope,
      record.conversation_scope,
      record.workspace_scope,
      record.expires_at,
      record.one_time ? 1 : 0,
      JSON.stringify(record.created_by),
      record.approved_at,
      record.revoked_at,
      record.args_digest,
      record.consumed_at,
    );
    return record;
  }

  /** Every grant of one workspace, oldest first (revoked rows included). */
  listGrants(workspaceId: string, exec?: DatabaseSync): ApprovalGrantRecord[] {
    const db = exec ?? this.tx.connection();
    return (
      db
        .prepare(
          `SELECT ${GRANT_COLUMNS}
           FROM approval_grants
           WHERE workspace_id = ?
           ORDER BY approved_at, grant_id`,
        )
        .all(workspaceId) as unknown as Record<string, unknown>[]
    ).map(grantRowToRecord);
  }

  /**
   * Stamp revoked_at on one grant; false when no UNREVOKED row matched
   * (E12-scoped). The stamp is write-once (S20 review fix F4b): a raced
   * second revoke is an idempotent no-op, never a re-stamp — the first
   * revocation instant stands as the audit record.
   */
  revokeGrant(
    workspaceId: string,
    grantId: string,
    revokedAt: string,
    exec?: DatabaseSync,
  ): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE approval_grants SET revoked_at = ?
         WHERE workspace_id = ? AND grant_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, workspaceId, grantId);
    return result.changes > 0;
  }

  /**
   * Stamp consumed_at on one ONE-TIME grant (S20 chunk 3): the durable record
   * that its approved execution completed, so the grant can never authorize a
   * second execution — not even across a runtime restart. Write-once: only a
   * row whose stamp is still NULL is updated (the first stamp wins; the
   * consumption of a grant is as immutable as the decision that created it —
   * D9). False when no row matched or the grant was already consumed.
   */
  consumeGrant(workspaceId: string, grantId: string, consumedAt: string, exec?: DatabaseSync): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE approval_grants SET consumed_at = ?
         WHERE workspace_id = ? AND grant_id = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, workspaceId, grantId);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Approval reminders (E3 — the five slots; firing is a later chunk)
  // -------------------------------------------------------------------------

  insertReminder(row: ApprovalReminderRow, exec?: DatabaseSync): ApprovalReminderRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_reminders
         (workspace_id, approval_id, reminder_index, due_at, delivered_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.workspace_id, row.approval_id, row.reminder_index, row.due_at, row.delivered_at);
    return row;
  }

  /** The five reminder slots of one approval request, by index. */
  listRemindersByApproval(
    workspaceId: string,
    approvalId: string,
    exec?: DatabaseSync,
  ): ApprovalReminderRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, approval_id, reminder_index, due_at, delivered_at
         FROM approval_reminders
         WHERE workspace_id = ? AND approval_id = ?
         ORDER BY reminder_index`,
      )
      .all(workspaceId, approvalId) as unknown as ApprovalReminderRow[];
  }

  /**
   * The reminder-scan accessor (S20 chunk 3, E3): every UNDELIVERED slot of
   * the workspace whose due_at has arrived (due_at <= now, compared
   * lexicographically — every stamp is a UTC ISO-8601 string from the same
   * clock), oldest due first. Muting is NOT applied here — the service's scan
   * enforces it and leaves muted rows untouched (rows are the audit record).
   */
  listDueUndeliveredReminders(workspaceId: string, nowIso: string, exec?: DatabaseSync) {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, approval_id, reminder_index, due_at, delivered_at
         FROM approval_reminders
         WHERE workspace_id = ? AND delivered_at IS NULL AND due_at <= ?
         ORDER BY due_at, approval_id, reminder_index`,
      )
      .all(workspaceId, nowIso) as unknown as ApprovalReminderRow[];
  }

  /**
   * Stamp delivered_at on one reminder slot (S20 chunk 3, E3) — the durable
   * delivery record. Write-once: only an UNDELIVERED row is updated, so a
   * repeated scan can never double-deliver. False when no undelivered row
   * matched. Delivery NEVER touches task state (E3) — this writer cannot:
   * only approval_reminders columns are in its UPDATE.
   */
  markReminderDelivered(
    workspaceId: string,
    approvalId: string,
    reminderIndex: number,
    deliveredAt: string,
    exec?: DatabaseSync,
  ): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE approval_reminders SET delivered_at = ?
         WHERE workspace_id = ? AND approval_id = ? AND reminder_index = ?
           AND delivered_at IS NULL`,
      )
      .run(deliveredAt, workspaceId, approvalId, reminderIndex);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Approval mutes (reminder silencing; enforcement is a later chunk)
  // -------------------------------------------------------------------------

  insertMute(row: ApprovalMuteRow, exec?: DatabaseSync): ApprovalMuteRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_mutes
         (workspace_id, mute_id, scope, target_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.workspace_id, row.mute_id, row.scope, row.target_id, row.created_at, row.created_by);
    return row;
  }

  /** Every mute of one workspace, oldest first. */
  listMutes(workspaceId: string, exec?: DatabaseSync): ApprovalMuteRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, mute_id, scope, target_id, created_at, created_by
         FROM approval_mutes
         WHERE workspace_id = ?
         ORDER BY created_at, mute_id`,
      )
      .all(workspaceId) as unknown as ApprovalMuteRow[];
  }
}
