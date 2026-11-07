/**
 * Memory repository (S29 chunk 1; issue #30; PRD §11, D37, AC27, E12, G3) —
 * the only place memory SQL lives, over the v21 STRICT tables.
 *
 * Writer-side rules keep the boundary honest:
 *  - the D37 scope set is the storage layer's CHECK vocabulary; the service
 *    enforces the visibility TABLE (who may read what) on top of it;
 *  - the publication columns are the AC27 boundary state — a private entry
 *    is visible in an Operation's context only through
 *    published_into_operation_id naming THAT operation;
 *  - memory_version is append-only history (version 1 = creation): this
 *    module has no UPDATE statement for history rows and never rewrites one;
 *    an edit/restore/publish appends a NEW version row;
 *  - every read and write is workspace-scoped (E12); writers validate the
 *    referenced rows in the same transaction (no FOREIGN KEY — the v4
 *    discipline);
 *  - no secret ever enters a memory row (G3, D22/E9): the service's
 *    write-time scan runs BEFORE this repository is called.
 */
import type { SqliteExec, SqliteTransactions } from "./transactions.ts";

/** The D37 scope vocabulary (the migration's CHECK set; the contract's enum). */
export type MemoryScopeValue = "account" | "workspace" | "operation" | "task" | "agent_private";

export type MemorySensitivity = "normal" | "sensitive";

/** Where a row came from: an explicit user write or a runtime-mediated automatic write. */
export type MemoryOrigin = "user" | "automatic";

/** The version-history change vocabulary (the migration's CHECK set). */
export type MemoryChangeKind = "created" | "edited" | "published" | "restored" | "auto_updated";

/** The publication-request lifecycle (the migration's CHECK set). */
export type MemoryPublicationStatus = "pending" | "approved" | "dismissed";

/** One memory row (the AC27 publication state rides on it). */
export interface MemoryEntryRow {
  workspace_id: string;
  memory_id: string;
  scope: MemoryScopeValue;
  owner_agent_id: string | null;
  operation_id: string | null;
  task_id: string | null;
  summary: string;
  content: string;
  sensitivity: MemorySensitivity;
  published: 0 | 1;
  published_into_operation_id: string | null;
  published_at: string | null;
  /** JSON-encoded string[] — the D37 provenance references. */
  source_refs: string;
  confidence: number;
  created_by: string;
  origin: MemoryOrigin;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  forgotten_at: string | null;
}

export interface MemoryVersionRow {
  workspace_id: string;
  memory_id: string;
  version: number;
  summary: string;
  content: string;
  sensitivity: MemorySensitivity;
  source_refs: string;
  confidence: number;
  change_kind: MemoryChangeKind;
  changed_by: string;
  created_at: string;
}

export interface MemoryPublicationRequestRow {
  workspace_id: string;
  request_id: string;
  memory_id: string;
  operation_id: string;
  requested_by: string;
  status: MemoryPublicationStatus;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export interface MemorySettingsRow {
  workspace_id: string;
  auto_memory_enabled: 0 | 1;
  updated_at: string;
}

export interface MemoryAgentSettingsRow {
  workspace_id: string;
  agent_id: string;
  auto_memory_enabled: 0 | 1;
  updated_at: string;
}

export interface MemoryEntryInsert {
  workspace_id: string;
  memory_id: string;
  scope: MemoryScopeValue;
  owner_agent_id: string | null;
  operation_id: string | null;
  task_id: string | null;
  summary: string;
  content: string;
  sensitivity: MemorySensitivity;
  /** JSON-encoded string[]. */
  source_refs: string;
  confidence: number;
  created_by: string;
  origin: MemoryOrigin;
  created_at: string;
  expires_at: string | null;
}

export interface MemoryVersionInsert {
  workspace_id: string;
  memory_id: string;
  version: number;
  summary: string;
  content: string;
  sensitivity: MemorySensitivity;
  source_refs: string;
  confidence: number;
  change_kind: MemoryChangeKind;
  changed_by: string;
  created_at: string;
}

export interface MemoryEntryUpdate {
  summary: string;
  content: string;
  sensitivity: MemorySensitivity;
  source_refs: string;
  confidence: number;
  updated_at: string;
  expires_at: string | null;
}

export interface MemoryPublicationRequestInsert {
  workspace_id: string;
  request_id: string;
  memory_id: string;
  operation_id: string;
  requested_by: string;
  status: MemoryPublicationStatus;
  created_at: string;
}

export class MemoryRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MemoryRepositoryError";
    this.code = code;
  }
}

export class MemoryRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  // ── Entries ────────────────────────────────────────────────────────────────

  /** One entry by id, or null. Forgotten rows answer null (gone from active storage). */
  findEntry(workspaceId: string, memoryId: string, exec?: SqliteExec): MemoryEntryRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare(
        "SELECT * FROM memory_entry WHERE workspace_id = ? AND memory_id = ? AND forgotten_at IS NULL",
      )
      .get(workspaceId, memoryId) as Record<string, unknown> | undefined;
    return row ? this.toEntry(row) : null;
  }

  /**
   * EVERY active entry of the workspace (the user's management read — the
   * user's D37 inspect power spans all scopes). Forgotten rows never answer.
   */
  listEntries(workspaceId: string, exec?: SqliteExec): MemoryEntryRow[] {
    const rows = (exec ?? this.tx.connection())
      .prepare(
        "SELECT * FROM memory_entry WHERE workspace_id = ? AND forgotten_at IS NULL ORDER BY updated_at DESC",
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => this.toEntry(row));
  }

  insertEntry(insert: MemoryEntryInsert, exec?: SqliteExec): void {
    (exec ?? this.tx.connection())
      .prepare(
        `INSERT INTO memory_entry (
           workspace_id, memory_id, scope, owner_agent_id, operation_id, task_id,
           summary, content, sensitivity, published, published_into_operation_id,
           published_at, source_refs, confidence, created_by, origin,
           created_at, updated_at, expires_at, forgotten_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        insert.workspace_id,
        insert.memory_id,
        insert.scope,
        insert.owner_agent_id,
        insert.operation_id,
        insert.task_id,
        insert.summary,
        insert.content,
        insert.sensitivity,
        insert.source_refs,
        insert.confidence,
        insert.created_by,
        insert.origin,
        insert.created_at,
        insert.created_at,
        insert.expires_at,
      );
  }

  /** Update the editable fields in place (the entry's CURRENT state; history stays). */
  updateEntry(
    workspaceId: string,
    memoryId: string,
    update: MemoryEntryUpdate,
    exec?: SqliteExec,
  ): void {
    const result = (exec ?? this.tx.connection())
      .prepare(
        `UPDATE memory_entry
         SET summary = ?, content = ?, sensitivity = ?, source_refs = ?, confidence = ?,
             updated_at = ?, expires_at = ?
         WHERE workspace_id = ? AND memory_id = ? AND forgotten_at IS NULL`,
      )
      .run(
        update.summary,
        update.content,
        update.sensitivity,
        update.source_refs,
        update.confidence,
        update.updated_at,
        update.expires_at,
        workspaceId,
        memoryId,
      );
    if (Number(result.changes) !== 1) {
      throw new MemoryRepositoryError("MEMORY_ENTRY_NOT_FOUND", "no active entry row matched");
    }
  }

  /**
   * Record one publication decision on the entry (the AC27 boundary state):
   * approve sets published = 1 INTO the named operation; dismiss on a
   * previously published entry withdraws it (published = 0). One short
   * statement — the caller runs inside its transaction.
   */
  applyPublication(
    workspaceId: string,
    memoryId: string,
    published: boolean,
    operationId: string | null,
    publishedAt: string | null,
    updatedAt: string,
    exec?: SqliteExec,
  ): void {
    const result = (exec ?? this.tx.connection())
      .prepare(
        `UPDATE memory_entry
         SET published = ?, published_into_operation_id = ?, published_at = ?, updated_at = ?
         WHERE workspace_id = ? AND memory_id = ? AND forgotten_at IS NULL`,
      )
      .run(
        published ? 1 : 0,
        published ? operationId : null,
        publishedAt,
        updatedAt,
        workspaceId,
        memoryId,
      );
    if (Number(result.changes) !== 1) {
      throw new MemoryRepositoryError("MEMORY_ENTRY_NOT_FOUND", "no active entry row matched");
    }
  }

  /**
   * Permanently forget (PRD §11): the entry leaves ACTIVE storage — the row
   * is DELETED, history rows are DELETED with it (the user's "permanently"
   * is honored literally; the honest copy says the versions go too).
   */
  forgetEntry(workspaceId: string, memoryId: string, exec?: SqliteExec): void {
    const execRef = exec ?? this.tx.connection();
    execRef
      .prepare("DELETE FROM memory_version WHERE workspace_id = ? AND memory_id = ?")
      .run(workspaceId, memoryId);
    execRef
      .prepare("DELETE FROM memory_publication_request WHERE workspace_id = ? AND memory_id = ?")
      .run(workspaceId, memoryId);
    const result = execRef
      .prepare("DELETE FROM memory_entry WHERE workspace_id = ? AND memory_id = ?")
      .run(workspaceId, memoryId);
    if (Number(result.changes) !== 1) {
      throw new MemoryRepositoryError("MEMORY_ENTRY_NOT_FOUND", "no active entry row matched");
    }
  }

  // ── Version history (append-only) ──────────────────────────────────────────

  insertVersion(insert: MemoryVersionInsert, exec?: SqliteExec): void {
    (exec ?? this.tx.connection())
      .prepare(
        `INSERT INTO memory_version (
           workspace_id, memory_id, version, summary, content, sensitivity,
           source_refs, confidence, change_kind, changed_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        insert.workspace_id,
        insert.memory_id,
        insert.version,
        insert.summary,
        insert.content,
        insert.sensitivity,
        insert.source_refs,
        insert.confidence,
        insert.change_kind,
        insert.changed_by,
        insert.created_at,
      );
  }

  listVersions(workspaceId: string, memoryId: string, exec?: SqliteExec): MemoryVersionRow[] {
    return (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM memory_version
         WHERE workspace_id = ? AND memory_id = ?
         ORDER BY version ASC`,
      )
      .all(workspaceId, memoryId) as unknown as MemoryVersionRow[];
  }

  findVersion(
    workspaceId: string,
    memoryId: string,
    version: number,
    exec?: SqliteExec,
  ): MemoryVersionRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM memory_version
         WHERE workspace_id = ? AND memory_id = ? AND version = ?`,
      )
      .get(workspaceId, memoryId, version) as Record<string, unknown> | undefined;
    return row ? (row as unknown as MemoryVersionRow) : null;
  }

  nextVersion(workspaceId: string, memoryId: string, exec?: SqliteExec): number {
    const row = (exec ?? this.tx.connection())
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS max_version FROM memory_version WHERE workspace_id = ? AND memory_id = ?",
      )
      .get(workspaceId, memoryId) as { max_version: number | bigint };
    return Number(row.max_version) + 1;
  }

  // ── Publication queue ──────────────────────────────────────────────────────

  insertPublicationRequest(insert: MemoryPublicationRequestInsert, exec?: SqliteExec): void {
    (exec ?? this.tx.connection())
      .prepare(
        `INSERT INTO memory_publication_request (
           workspace_id, request_id, memory_id, operation_id, requested_by, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        insert.workspace_id,
        insert.request_id,
        insert.memory_id,
        insert.operation_id,
        insert.requested_by,
        insert.status,
        insert.created_at,
      );
  }

  findPublicationRequest(
    workspaceId: string,
    requestId: string,
    exec?: SqliteExec,
  ): MemoryPublicationRequestRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM memory_publication_request WHERE workspace_id = ? AND request_id = ?")
      .get(workspaceId, requestId) as Record<string, unknown> | undefined;
    return row ? (row as unknown as MemoryPublicationRequestRow) : null;
  }

  findPendingPublicationRequest(
    workspaceId: string,
    memoryId: string,
    exec?: SqliteExec,
  ): MemoryPublicationRequestRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM memory_publication_request
         WHERE workspace_id = ? AND memory_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workspaceId, memoryId) as Record<string, unknown> | undefined;
    return row ? (row as unknown as MemoryPublicationRequestRow) : null;
  }

  listPublicationRequests(workspaceId: string, exec?: SqliteExec): MemoryPublicationRequestRow[] {
    return (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM memory_publication_request
         WHERE workspace_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(workspaceId) as unknown as MemoryPublicationRequestRow[];
  }

  /**
   * Every publication request for one memory, ANY status — the audit-trail
   * reads (the fix-round F18 no-duplicate pin consults it; the pending-only
   * list above is the management queue).
   */
  listPublicationRequestsForMemory(
    workspaceId: string,
    memoryId: string,
    exec?: SqliteExec,
  ): MemoryPublicationRequestRow[] {
    return (exec ?? this.tx.connection())
      .prepare(
        `SELECT * FROM memory_publication_request
         WHERE workspace_id = ? AND memory_id = ?
         ORDER BY created_at ASC`,
      )
      .all(workspaceId, memoryId) as unknown as MemoryPublicationRequestRow[];
  }

  /** Decide one publication request (pending → approved | dismissed). */
  decidePublicationRequest(
    workspaceId: string,
    requestId: string,
    status: Exclude<MemoryPublicationStatus, "pending">,
    decidedBy: string,
    decidedAt: string,
    exec?: SqliteExec,
  ): void {
    const result = (exec ?? this.tx.connection())
      .prepare(
        `UPDATE memory_publication_request
         SET status = ?, decided_by = ?, decided_at = ?
         WHERE workspace_id = ? AND request_id = ? AND status = 'pending'`,
      )
      .run(status, decidedBy, decidedAt, workspaceId, requestId);
    if (Number(result.changes) !== 1) {
      throw new MemoryRepositoryError(
        "MEMORY_PUBLICATION_REQUEST_NOT_PENDING",
        "no pending publication request matched",
      );
    }
  }

  // ── Auto-memory settings ───────────────────────────────────────────────────

  findSettings(workspaceId: string, exec?: SqliteExec): MemorySettingsRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM memory_settings WHERE workspace_id = ?")
      .get(workspaceId) as Record<string, unknown> | undefined;
    return row ? (row as unknown as MemorySettingsRow) : null;
  }

  upsertSettings(
    workspaceId: string,
    enabled: boolean,
    updatedAt: string,
    exec?: SqliteExec,
  ): void {
    (exec ?? this.tx.connection())
      .prepare(
        `INSERT INTO memory_settings (workspace_id, auto_memory_enabled, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET auto_memory_enabled = excluded.auto_memory_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(workspaceId, enabled ? 1 : 0, updatedAt);
  }

  findAgentSettings(
    workspaceId: string,
    agentId: string,
    exec?: SqliteExec,
  ): MemoryAgentSettingsRow | null {
    const row = (exec ?? this.tx.connection())
      .prepare("SELECT * FROM memory_agent_settings WHERE workspace_id = ? AND agent_id = ?")
      .get(workspaceId, agentId) as Record<string, unknown> | undefined;
    return row ? (row as unknown as MemoryAgentSettingsRow) : null;
  }

  upsertAgentSettings(
    workspaceId: string,
    agentId: string,
    enabled: boolean,
    updatedAt: string,
    exec?: SqliteExec,
  ): void {
    (exec ?? this.tx.connection())
      .prepare(
        `INSERT INTO memory_agent_settings (workspace_id, agent_id, auto_memory_enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, agent_id) DO UPDATE
           SET auto_memory_enabled = excluded.auto_memory_enabled, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, agentId, enabled ? 1 : 0, updatedAt);
  }

  listAgentSettings(workspaceId: string, exec?: SqliteExec): MemoryAgentSettingsRow[] {
    return (exec ?? this.tx.connection())
      .prepare("SELECT * FROM memory_agent_settings WHERE workspace_id = ? ORDER BY agent_id ASC")
      .all(workspaceId) as unknown as MemoryAgentSettingsRow[];
  }

  // ── Row mapping ────────────────────────────────────────────────────────────

  private toEntry(row: Record<string, unknown>): MemoryEntryRow {
    return {
      workspace_id: String(row["workspace_id"]),
      memory_id: String(row["memory_id"]),
      scope: row["scope"] as MemoryScopeValue,
      owner_agent_id: (row["owner_agent_id"] as string | null) ?? null,
      operation_id: (row["operation_id"] as string | null) ?? null,
      task_id: (row["task_id"] as string | null) ?? null,
      summary: String(row["summary"]),
      content: String(row["content"]),
      sensitivity: row["sensitivity"] as MemorySensitivity,
      published: Number(row["published"]) === 1 ? 1 : 0,
      published_into_operation_id: (row["published_into_operation_id"] as string | null) ?? null,
      published_at: (row["published_at"] as string | null) ?? null,
      source_refs: String(row["source_refs"]),
      confidence: Number(row["confidence"]),
      created_by: String(row["created_by"]),
      origin: row["origin"] as MemoryOrigin,
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      expires_at: (row["expires_at"] as string | null) ?? null,
      forgotten_at: (row["forgotten_at"] as string | null) ?? null,
    };
  }
}
