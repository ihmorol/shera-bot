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
 */
import type { DatabaseSync } from "node:sqlite";

import type { Actor, ApprovalGrant, ApprovalRequest } from "@shera-bot/contracts";

import type { SqliteTransactions } from "./transactions.ts";

/** The contract status vocabulary of an approval request. */
export type ApprovalRequestStatus = ApprovalRequest["status"];

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

/** One row of the v9 approval_mutes table. */
export interface ApprovalMuteRow {
  workspace_id: string;
  mute_id: string;
  scope: ApprovalMuteScope;
  /** The approval/task id the mute targets; null only for the 'all' scope. */
  target_id: string | null;
  created_at: string;
}

const REQUEST_COLUMNS = `
  workspace_id, approval_id, task_id, conversation_id, tool_id, tool_version,
  capability, risk_class, resource_scope, args_digest, side_effect_summary,
  requested_by_json, requested_at, status, resolved_at, resolved_by_choice`;

const GRANT_COLUMNS = `
  workspace_id, grant_id, source_choice, principal_type, principal_id,
  tool_id, tool_version, capability, resource_scope, conversation_scope,
  workspace_scope, expires_at, one_time, created_by_json, approved_at, revoked_at`;

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

function grantRowToRecord(row: Record<string, unknown>): ApprovalGrant {
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

  // -------------------------------------------------------------------------
  // Approval grants (D9 — created by the decision application, later chunk)
  // -------------------------------------------------------------------------

  insertGrant(record: ApprovalGrant, exec?: DatabaseSync): ApprovalGrant {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_grants
         (${GRANT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    return record;
  }

  /** Every grant of one workspace, oldest first (revoked rows included). */
  listGrants(workspaceId: string, exec?: DatabaseSync): ApprovalGrant[] {
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

  /** Stamp revoked_at on one grant; false when no row matched (E12-scoped). */
  revokeGrant(workspaceId: string, grantId: string, revokedAt: string, exec?: DatabaseSync): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE approval_grants SET revoked_at = ?
         WHERE workspace_id = ? AND grant_id = ?`,
      )
      .run(revokedAt, workspaceId, grantId);
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

  // -------------------------------------------------------------------------
  // Approval mutes (reminder silencing; enforcement is a later chunk)
  // -------------------------------------------------------------------------

  insertMute(row: ApprovalMuteRow, exec?: DatabaseSync): ApprovalMuteRow {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO approval_mutes
         (workspace_id, mute_id, scope, target_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(row.workspace_id, row.mute_id, row.scope, row.target_id, row.created_at);
    return row;
  }

  /** Every mute of one workspace, oldest first. */
  listMutes(workspaceId: string, exec?: DatabaseSync): ApprovalMuteRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, mute_id, scope, target_id, created_at
         FROM approval_mutes
         WHERE workspace_id = ?
         ORDER BY created_at, mute_id`,
      )
      .all(workspaceId) as unknown as ApprovalMuteRow[];
  }
}
