/**
 * Trigger-record repository (S28 chunk 1; PRD §8, E5, D11, D23 rule 6, E12,
 * G3) — the only place trigger SQL lives.
 *
 * Two STRICT tables (v19):
 *   - trigger_records  one declarative trigger per row (the scheduler's
 *                      evaluated configuration: kind, per-kind config JSON,
 *                      catch-up policy, state + pause reason, truthful
 *                      bookkeeping the UI renders against the scheduler)
 *   - trigger_firings  the at-least-once LEDGER whose primary key IS the
 *                      idempotency claim (D23 rule 6: idempotency keys are
 *                      data — a duplicate webhook delivery or a replayed
 *                      schedule occurrence is a typed duplicate, never a
 *                      second run)
 *
 * The repository enforces writer-side rules only: closed vocabularies, the
 * D48 pause-reason adjacency rule (an active trigger never carries a pause
 * reason — the schema CHECK backs it), workspace scoping as the primary-key
 * prefix (E12), and a firing whose trigger row does not exist in the SAME
 * workspace is refused (the v5/v7 writer-validates discipline — no FOREIGN
 * KEY is declared). The per-kind CONFIG shape is the schedules service's
 * contract (per-kind Zod schemas validate BEFORE a row exists); the
 * repository guarantees JSON validity and bounded size only.
 */
import type { SqliteExec, SqliteTransactions } from "./transactions.ts";

/** The closed trigger-kind vocabulary (PRD §8's eight categories; the two
 * file scopes share the file_watch kind, distinguished by config). */
export const TRIGGER_KINDS = [
  "schedule",
  "file_watch",
  "git_watch",
  "webhook",
  "task_completion",
  "condition",
  "external_event",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** E5's per-trigger catch-up policy. */
export type TriggerCatchUpPolicy = "catch_up" | "skip";

/** Trigger state (the AC10 pause control's vocabulary). */
export type TriggerState = "active" | "paused";

/** The D48 pause-reason vocabulary (only value this store carries). */
export type TriggerPauseReason = "insufficient_credits";

/** The closed firing-outcome vocabulary (the ledger's rows). */
export const TRIGGER_FIRING_OUTCOMES = [
  "claimed",
  "fired",
  "deduplicated",
  "skipped_catchup",
  "refused_provider",
  "paused_credits",
  "failed",
] as const;
export type TriggerFiringOutcome = (typeof TRIGGER_FIRING_OUTCOMES)[number];

/** Storage failure codes for the trigger boundary (SCREAMING_SNAKE). */
export type TriggersFailureCode =
  | "TRIGGER_ALREADY_EXISTS"
  | "TRIGGER_NOT_FOUND"
  | "TRIGGER_CONFIG_INVALID"
  | "TRIGGER_FIRING_TRIGGER_NOT_FOUND";

export class TriggerRecordError extends Error {
  readonly code: TriggersFailureCode;
  readonly category: "conflict" | "validation" | "state";

  constructor(code: TriggersFailureCode, category: "conflict" | "validation" | "state", message: string) {
    super(`${code}: ${message}`);
    this.name = "TriggerRecordError";
    this.code = code;
    this.category = category;
  }
}

/** One durable trigger record, exactly as the table holds it. */
export interface TriggerRecordRow {
  workspace_id: string;
  trigger_id: string;
  name: string;
  kind: TriggerKind;
  /** The Operation the fired run lands in (service-validated at create). */
  target_operation_id: string;
  /** Validated JSON (the per-kind typed configuration — service contract). */
  config_json: string;
  catch_up_policy: TriggerCatchUpPolicy;
  state: TriggerState;
  pause_reason: TriggerPauseReason | null;
  /** Condition edge memory (0 = was false, 1 = was true; null = never evaluated). */
  last_condition_state: number | null;
  last_fired_at: string | null;
  last_occurrence_at: string | null;
  next_occurrence_at: string | null;
  /** The watcher's observed change signature (the dedup authority). */
  last_signature: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface TriggerRecordInsert {
  workspace_id: string;
  trigger_id: string;
  name: string;
  kind: TriggerKind;
  target_operation_id: string;
  config_json: string;
  catch_up_policy: TriggerCatchUpPolicy;
  state: TriggerState;
  pause_reason: TriggerPauseReason | null;
  next_occurrence_at?: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface TriggerStatePatch {
  state: TriggerState;
  pause_reason: TriggerPauseReason | null;
  updated_at: string;
}

export interface TriggerFieldsPatch {
  name?: string;
  config_json?: string;
  catch_up_policy?: TriggerCatchUpPolicy;
  next_occurrence_at?: string | null;
  last_fired_at?: string | null;
  last_occurrence_at?: string | null;
  last_condition_state?: number | null;
  last_signature?: string | null;
  updated_at: string;
}

export interface TriggerFiringRow {
  workspace_id: string;
  trigger_id: string;
  idempotency_key: string;
  run_id: string | null;
  outcome: TriggerFiringOutcome;
  detail_json: string | null;
  fired_at: string;
}

export interface TriggerFiringInsert {
  workspace_id: string;
  trigger_id: string;
  idempotency_key: string;
  run_id: string | null;
  outcome: TriggerFiringOutcome;
  detail_json: string | null;
  fired_at: string;
}

export interface TriggerFiringPatch {
  run_id?: string | null;
  outcome?: TriggerFiringOutcome;
  detail_json?: string | null;
}

const CONFIG_JSON_MAX = 8_192;
const NAME_MAX = 200;
const IDEMPOTENCY_KEY_MAX = 256;

function validateConfigJson(configJson: string): void {
  if (configJson.length > CONFIG_JSON_MAX) {
    throw new TriggerRecordError(
      "TRIGGER_CONFIG_INVALID",
      "validation",
      `config_json exceeds ${CONFIG_JSON_MAX} characters`,
    );
  }
  try {
    JSON.parse(configJson);
  } catch {
    throw new TriggerRecordError("TRIGGER_CONFIG_INVALID", "validation", "config_json is not valid JSON");
  }
}

export class TriggersRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  createTrigger(input: TriggerRecordInsert, exec?: SqliteExec): void {
    if (input.name.length < 1 || input.name.length > NAME_MAX) {
      throw new TriggerRecordError(
        "TRIGGER_CONFIG_INVALID",
        "validation",
        `name must be 1..${NAME_MAX} characters`,
      );
    }
    validateConfigJson(input.config_json);
    if (input.state === "active" && input.pause_reason !== null) {
      throw new TriggerRecordError(
        "TRIGGER_CONFIG_INVALID",
        "validation",
        "an active trigger cannot carry a pause reason",
      );
    }
    this.write(
      `INSERT INTO trigger_records (
        workspace_id, trigger_id, name, kind, target_operation_id, config_json,
        catch_up_policy, state, pause_reason, last_condition_state,
        last_fired_at, last_occurrence_at, next_occurrence_at,
        created_by_type, created_by_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
      [
        input.workspace_id,
        input.trigger_id,
        input.name,
        input.kind,
        input.target_operation_id,
        input.config_json,
        input.catch_up_policy,
        input.state,
        input.pause_reason,
        input.next_occurrence_at ?? null,
        input.created_by_type,
        input.created_by_id,
        input.created_at,
        input.updated_at,
      ],
      exec,
      (error) => {
        if (isUniqueConflict(error)) {
          return new TriggerRecordError(
            "TRIGGER_ALREADY_EXISTS",
            "conflict",
            `trigger ${input.trigger_id} already exists in workspace ${input.workspace_id}`,
          );
        }
        // A CHECK failure here means the caller bypassed the typed
        // vocabularies — surface it as the named validation refusal (G4),
        // never as an opaque constraint error.
        if (error instanceof Error && error.message.includes("CHECK constraint failed")) {
          return new TriggerRecordError(
            "TRIGGER_CONFIG_INVALID",
            "validation",
            "trigger record violates the storage vocabulary (kind/state/pause-reason CHECK)",
          );
        }
        return null;
      },
    );
  }

  getTrigger(workspaceId: string, triggerId: string): TriggerRecordRow | null {
    return this.readOne(
      `SELECT * FROM trigger_records WHERE workspace_id = ? AND trigger_id = ?`,
      [workspaceId, triggerId],
    );
  }

  listTriggers(workspaceId: string): TriggerRecordRow[] {
    return this.readMany(
      `SELECT * FROM trigger_records WHERE workspace_id = ? ORDER BY created_at, trigger_id`,
      [workspaceId],
    );
  }

  listTriggersByKind(workspaceId: string, kind: TriggerKind): TriggerRecordRow[] {
    return this.readMany(
      `SELECT * FROM trigger_records WHERE workspace_id = ? AND kind = ? ORDER BY created_at`,
      [workspaceId, kind],
    );
  }

  updateTriggerState(workspaceId: string, triggerId: string, patch: TriggerStatePatch): void {
    if (patch.state === "active" && patch.pause_reason !== null) {
      throw new TriggerRecordError(
        "TRIGGER_CONFIG_INVALID",
        "validation",
        "an active trigger cannot carry a pause reason",
      );
    }
    const changed = this.write(
      `UPDATE trigger_records
       SET state = ?, pause_reason = ?, updated_at = ?
       WHERE workspace_id = ? AND trigger_id = ?`,
      [patch.state, patch.pause_reason, patch.updated_at, workspaceId, triggerId],
      undefined,
      () => null,
    );
    if (changed === 0) {
      throw new TriggerRecordError(
        "TRIGGER_NOT_FOUND",
        "state",
        `trigger ${triggerId} not found in workspace ${workspaceId}`,
      );
    }
  }

  updateTriggerFields(workspaceId: string, triggerId: string, patch: TriggerFieldsPatch): void {
    const row = this.getTrigger(workspaceId, triggerId);
    if (row === null) {
      throw new TriggerRecordError(
        "TRIGGER_NOT_FOUND",
        "state",
        `trigger ${triggerId} not found in workspace ${workspaceId}`,
      );
    }
    if (patch.name !== undefined && (patch.name.length < 1 || patch.name.length > NAME_MAX)) {
      throw new TriggerRecordError(
        "TRIGGER_CONFIG_INVALID",
        "validation",
        `name must be 1..${NAME_MAX} characters`,
      );
    }
    if (patch.config_json !== undefined) {
      validateConfigJson(patch.config_json);
    }
    this.write(
      `UPDATE trigger_records
       SET name = ?, config_json = ?, catch_up_policy = ?,
           next_occurrence_at = ?, last_fired_at = ?, last_occurrence_at = ?,
           last_condition_state = ?, last_signature = ?, updated_at = ?
       WHERE workspace_id = ? AND trigger_id = ?`,
      [
        patch.name ?? row.name,
        patch.config_json ?? row.config_json,
        patch.catch_up_policy ?? row.catch_up_policy,
        patch.next_occurrence_at !== undefined ? patch.next_occurrence_at : row.next_occurrence_at,
        patch.last_fired_at !== undefined ? patch.last_fired_at : row.last_fired_at,
        patch.last_occurrence_at !== undefined ? patch.last_occurrence_at : row.last_occurrence_at,
        patch.last_condition_state !== undefined
          ? patch.last_condition_state
          : row.last_condition_state,
        patch.last_signature !== undefined ? patch.last_signature : row.last_signature,
        patch.updated_at,
        workspaceId,
        triggerId,
      ],
      undefined,
      () => null,
    );
  }

  // ── The firing ledger ───────────────────────────────────────────────────────

  /**
   * THE CLAIM (D23 rule 6): insert the firing row keyed by the idempotency
   * key. 'inserted' = this caller owns the occurrence; 'duplicate' = the
   * ledger already holds it (a replayed delivery/occurrence) — the caller
   * answers the recorded outcome and never runs twice.
   */
  recordFiring(input: TriggerFiringInsert): "inserted" | "duplicate" {
    if (input.idempotency_key.length < 1 || input.idempotency_key.length > IDEMPOTENCY_KEY_MAX) {
      throw new TriggerRecordError(
        "TRIGGER_CONFIG_INVALID",
        "validation",
        `idempotency_key must be 1..${IDEMPOTENCY_KEY_MAX} characters`,
      );
    }
    // The trigger must exist in the SAME workspace (the v5/v7 discipline).
    if (this.getTrigger(input.workspace_id, input.trigger_id) === null) {
      throw new TriggerRecordError(
        "TRIGGER_FIRING_TRIGGER_NOT_FOUND",
        "state",
        `trigger ${input.trigger_id} not found in workspace ${input.workspace_id}`,
      );
    }
    try {
      this.write(
        `INSERT INTO trigger_firings (
          workspace_id, trigger_id, idempotency_key, run_id, outcome, detail_json, fired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.workspace_id,
          input.trigger_id,
          input.idempotency_key,
          input.run_id,
          input.outcome,
          input.detail_json,
          input.fired_at,
        ],
        undefined,
        (error) => {
          if (isFiringUniqueConflict(error)) {
            // The ledger already holds this key: the typed duplicate — the
            // caller answers the RECORDED outcome and never runs twice.
            return new FiringDuplicateError();
          }
          return null;
        },
      );
      return "inserted";
    } catch (error) {
      if (error instanceof FiringDuplicateError) {
        return "duplicate";
      }
      throw error;
    }
  }

  findFiring(
    workspaceId: string,
    triggerId: string,
    idempotencyKey: string,
  ): TriggerFiringRow | null {
    return this.readOne(
      `SELECT * FROM trigger_firings
       WHERE workspace_id = ? AND trigger_id = ? AND idempotency_key = ?`,
      [workspaceId, triggerId, idempotencyKey],
    );
  }

  findFiringByRun(workspaceId: string, runId: string): TriggerFiringRow | null {
    return this.readOne(
      `SELECT * FROM trigger_firings WHERE workspace_id = ? AND run_id = ? LIMIT 1`,
      [workspaceId, runId],
    );
  }

  updateFiring(
    workspaceId: string,
    triggerId: string,
    idempotencyKey: string,
    patch: TriggerFiringPatch,
  ): void {
    const row = this.findFiring(workspaceId, triggerId, idempotencyKey);
    if (row === null) {
      throw new TriggerRecordError(
        "TRIGGER_NOT_FOUND",
        "state",
        `firing ${idempotencyKey} not found for trigger ${triggerId}`,
      );
    }
    this.write(
      `UPDATE trigger_firings
       SET run_id = ?, outcome = ?, detail_json = ?
       WHERE workspace_id = ? AND trigger_id = ? AND idempotency_key = ?`,
      [
        patch.run_id !== undefined ? patch.run_id : row.run_id,
        patch.outcome ?? row.outcome,
        patch.detail_json !== undefined ? patch.detail_json : row.detail_json,
        workspaceId,
        triggerId,
        idempotencyKey,
      ],
      undefined,
      () => null,
    );
  }

  listRecentFirings(workspaceId: string, triggerId: string, limit: number): TriggerFiringRow[] {
    return this.readMany(
      `SELECT * FROM trigger_firings
       WHERE workspace_id = ? AND trigger_id = ?
       ORDER BY fired_at DESC, idempotency_key DESC
       LIMIT ?`,
      [workspaceId, triggerId, limit],
    );
  }

  /**
   * The boot re-drive read (at-least-once): claimed firings whose run never
   * landed (a crash between the claim and the run creation). Each gets
   * re-driven once on the next boot/tick; the run side's deterministic ids
   * deduplicate anything half-written.
   */
  claimedFiringsWithoutRun(): TriggerFiringRow[] {
    return this.readMany(
      `SELECT * FROM trigger_firings
       WHERE outcome = 'claimed' AND run_id IS NULL
       ORDER BY fired_at
       LIMIT 100`,
      [],
    );
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private readOne<T>(sql: string, params: readonly string[]): T | null {
    const row = this.tx
      .connection()
      .prepare(sql)
      .get(...params) as Record<string, unknown> | undefined;
    return row ? (row as unknown as T) : null;
  }

  private readMany<T>(sql: string, params: readonly (string | number)[]): T[] {
    return this.tx
      .connection()
      .prepare(sql)
      .all(...params) as unknown as T[];
  }

  private write(
    sql: string,
    params: readonly (string | number | null)[],
    exec: SqliteExec | undefined,
    mapConflict: (error: unknown) => Error | null,
  ): number {
    const conn = exec ?? this.tx.connection();
    try {
      const changes = conn.prepare(sql).run(...params).changes;
      return typeof changes === "bigint" ? Number(changes) : changes;
    } catch (error) {
      const mapped = mapConflict(error);
      if (mapped) throw mapped;
      throw error;
    }
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("trigger_records.workspace_id") &&
    error.message.includes("trigger_records.trigger_id")
  );
}

/** Internal: the firing key already exists (the typed duplicate sentinel). */
class FiringDuplicateError extends Error {
  constructor() {
    super("firing already claimed");
    this.name = "FiringDuplicateError";
  }
}

function isFiringUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("trigger_firings.idempotency_key")
  );
}
