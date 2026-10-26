/**
 * Operation chat repository (S13 chunk 2; D31, D34, D36, D46, D49) — the only
 * place operation-domain SQL lives.
 *
 * Vocabulary is Pack → Operations → Agents: an Operation is the persistent
 * workspace/chat object (D31) holding multiple independently tracked task
 * runs. "Expert" is a forbidden historical alias and never appears here.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): every method takes workspace_id
 * and every statement keys rows by it. Primary keys are (workspace_id, id) —
 * the same operation_id/run_id in two workspaces are independent rows.
 *
 * Normalization (v6 migration): the D29 pinning snapshot is stored WITHOUT
 * the roster. pack identity, capabilities, and the provider snapshot live on
 * the operations row; roster membership is the operation_roster table — the
 * single source of truth, queryable at the storage layer. Reads assemble
 * pinning.roster_agent_ids from the table, so the JSON snapshot can never
 * drift from the membership rows. Every record read parses back through the
 * contracts' schemas, so a stored shape that no longer conforms is a typed
 * OperationRecordCorruptError — never silently returned JSON (the
 * agents-repository settings discipline).
 *
 * Collaboration events (D7): the stream is the RUN when run_id is set, the
 * Operation chat itself ("operation:<operation_id>" sentinel) when null.
 * Sequences are 1-based and gapless per stream (D26): the next sequence is
 * allocated inside the same transaction as the insert (BEGIN IMMEDIATE
 * serializes writers; the composite primary key is the backstop that fails
 * loudly instead of overwriting), and a run-scoped append advances the run's
 * events_seq_cursor IN THE SAME transaction. Duplicate (workspace_id,
 * event_id) is an idempotent no-op returning the ORIGINAL event (the v1
 * journal discipline, AC3).
 */
import { createHash } from "node:crypto";

import { DatabaseSync } from "node:sqlite";

import {
  OperationCollaborationEvent,
  OperationRecord,
  OperationRun,
  type RosterRefusalCode,
} from "@shera-bot/contracts";

import type { SqliteTransactions } from "./transactions.ts";

/** The reserved stream-sentinel prefix no run id may take (v6 header note). */
export const OPERATION_CHAT_STREAM_PREFIX = "operation:";

/**
 * S15 — the zero-side-effect probe for the D30 launch preview (READ-ONLY).
 * The preview is a safety boundary where NOTHING may execute before
 * confirmation; this probe is how the composed-stack test PROVES the preview
 * routes change nothing: it opens the database file through a second,
 * strictly read-only connection and reports (a) every user table's row count
 * and (b) a per-table content fingerprint — ANY row inserted, updated, or
 * deleted anywhere (operations, runs, chats, conversations, sessions,
 * journal, receipts) changes the fingerprint.
 *
 * Schema introspection only (sqlite_master) — no product-table statement
 * lives here, so no workspace predicate applies (E12 governs product rows);
 * the per-table reads are plain whole-table counts for the proof, never a
 * product read model. The probe writes nothing.
 */
export interface SqliteSideEffectProbe {
  /** Row count for every user table (sqlite_master, sqlite_% excluded). */
  tableCounts: Record<string, number>;
  /** "<table>=<sha256 of its rows>" parts joined by "|", tables name-ordered. */
  fingerprint: string;
}

export function sqliteSideEffectProbe(dbPath: string): SqliteSideEffectProbe {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableCounts: Record<string, number> = {};
    const parts: string[] = [];
    for (const { name } of tables) {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
        n: number | bigint;
      };
      tableCounts[name] = Number(count.n);
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      parts.push(`${name}=${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`);
    }
    return { tableCounts, fingerprint: parts.join("|") };
  } finally {
    db.close();
  }
}

/**
 * True when an Operation-chat binding insert lost the race against the
 * winner's committed (workspace_id, operation_id) primary key (B5, the v5
 * direct-chat pattern): THIS unit rolled back atomically and the winner's
 * binding is durable, so the caller re-reads and resolves to it.
 */
export function isOperationChatConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("operation_chats.workspace_id") &&
    error.message.includes("operation_chats.operation_id")
  );
}

/** The stream id of the Operation chat itself (events with run_id = null). */
export function operationChatStreamId(operationId: string): string {
  return `${OPERATION_CHAT_STREAM_PREFIX}${operationId}`;
}

/**
 * The typed "no such Operation in THIS workspace" rejection. Same stable
 * code/category pair as the module service errors so the transport's typed
 * error middleware maps it onto the SheraError taxonomy (404) without
 * special-casing — and its message is never echoed to a client (G3).
 */
export class OperationNotFoundError extends Error {
  readonly code = "OPERATION_NOT_FOUND" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, operationId: string) {
    super(`operation ${operationId} not found in workspace ${workspaceId}`);
    this.name = "OperationNotFoundError";
  }
}

/** The typed "no such run in THIS operation" rejection (404-class). */
export class OperationRunNotFoundError extends Error {
  readonly code = "OPERATION_RUN_NOT_FOUND" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, operationId: string, runId: string) {
    super(`run ${runId} not found in operation ${operationId} (workspace ${workspaceId})`);
    this.name = "OperationRunNotFoundError";
  }
}

/**
 * A stored operation-domain record no longer conforms to its contracts schema
 * (invalid JSON, schema drift): corruption, not a fallback path.
 */
export class OperationRecordCorruptError extends Error {
  readonly code = "CONTRACT_VALIDATION_FAILED" as const;
  readonly category = "validation" as const;

  constructor(context: string) {
    super(`stored operation record does not conform to its contract: ${context}`);
    this.name = "OperationRecordCorruptError";
  }
}

export interface OperationRosterMemberRow {
  workspace_id: string;
  operation_id: string;
  agent_id: string;
  pack_id: string;
  pack_version: string;
  /** 1 when the member was added under a declared approval (D36). */
  requires_approval: number;
  added_at: string;
}

export interface OperationRosterRefusalRow {
  id: number;
  workspace_id: string;
  operation_id: string;
  agent_id: string | null;
  pack_id: string | null;
  refusal_code: RosterRefusalCode | string;
  message: string;
  /** The raw command envelope that was refused — UI evidence (D36). */
  command_json: string;
  created_at: string;
}

export type OperationCoordinatorEventType = "CoordinatorSet" | "CoordinatorRemoved";

export interface OperationCoordinatorEventRow {
  id: number;
  workspace_id: string;
  operation_id: string;
  event_id: string;
  event_type: OperationCoordinatorEventType;
  /** The agent set (CoordinatorSet) or the agent removed (CoordinatorRemoved). */
  agent_id: string | null;
  created_at: string;
}

/** One persisted D7 collaboration event, validated on read, with stream position. */
export interface PersistedCollaborationEvent {
  workspace_id: string;
  operation_id: string;
  stream_id: string;
  sequence: number;
  event: OperationCollaborationEvent;
}

const OPERATION_COLUMNS = `
  operation_id,
  workspace_id,
  definition_ref,
  name,
  status,
  coordinator_agent_id,
  pack_id,
  pack_version,
  capabilities_json,
  provider_snapshot_json,
  created_at,
  updated_at`;

const RUN_COLUMNS = `
  run_id,
  workspace_id,
  operation_id,
  parent_task_id,
  state,
  events_seq_cursor,
  provider_snapshot_json,
  credits_json,
  artifacts_json,
  created_at,
  updated_at`;

const COLLABORATION_COLUMNS = `
  workspace_id,
  stream_id,
  sequence,
  event_id,
  operation_id,
  run_id,
  type,
  sender_agent_id,
  recipient_agent_ids_json,
  correlation_id,
  payload_json,
  issued_at`;

interface OperationSqlRow {
  operation_id: string;
  workspace_id: string;
  definition_ref: string | null;
  name: string;
  status: string;
  coordinator_agent_id: string;
  pack_id: string;
  pack_version: string;
  capabilities_json: string;
  provider_snapshot_json: string;
  created_at: string;
  updated_at: string;
}

interface OperationRunSqlRow {
  run_id: string;
  workspace_id: string;
  operation_id: string;
  parent_task_id: string | null;
  state: string;
  events_seq_cursor: number | bigint;
  provider_snapshot_json: string | null;
  credits_json: string;
  artifacts_json: string;
  created_at: string;
  updated_at: string;
}

interface CollaborationSqlRow {
  workspace_id: string;
  stream_id: string;
  sequence: number | bigint;
  event_id: string;
  operation_id: string;
  run_id: string | null;
  type: string;
  sender_agent_id: string;
  recipient_agent_ids_json: string;
  correlation_id: string;
  payload_json: string;
  issued_at: string;
}

function parseJson(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new OperationRecordCorruptError(`${context} (invalid JSON)`);
  }
}

export class OperationsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // -------------------------------------------------------------------------
  // Operations (the D31 workspace/chat record)
  // -------------------------------------------------------------------------

  /** Insert one Operation record. The caller built it through the contract. */
  createOperation(workspaceId: string, record: OperationRecord, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    if (record.workspace_id !== workspaceId) {
      throw new OperationRecordCorruptError("record workspace_id does not match the scope");
    }
    db.prepare(
      `INSERT INTO operations (
         operation_id, workspace_id, definition_ref, name, status,
         coordinator_agent_id, pack_id, pack_version,
         capabilities_json, provider_snapshot_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.operation_id,
      workspaceId,
      record.definition_ref,
      record.name,
      record.status,
      record.coordinator_agent_id,
      record.pinning.pack_id,
      record.pinning.pack_version,
      JSON.stringify(record.pinning.capabilities),
      JSON.stringify(record.pinning.provider_snapshot),
      record.created_at,
      record.updated_at,
    );
  }

  /**
   * The Operation record with its pinning snapshot assembled from the roster
   * table (single source of truth for membership), validated through the
   * contract. Null when the operation does not exist in THIS workspace.
   */
  getOperation(
    workspaceId: string,
    operationId: string,
    exec?: DatabaseSync,
  ): OperationRecord | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM operations WHERE workspace_id = ? AND operation_id = ?`,
      )
      .get(workspaceId, operationId) as OperationSqlRow | undefined;
    if (row === undefined) {
      return null;
    }
    const rosterAgentIds = this.listRoster(workspaceId, operationId, db).map(
      (member) => member.agent_id,
    );
    return this.recordFromRow(row, rosterAgentIds);
  }

  listOperations(workspaceId: string, exec?: DatabaseSync): OperationRecord[] {
    const db = exec ?? this.tx.connection();
    const rows = db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM operations WHERE workspace_id = ? ORDER BY created_at, operation_id`,
      )
      .all(workspaceId) as unknown as OperationSqlRow[];
    return rows.map((row) => {
      const rosterAgentIds = this.listRoster(workspaceId, row.operation_id, db).map(
        (member) => member.agent_id,
      );
      return this.recordFromRow(row, rosterAgentIds);
    });
  }

  /**
   * Update the coordinator field (D42/D49). The D49 lifecycle EVENT is a
   * separate record (recordCoordinatorEvent) the service writes in the SAME
   * transaction — this method only moves the field.
   */
  updateCoordinator(
    workspaceId: string,
    operationId: string,
    coordinatorAgentId: string,
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE operations SET coordinator_agent_id = ?, updated_at = ?
         WHERE workspace_id = ? AND operation_id = ?`,
      )
      .run(coordinatorAgentId, updatedAt, workspaceId, operationId);
    if (Number(result.changes) === 0) {
      throw new OperationNotFoundError(workspaceId, operationId);
    }
  }

  /**
   * S14: update the user-owned name field (the rename — a durable row
   * update, not a journaled event; see OperationsService.renameOperation for
   * the receipts/idempotency discipline).
   */
  updateName(
    workspaceId: string,
    operationId: string,
    name: string,
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE operations SET name = ?, updated_at = ? WHERE workspace_id = ? AND operation_id = ?`,
      )
      .run(name, updatedAt, workspaceId, operationId);
    if (Number(result.changes) === 0) {
      throw new OperationNotFoundError(workspaceId, operationId);
    }
  }

  private recordFromRow(row: OperationSqlRow, rosterAgentIds: string[]): OperationRecord {
    let parsed: OperationRecord;
    try {
      parsed = OperationRecord.parse({
        operation_id: row.operation_id,
        workspace_id: row.workspace_id,
        definition_ref: row.definition_ref,
        name: row.name,
        status: row.status,
        coordinator_agent_id: row.coordinator_agent_id,
        pinning: {
          pack_id: row.pack_id,
          pack_version: row.pack_version,
          roster_agent_ids: rosterAgentIds,
          capabilities: parseJson(row.capabilities_json, "operation capabilities JSON"),
          provider_snapshot: parseJson(
            row.provider_snapshot_json,
            "operation provider snapshot JSON",
          ),
        },
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    } catch (error) {
      if (error instanceof OperationRecordCorruptError) {
        throw error;
      }
      throw new OperationRecordCorruptError("operations row");
    }
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Roster (D36 — queryable membership; the pinning roster is derived)
  // -------------------------------------------------------------------------

  listRoster(
    workspaceId: string,
    operationId: string,
    exec?: DatabaseSync,
  ): OperationRosterMemberRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT workspace_id, operation_id, agent_id, pack_id, pack_version,
                requires_approval, added_at
         FROM operation_roster
         WHERE workspace_id = ? AND operation_id = ?
         ORDER BY added_at, agent_id`,
      )
      .all(workspaceId, operationId) as unknown as OperationRosterMemberRow[];
  }

  /**
   * Add one roster member. Idempotent: an existing (workspace, operation,
   * agent) membership is left untouched (the primary key's DO NOTHING).
   */
  addRosterMember(row: OperationRosterMemberRow, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO operation_roster
         (workspace_id, operation_id, agent_id, pack_id, pack_version, requires_approval, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, operation_id, agent_id) DO NOTHING`,
    ).run(
      row.workspace_id,
      row.operation_id,
      row.agent_id,
      row.pack_id,
      row.pack_version,
      row.requires_approval,
      row.added_at,
    );
  }

  /** Remove one roster member. True when a membership row was removed. */
  removeRosterMember(
    workspaceId: string,
    operationId: string,
    agentId: string,
    exec?: DatabaseSync,
  ): boolean {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `DELETE FROM operation_roster WHERE workspace_id = ? AND operation_id = ? AND agent_id = ?`,
      )
      .run(workspaceId, operationId, agentId);
    return Number(result.changes) > 0;
  }

  /** Persist a refused roster change (D36) so the UI can show WHY. */
  recordRosterRefusal(
    workspaceId: string,
    input: {
      operation_id: string;
      agent_id: string | null;
      pack_id: string | null;
      refusal_code: RosterRefusalCode | string;
      message: string;
      command_json: string;
      created_at: string;
    },
    exec?: DatabaseSync,
  ): OperationRosterRefusalRow {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `INSERT INTO operation_roster_refusals
           (workspace_id, operation_id, agent_id, pack_id, refusal_code, message, command_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        input.operation_id,
        input.agent_id,
        input.pack_id,
        input.refusal_code,
        input.message,
        input.command_json,
        input.created_at,
      );
    return {
      id: Number(result.lastInsertRowid),
      workspace_id: workspaceId,
      operation_id: input.operation_id,
      agent_id: input.agent_id,
      pack_id: input.pack_id,
      refusal_code: input.refusal_code,
      message: input.message,
      command_json: input.command_json,
      created_at: input.created_at,
    };
  }

  /**
   * The operation's 20 MOST RECENT persisted refusals, newest first — the
   * detail read model's bounded "recent" window (an append-only evidence
   * table is never read back in full; a covering index for this read is a
   * recorded follow-up).
   */
  listRosterRefusals(
    workspaceId: string,
    operationId: string,
    exec?: DatabaseSync,
  ): OperationRosterRefusalRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT id, workspace_id, operation_id, agent_id, pack_id, refusal_code,
                message, command_json, created_at
         FROM operation_roster_refusals
         WHERE workspace_id = ? AND operation_id = ?
         ORDER BY id DESC
         LIMIT 20`,
      )
      .all(workspaceId, operationId) as unknown as OperationRosterRefusalRow[];
  }

  // -------------------------------------------------------------------------
  // Coordinator lifecycle events (D49 — CoordinatorSet / CoordinatorRemoved)
  // -------------------------------------------------------------------------

  /**
   * Record one coordinator lifecycle event. Idempotent on (workspace_id,
   * event_id): a duplicate returns the ORIGINAL row (journal discipline).
   */
  recordCoordinatorEvent(
    workspaceId: string,
    input: {
      operation_id: string;
      event_id: string;
      event_type: OperationCoordinatorEventType;
      agent_id: string | null;
      created_at: string;
    },
    exec?: DatabaseSync,
  ): OperationCoordinatorEventRow {
    const db = exec ?? this.tx.connection();
    const existing = db
      .prepare(
        `SELECT id, workspace_id, operation_id, event_id, event_type, agent_id, created_at
         FROM operation_coordinator_events
         WHERE workspace_id = ? AND event_id = ?`,
      )
      .get(workspaceId, input.event_id) as OperationCoordinatorEventRow | undefined;
    if (existing !== undefined) {
      return existing;
    }
    const result = db
      .prepare(
        `INSERT INTO operation_coordinator_events
           (workspace_id, operation_id, event_id, event_type, agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        input.operation_id,
        input.event_id,
        input.event_type,
        input.agent_id,
        input.created_at,
      );
    return {
      id: Number(result.lastInsertRowid),
      workspace_id: workspaceId,
      operation_id: input.operation_id,
      event_id: input.event_id,
      event_type: input.event_type,
      agent_id: input.agent_id,
      created_at: input.created_at,
    };
  }

  listCoordinatorEvents(
    workspaceId: string,
    operationId: string,
    exec?: DatabaseSync,
  ): OperationCoordinatorEventRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT id, workspace_id, operation_id, event_id, event_type, agent_id, created_at
         FROM operation_coordinator_events
         WHERE workspace_id = ? AND operation_id = ?
         ORDER BY id`,
      )
      .all(workspaceId, operationId) as unknown as OperationCoordinatorEventRow[];
  }

  // -------------------------------------------------------------------------
  // Operation chat binding (D41 — one conversation per workspace+operation)
  // -------------------------------------------------------------------------

  /**
   * The conversation bound to THIS operation's chat, or null when the binding
   * does not exist yet (lazy creation — the first thread access creates it).
   */
  findChat(workspaceId: string, operationId: string, exec?: DatabaseSync): string | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT conversation_id FROM operation_chats
         WHERE workspace_id = ? AND operation_id = ?`,
      )
      .get(workspaceId, operationId) as { conversation_id: string } | undefined;
    return row === undefined ? null : row.conversation_id;
  }

  /**
   * Bind one conversation as THIS operation's chat. The conversation row is
   * created in the SAME transaction by the caller (the v5 discipline — no
   * FOREIGN KEY, the writer validates). A racing loser's insert fails the
   * primary key; the caller detects it via isOperationChatConflict.
   */
  bindChat(
    workspaceId: string,
    input: { operation_id: string; conversation_id: string; created_at: string },
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO operation_chats (workspace_id, operation_id, conversation_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(workspaceId, input.operation_id, input.conversation_id, input.created_at);
  }

  // -------------------------------------------------------------------------
  // Message addressing (D7 recipient semantics on the Operation chat)
  // -------------------------------------------------------------------------

  /**
   * Record the @-addressing resolution of one Operation-chat message: the
   * resolved recipient Agent ids, keyed by (workspace_id, message_id). Written
   * in the SAME transaction as the message append. An absent row means the
   * message was unaddressed (recipients = [], Operation-wide).
   */
  recordMessageRecipients(
    workspaceId: string,
    input: {
      message_id: string;
      operation_id: string;
      addressed_to: string[];
      recorded_at: string;
    },
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO operation_message_recipients
         (workspace_id, message_id, operation_id, addressed_to_json, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      input.message_id,
      input.operation_id,
      JSON.stringify(input.addressed_to),
      input.recorded_at,
    );
  }

  /**
   * The stored addressing of one message: the resolved recipient Agent ids,
   * or null when the message carries no addressing row (unaddressed → the
   * read model reports []).
   */
  findMessageRecipients(
    workspaceId: string,
    messageId: string,
    exec?: DatabaseSync,
  ): string[] | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT addressed_to_json FROM operation_message_recipients
         WHERE workspace_id = ? AND message_id = ?`,
      )
      .get(workspaceId, messageId) as { addressed_to_json: string } | undefined;
    if (row === undefined) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.addressed_to_json);
    } catch {
      throw new OperationRecordCorruptError("message recipients JSON (invalid JSON)");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((agentId) => typeof agentId !== "string" || agentId.length === 0)
    ) {
      throw new OperationRecordCorruptError("message recipients JSON");
    }
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Runs (D31 — one row per concrete execution; D34/D46 parent link)
  // -------------------------------------------------------------------------

  createRun(workspaceId: string, run: OperationRun, exec?: DatabaseSync): void {
    const db = exec ?? this.tx.connection();
    if (run.workspace_id !== workspaceId) {
      throw new OperationRecordCorruptError("run workspace_id does not match the scope");
    }
    db.prepare(
      `INSERT INTO operation_runs (
         run_id, workspace_id, operation_id, parent_task_id, state,
         events_seq_cursor, provider_snapshot_json, credits_json, artifacts_json,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.run_id,
      workspaceId,
      run.operation_id,
      run.parent_task_id,
      run.state,
      run.events_seq_cursor,
      run.provider_snapshot === undefined ? null : JSON.stringify(run.provider_snapshot),
      JSON.stringify(run.credits),
      JSON.stringify(run.artifacts),
      run.created_at,
      run.updated_at,
    );
  }

  getRun(
    workspaceId: string,
    operationId: string,
    runId: string,
    exec?: DatabaseSync,
  ): OperationRun | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM operation_runs
         WHERE workspace_id = ? AND operation_id = ? AND run_id = ?`,
      )
      .get(workspaceId, operationId, runId) as OperationRunSqlRow | undefined;
    return row === undefined ? null : this.runFromRow(row);
  }

  /**
   * The operation id that owns ONE run, found from the run row alone (S16
   * chunk 3 — the task-worker run boundary resolves a run's operation without
   * knowing the operation up front). Workspace-scoped (E12): the same run_id
   * under another workspace is a different, unreachable row → null. The
   * composite (workspace_id, operation_id, run_id) key means a run_id is
   * unique per workspace in practice; if a workspace ever held duplicates the
   * FIRST by created_at wins deterministically (the run-creation order).
   */
  findRunOperation(workspaceId: string, runId: string, exec?: DatabaseSync): string | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT operation_id FROM operation_runs
         WHERE workspace_id = ? AND run_id = ?
         ORDER BY created_at, run_id LIMIT 1`,
      )
      .get(workspaceId, runId) as { operation_id: string } | undefined;
    return row === undefined ? null : row.operation_id;
  }

  /**
   * Every run in ONE D8 state across ALL workspaces (S16 chunk 3 — the boot
   * reconciliation read: QUEUED runs re-enter the admission queue after a
   * gateway restart). Runs are parsed through the contract like every other
   * read, so a stored row that no longer conforms fails typed.
   */
  listRunsByState(state: OperationRun["state"], exec?: DatabaseSync): OperationRun[] {
    const db = exec ?? this.tx.connection();
    const rows = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM operation_runs
         WHERE state = ?
         ORDER BY created_at, run_id`,
      )
      .all(state) as unknown as OperationRunSqlRow[];
    return rows.map((row) => this.runFromRow(row));
  }

  listRuns(workspaceId: string, operationId: string, exec?: DatabaseSync): OperationRun[] {
    const db = exec ?? this.tx.connection();
    const rows = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM operation_runs
         WHERE workspace_id = ? AND operation_id = ?
         ORDER BY created_at, run_id`,
      )
      .all(workspaceId, operationId) as unknown as OperationRunSqlRow[];
    return rows.map((row) => this.runFromRow(row));
  }

  updateRunState(
    workspaceId: string,
    operationId: string,
    runId: string,
    state: OperationRun["state"],
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE operation_runs SET state = ?, updated_at = ?
         WHERE workspace_id = ? AND operation_id = ? AND run_id = ?`,
      )
      .run(state, updatedAt, workspaceId, operationId, runId);
    if (Number(result.changes) === 0) {
      throw new OperationRunNotFoundError(workspaceId, operationId, runId);
    }
  }

  updateRunCredits(
    workspaceId: string,
    operationId: string,
    runId: string,
    credits: OperationRun["credits"],
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE operation_runs SET credits_json = ?, updated_at = ?
         WHERE workspace_id = ? AND operation_id = ? AND run_id = ?`,
      )
      .run(JSON.stringify(credits), updatedAt, workspaceId, operationId, runId);
    if (Number(result.changes) === 0) {
      throw new OperationRunNotFoundError(workspaceId, operationId, runId);
    }
  }

  /**
   * Append one artifact id to the run's artifact list. Idempotent: an
   * already-published artifact id is left untouched. The caller guards the
   * contract's 100-artifact cap.
   */
  addRunArtifact(
    workspaceId: string,
    operationId: string,
    runId: string,
    artifactId: string,
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const run = this.getRun(workspaceId, operationId, runId, db);
    if (run === null) {
      throw new OperationRunNotFoundError(workspaceId, operationId, runId);
    }
    if (run.artifacts.includes(artifactId)) {
      return;
    }
    db.prepare(
      `UPDATE operation_runs SET artifacts_json = ?, updated_at = ?
       WHERE workspace_id = ? AND operation_id = ? AND run_id = ?`,
    ).run(
      JSON.stringify([...run.artifacts, artifactId]),
      updatedAt,
      workspaceId,
      operationId,
      runId,
    );
  }

  /**
   * Advance the run's D26 events_seq_cursor to the newly applied stream
   * sequence. Called in the SAME transaction as the run-scoped event append.
   */
  advanceRunCursor(
    workspaceId: string,
    operationId: string,
    runId: string,
    sequence: number,
    updatedAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE operation_runs SET events_seq_cursor = ?, updated_at = ?
         WHERE workspace_id = ? AND operation_id = ? AND run_id = ?`,
      )
      .run(sequence, updatedAt, workspaceId, operationId, runId);
    if (Number(result.changes) === 0) {
      throw new OperationRunNotFoundError(workspaceId, operationId, runId);
    }
  }

  private runFromRow(row: OperationRunSqlRow): OperationRun {
    let parsed: OperationRun;
    try {
      const candidate: Record<string, unknown> = {
        run_id: row.run_id,
        workspace_id: row.workspace_id,
        operation_id: row.operation_id,
        parent_task_id: row.parent_task_id,
        state: row.state,
        events_seq_cursor: Number(row.events_seq_cursor),
        credits: parseJson(row.credits_json, "run credits JSON"),
        artifacts: parseJson(row.artifacts_json, "run artifacts JSON"),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
      if (row.provider_snapshot_json !== null) {
        candidate.provider_snapshot = parseJson(
          row.provider_snapshot_json,
          "run provider snapshot JSON",
        );
      }
      parsed = OperationRun.parse(candidate);
    } catch (error) {
      if (error instanceof OperationRecordCorruptError) {
        throw error;
      }
      throw new OperationRecordCorruptError("operation_runs row");
    }
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Collaboration events (D7 union, D26 per-stream gapless sequences)
  // -------------------------------------------------------------------------

  /**
   * Append one ALREADY-VALIDATED D7 event. Allocates the next 1-based gapless
   * per-stream sequence inside the caller's transaction (or its own short
   * transaction when none is open — nested calls join the outer unit), and
   * advances the run's events_seq_cursor in the SAME transaction for
   * run-scoped events. Duplicate event_id is an idempotent no-op returning
   * the ORIGINAL event with created = false (AC3).
   */
  appendCollaborationEvent(
    workspaceId: string,
    event: OperationCollaborationEvent,
    exec?: DatabaseSync,
  ): { persisted: PersistedCollaborationEvent; created: boolean } {
    return this.tx.transaction((tx) => {
      const db = exec ?? tx;
      const streamId =
        event.run_id === null ? operationChatStreamId(event.operation_id) : event.run_id;

      const existing = this.findCollaborationEvent(workspaceId, event.event_id, db);
      if (existing !== null) {
        return { persisted: existing, created: false };
      }

      const sequence = this.nextStreamSequence(workspaceId, streamId, db);
      const result = db
        .prepare(
          `INSERT INTO operation_collaboration_events
             (workspace_id, stream_id, sequence, event_id, operation_id, run_id,
              type, sender_agent_id, recipient_agent_ids_json, correlation_id,
              payload_json, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, event_id) DO NOTHING`,
        )
        .run(
          workspaceId,
          streamId,
          sequence,
          event.event_id,
          event.operation_id,
          event.run_id,
          event.type,
          event.sender_agent_id,
          JSON.stringify(event.recipient_agent_ids),
          event.correlation_id,
          JSON.stringify(event.payload),
          event.issued_at,
        );

      if (Number(result.changes) === 0) {
        // Lost an idempotency race: the winner's row is the contract.
        const winner = this.findCollaborationEvent(workspaceId, event.event_id, db);
        if (winner === null) {
          throw new OperationRecordCorruptError("collaboration append reported no change");
        }
        return { persisted: winner, created: false };
      }

      if (event.run_id !== null) {
        this.advanceRunCursor(
          workspaceId,
          event.operation_id,
          event.run_id,
          sequence,
          event.issued_at,
          db,
        );
      }

      return {
        persisted: {
          workspace_id: workspaceId,
          operation_id: event.operation_id,
          stream_id: streamId,
          sequence,
          event,
        },
        created: true,
      };
    });
  }

  /**
   * Cursor reads (D26): events of one operation, optionally narrowed to one
   * stream (runId string = that run's stream; runId null = the Operation-chat
   * stream; undefined = every stream of the operation) and to sequences
   * AFTER a cursor. Ordered by stream, then sequence.
   */
  listCollaborationEvents(
    workspaceId: string,
    operationId: string,
    options: { runId?: string | null | undefined; afterSequence?: number | undefined } = {},
    exec?: DatabaseSync,
  ): PersistedCollaborationEvent[] {
    const db = exec ?? this.tx.connection();
    const streamId =
      options.runId === undefined
        ? null
        : options.runId === null
          ? operationChatStreamId(operationId)
          : options.runId;

    const clauses = ["workspace_id = ?", "operation_id = ?"];
    const params: Array<string | number> = [workspaceId, operationId];
    if (streamId !== null) {
      clauses.push("stream_id = ?");
      params.push(streamId);
    }
    if (options.afterSequence !== undefined) {
      clauses.push("sequence > ?");
      params.push(options.afterSequence);
    }

    const rows = db
      .prepare(
        `SELECT ${COLLABORATION_COLUMNS} FROM operation_collaboration_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY stream_id, sequence`,
      )
      .all(...params) as unknown as CollaborationSqlRow[];
    return rows.map((row) => this.collaborationFromRow(row));
  }

  private findCollaborationEvent(
    workspaceId: string,
    eventId: string,
    db: DatabaseSync,
  ): PersistedCollaborationEvent | null {
    const row = db
      .prepare(
        `SELECT ${COLLABORATION_COLUMNS} FROM operation_collaboration_events
         WHERE workspace_id = ? AND event_id = ?`,
      )
      .get(workspaceId, eventId) as CollaborationSqlRow | undefined;
    return row === undefined ? null : this.collaborationFromRow(row);
  }

  /**
   * One persisted collaboration event by its workspace-scoped event_id, or
   * null. Service-level readback (delegation replays report the ORIGINAL
   * event's gapless position without re-appending).
   */
  findCollaborationEventById(
    workspaceId: string,
    eventId: string,
    exec?: DatabaseSync,
  ): PersistedCollaborationEvent | null {
    return this.findCollaborationEvent(workspaceId, eventId, exec ?? this.tx.connection());
  }

  /** Same allocation discipline as the v1 journal: MAX(sequence) + 1, in-transaction. */
  private nextStreamSequence(workspaceId: string, streamId: string, db: DatabaseSync): number {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM operation_collaboration_events
         WHERE workspace_id = ? AND stream_id = ?`,
      )
      .get(workspaceId, streamId) as { next_sequence: number | bigint } | undefined;
    const next = row?.next_sequence;
    if (typeof next === "bigint") {
      return Number(next);
    }
    if (typeof next !== "number") {
      throw new OperationRecordCorruptError(
        "failed to allocate the next collaboration stream sequence",
      );
    }
    return next;
  }

  private collaborationFromRow(row: CollaborationSqlRow): PersistedCollaborationEvent {
    let parsed: OperationCollaborationEvent;
    try {
      parsed = OperationCollaborationEvent.parse({
        event_id: row.event_id,
        workspace_id: row.workspace_id,
        operation_id: row.operation_id,
        run_id: row.run_id,
        sender_agent_id: row.sender_agent_id,
        recipient_agent_ids: parseJson(
          row.recipient_agent_ids_json,
          "collaboration recipients JSON",
        ),
        correlation_id: row.correlation_id,
        issued_at: row.issued_at,
        type: row.type,
        payload: parseJson(row.payload_json, "collaboration payload JSON"),
      });
    } catch (error) {
      if (error instanceof OperationRecordCorruptError) {
        throw error;
      }
      throw new OperationRecordCorruptError("operation_collaboration_events row");
    }
    return {
      workspace_id: row.workspace_id,
      operation_id: row.operation_id,
      stream_id: row.stream_id,
      sequence: Number(row.sequence),
      event: parsed,
    };
  }
}
