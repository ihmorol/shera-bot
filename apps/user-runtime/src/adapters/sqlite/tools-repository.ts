/**
 * Tools repository (S21 chunk 1; PRD §7, E4, E13, E12, D23 rule 2, G3) — the
 * storage adapter behind the runtime-owned tool executor: agent-created tool
 * inventory rows (E4's declarative, versioned records), the execution history
 * the tool-call UI and tool history read, the runtime-owned activation grants
 * (E4: activation requires a runtime grant), and the disablements that beat
 * any grant (AC6 — the executor consults them BEFORE the approval machinery).
 *
 * G3 boundary: the args summary and result summary columns arrive PRE-REDACTED
 * and bounded from the executor (the redaction layer runs before any write) —
 * this repository never receives raw arguments and never redacts itself; it
 * stores exactly what the boundary handed it, so the redaction cannot drift
 * between surfaces.
 *
 * E12: every table is keyed (workspace_id, ...) — the same tool_id or
 * execution_id in two workspaces are independent row spaces.
 */
import type { RecoveryClass, ResourceLimits, RiskClass } from "@shera-bot/contracts";

/**
 * Lifecycle states of an agent-created tool (E4): `created` rows exist in the
 * inventory but are not yet usable (risky tools wait for the activation
 * decision); `active` rows are usable subject to the executor's checks;
 * `disabled` rows refuse execution regardless of any grant.
 */
export type ToolLifecycleState = "created" | "active" | "disabled";

/** One agent-created inventory row (E4's declarative record). */
export interface AgentToolRecord {
  workspace_id: string;
  tool_id: string;
  version: string;
  name: string;
  purpose: string;
  owner_kind: "platform" | "agent";
  owner_agent_id: string | null;
  inventory_scope: "private" | "shared";
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  capabilities: string[];
  risk_class: RiskClass;
  timeout_ms: number;
  resource_limits: ResourceLimits;
  redaction_policy: "standard" | "strict";
  approval_policy: "auto_read_only" | "preview_required" | "approval_required";
  /** E13 recovery class — stored data, defaulted to needs_human at the column. */
  recovery: RecoveryClass;
  state: ToolLifecycleState;
  enabled: 0 | 1;
  max_response_bytes: number;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/** The insert input: recovery is optional — the column default supplies needs_human. */
export type AgentToolInsert = Omit<AgentToolRecord, "recovery" | "updated_at"> & {
  recovery?: RecoveryClass;
  updated_at?: string | null;
};

/** Execution statuses in ladder vocabulary (the tool-call card's lifecycle). */
export type ToolExecutionStatus =
  | "proposed"
  | "validated"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

/** One executor-mediated execution — the tool history row (G3 fields only). */
export interface ToolExecutionRecord {
  workspace_id: string;
  execution_id: string;
  task_id: string;
  conversation_id: string;
  agent_id: string;
  tool_id: string;
  tool_version: string;
  capability: string;
  risk_class: RiskClass;
  recovery: RecoveryClass;
  args_digest: string;
  /** Bounded, PRE-REDACTED arguments summary — never raw arguments. */
  args_summary: string;
  /** The D35 preview payload (diff/command/target effect) — pure, pre-recorded. */
  preview: Record<string, unknown> | null;
  status: ToolExecutionStatus;
  approval_id: string | null;
  grant_id: string | null;
  error_code: string | null;
  /** Bounded, PRE-REDACTED result text — never raw unredacted payloads. */
  result_summary: string | null;
  timeout_ms: number;
  max_response_bytes: number;
  resource_limits: ResourceLimits;
  started_at: string;
  finished_at: string | null;
}

/** The runtime-owned activation grant (E4). Created in ONE place only. */
export interface ToolActivationGrantRecord {
  workspace_id: string;
  tool_id: string;
  tool_version: string;
  target_kind: "agent" | "operation" | "workspace";
  target_id: string;
  granted_by: string;
  granted_at: string;
  revoked_at: string | null;
}

/** Executor update payload for a settled execution. */
export interface ExecutionResultUpdate {
  status: ToolExecutionStatus;
  result_summary: string | null;
  finished_at: string | null;
  error_code: string | null;
  grant_id?: string | null;
  approval_id?: string | null;
  preview?: Record<string, unknown> | null;
}

const AGENT_TOOL_COLUMNS = `
  workspace_id, tool_id, version, name, purpose, owner_kind, owner_agent_id,
  inventory_scope, input_schema_json, output_schema_json, capabilities_json,
  risk_class, timeout_ms, resource_limits_json, redaction_policy,
  approval_policy, recovery, state, enabled, max_response_bytes,
  created_by_agent_id, created_at, updated_at`;

const EXECUTION_COLUMNS = `
  workspace_id, execution_id, task_id, conversation_id, agent_id, tool_id,
  tool_version, capability, risk_class, recovery, args_digest, args_summary,
  preview_json, status, approval_id, grant_id, error_code, result_summary,
  timeout_ms, max_response_bytes, resource_limits_json, started_at, finished_at`;

function agentToolRowToRecord(row: Record<string, unknown>): AgentToolRecord {
  return {
    workspace_id: row.workspace_id as string,
    tool_id: row.tool_id as string,
    version: row.version as string,
    name: row.name as string,
    purpose: row.purpose as string,
    owner_kind: row.owner_kind as AgentToolRecord["owner_kind"],
    owner_agent_id: (row.owner_agent_id as string | null) ?? null,
    inventory_scope: row.inventory_scope as AgentToolRecord["inventory_scope"],
    input_schema: JSON.parse(row.input_schema_json as string) as Record<string, unknown>,
    output_schema: JSON.parse(row.output_schema_json as string) as Record<string, unknown>,
    capabilities: JSON.parse(row.capabilities_json as string) as string[],
    risk_class: row.risk_class as RiskClass,
    timeout_ms: row.timeout_ms as number,
    resource_limits: JSON.parse(row.resource_limits_json as string) as ResourceLimits,
    redaction_policy: row.redaction_policy as AgentToolRecord["redaction_policy"],
    approval_policy: row.approval_policy as AgentToolRecord["approval_policy"],
    recovery: row.recovery as RecoveryClass,
    state: row.state as ToolLifecycleState,
    enabled: row.enabled === 1 ? 1 : 0,
    max_response_bytes: row.max_response_bytes as number,
    created_by_agent_id: (row.created_by_agent_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

function executionRowToRecord(row: Record<string, unknown>): ToolExecutionRecord {
  return {
    workspace_id: row.workspace_id as string,
    execution_id: row.execution_id as string,
    task_id: row.task_id as string,
    conversation_id: row.conversation_id as string,
    agent_id: row.agent_id as string,
    tool_id: row.tool_id as string,
    tool_version: row.tool_version as string,
    capability: row.capability as string,
    risk_class: row.risk_class as RiskClass,
    recovery: row.recovery as RecoveryClass,
    args_digest: row.args_digest as string,
    args_summary: row.args_summary as string,
    preview: row.preview_json
      ? (JSON.parse(row.preview_json as string) as Record<string, unknown>)
      : null,
    status: row.status as ToolExecutionStatus,
    approval_id: (row.approval_id as string | null) ?? null,
    grant_id: (row.grant_id as string | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    result_summary: (row.result_summary as string | null) ?? null,
    timeout_ms: row.timeout_ms as number,
    max_response_bytes: row.max_response_bytes as number,
    resource_limits: JSON.parse(row.resource_limits_json as string) as ResourceLimits,
    started_at: row.started_at as string,
    finished_at: (row.finished_at as string | null) ?? null,
  };
}

export class ToolsRepository {
  constructor(private readonly db: import("node:sqlite").DatabaseSync) {}

  // -------------------------------------------------------------------------
  // Agent-created tool inventory (E4)
  // -------------------------------------------------------------------------

  insertAgentTool(record: AgentToolInsert, exec?: import("node:sqlite").DatabaseSync): void {
    const db = exec ?? this.db;
    db.prepare(
      `INSERT INTO tool_inventory
         (${AGENT_TOOL_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.workspace_id,
      record.tool_id,
      record.version,
      record.name,
      record.purpose,
      record.owner_kind,
      record.owner_agent_id,
      record.inventory_scope,
      JSON.stringify(record.input_schema),
      JSON.stringify(record.output_schema),
      JSON.stringify(record.capabilities),
      record.risk_class,
      record.timeout_ms,
      JSON.stringify(record.resource_limits),
      record.redaction_policy,
      record.approval_policy,
      record.recovery ?? "needs_human",
      record.state,
      record.enabled,
      record.max_response_bytes,
      record.created_by_agent_id,
      record.created_at,
      record.updated_at ?? null,
    );
  }

  getAgentTool(
    workspaceId: string,
    toolId: string,
    version: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): AgentToolRecord | null {
    const db = exec ?? this.db;
    const row = db
      .prepare(
        `SELECT ${AGENT_TOOL_COLUMNS} FROM tool_inventory
         WHERE workspace_id = ? AND tool_id = ? AND version = ?`,
      )
      .get(workspaceId, toolId, version) as Record<string, unknown> | undefined;
    return row ? agentToolRowToRecord(row) : null;
  }

  listAgentTools(
    workspaceId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): AgentToolRecord[] {
    const db = exec ?? this.db;
    const rows = db
      .prepare(
        `SELECT ${AGENT_TOOL_COLUMNS} FROM tool_inventory
         WHERE workspace_id = ? ORDER BY tool_id, version`,
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map(agentToolRowToRecord);
  }

  updateAgentToolState(
    workspaceId: string,
    toolId: string,
    version: string,
    state: ToolLifecycleState,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    const result = db
      .prepare(
        `UPDATE tool_inventory SET state = ? WHERE workspace_id = ? AND tool_id = ? AND version = ?`,
      )
      .run(state, workspaceId, toolId, version);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Activation grants (E4 — the runtime grant, created in ONE place)
  // -------------------------------------------------------------------------

  /**
   * Record one activation grant. False (and no write) when the exact grant
   * already exists — the primary key makes a duplicate unrepresentable, so a
   * replayed activation answers "already granted" instead of double-writing
   * (D23 rule 6). The insert input carries no revoked_at: grants are born
   * live and only ever revoked through revokeActivationGrant.
   */
  recordActivationGrant(
    record: Omit<ToolActivationGrantRecord, "revoked_at">,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    try {
      const result = db
        .prepare(
          `INSERT INTO tool_activation_grants
             (workspace_id, tool_id, tool_version, target_kind, target_id, granted_by, granted_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          record.workspace_id,
          record.tool_id,
          record.tool_version,
          record.target_kind,
          record.target_id,
          record.granted_by,
          record.granted_at,
        );
      return Number(result.changes) > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        return false;
      }
      throw error;
    }
  }

  hasActivationGrant(
    workspaceId: string,
    toolId: string,
    toolVersion: string,
    targetKind: ToolActivationGrantRecord["target_kind"],
    targetId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    const row = db
      .prepare(
        `SELECT 1 FROM tool_activation_grants
         WHERE workspace_id = ? AND tool_id = ? AND tool_version = ?
           AND target_kind = ? AND target_id = ? AND revoked_at IS NULL`,
      )
      .get(workspaceId, toolId, toolVersion, targetKind, targetId);
    return row !== undefined;
  }

  listActivationGrants(
    workspaceId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): ToolActivationGrantRecord[] {
    const db = exec ?? this.db;
    const rows = db
      .prepare(`SELECT * FROM tool_activation_grants WHERE workspace_id = ? ORDER BY granted_at`)
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      workspace_id: row.workspace_id as string,
      tool_id: row.tool_id as string,
      tool_version: row.tool_version as string,
      target_kind: row.target_kind as ToolActivationGrantRecord["target_kind"],
      target_id: row.target_id as string,
      granted_by: row.granted_by as string,
      granted_at: row.granted_at as string,
      revoked_at: (row.revoked_at as string | null) ?? null,
    }));
  }

  revokeActivationGrant(
    workspaceId: string,
    toolId: string,
    toolVersion: string,
    targetKind: ToolActivationGrantRecord["target_kind"],
    targetId: string,
    revokedAt: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    const result = db
      .prepare(
        `UPDATE tool_activation_grants SET revoked_at = ?
         WHERE workspace_id = ? AND tool_id = ? AND tool_version = ?
           AND target_kind = ? AND target_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, workspaceId, toolId, toolVersion, targetKind, targetId);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Disablements (AC6 — the switch that beats any grant)
  // -------------------------------------------------------------------------

  insertDisablement(
    workspaceId: string,
    toolId: string,
    disabledBy: string,
    disabledAt: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): void {
    const db = exec ?? this.db;
    db.prepare(
      `INSERT OR IGNORE INTO tool_disablements (workspace_id, tool_id, disabled_by, disabled_at)
       VALUES (?, ?, ?, ?)`,
    ).run(workspaceId, toolId, disabledBy, disabledAt);
  }

  deleteDisablement(
    workspaceId: string,
    toolId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    const result = db
      .prepare(`DELETE FROM tool_disablements WHERE workspace_id = ? AND tool_id = ?`)
      .run(workspaceId, toolId);
    return Number(result.changes) > 0;
  }

  isDisabled(
    workspaceId: string,
    toolId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    return (
      db
        .prepare(`SELECT 1 FROM tool_disablements WHERE workspace_id = ? AND tool_id = ?`)
        .get(workspaceId, toolId) !== undefined
    );
  }

  listDisablements(
    workspaceId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): Array<{ tool_id: string; disabled_by: string; disabled_at: string }> {
    const db = exec ?? this.db;
    const rows = db
      .prepare(
        `SELECT tool_id, disabled_by, disabled_at FROM tool_disablements
         WHERE workspace_id = ? ORDER BY disabled_at`,
      )
      .all(workspaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      tool_id: row.tool_id as string,
      disabled_by: row.disabled_by as string,
      disabled_at: row.disabled_at as string,
    }));
  }

  // -------------------------------------------------------------------------
  // Execution history (the tool history + tool-call card read model)
  // -------------------------------------------------------------------------

  insertExecution(record: ToolExecutionRecord, exec?: import("node:sqlite").DatabaseSync): void {
    const db = exec ?? this.db;
    db.prepare(
      `INSERT INTO tool_execution_history
         (${EXECUTION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.workspace_id,
      record.execution_id,
      record.task_id,
      record.conversation_id,
      record.agent_id,
      record.tool_id,
      record.tool_version,
      record.capability,
      record.risk_class,
      record.recovery,
      record.args_digest,
      record.args_summary,
      record.preview ? JSON.stringify(record.preview) : null,
      record.status,
      record.approval_id,
      record.grant_id,
      record.error_code,
      record.result_summary,
      record.timeout_ms,
      record.max_response_bytes,
      JSON.stringify(record.resource_limits),
      record.started_at,
      record.finished_at,
    );
  }

  getExecution(
    workspaceId: string,
    executionId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): ToolExecutionRecord | null {
    const db = exec ?? this.db;
    const row = db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM tool_execution_history
         WHERE workspace_id = ? AND execution_id = ?`,
      )
      .get(workspaceId, executionId) as Record<string, unknown> | undefined;
    return row ? executionRowToRecord(row) : null;
  }

  updateExecutionResult(
    workspaceId: string,
    executionId: string,
    update: ExecutionResultUpdate,
    exec?: import("node:sqlite").DatabaseSync,
  ): boolean {
    const db = exec ?? this.db;
    const result = db
      .prepare(
        `UPDATE tool_execution_history SET
           status = ?,
           result_summary = ?,
           finished_at = ?,
           error_code = ?,
           grant_id = COALESCE(?, grant_id),
           approval_id = COALESCE(?, approval_id),
           preview_json = COALESCE(?, preview_json)
         WHERE workspace_id = ? AND execution_id = ?`,
      )
      .run(
        update.status,
        update.result_summary,
        update.finished_at,
        update.error_code,
        update.grant_id ?? null,
        update.approval_id ?? null,
        update.preview ? JSON.stringify(update.preview) : null,
        workspaceId,
        executionId,
      );
    return Number(result.changes) > 0;
  }

  listExecutionsByTask(
    workspaceId: string,
    taskId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): ToolExecutionRecord[] {
    const db = exec ?? this.db;
    const rows = db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM tool_execution_history
         WHERE workspace_id = ? AND task_id = ? ORDER BY started_at, execution_id`,
      )
      .all(workspaceId, taskId) as Record<string, unknown>[];
    return rows.map(executionRowToRecord);
  }

  listExecutionsByTool(
    workspaceId: string,
    toolId: string,
    exec?: import("node:sqlite").DatabaseSync,
  ): ToolExecutionRecord[] {
    const db = exec ?? this.db;
    const rows = db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM tool_execution_history
         WHERE workspace_id = ? AND tool_id = ? ORDER BY started_at, execution_id`,
      )
      .all(workspaceId, toolId) as Record<string, unknown>[];
    return rows.map(executionRowToRecord);
  }
}
