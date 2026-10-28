/**
 * Terminal events repository (S18 chunk 1; PRD §4.3, D10, D27, E12, G3) —
 * the only place terminal_events SQL lives.
 *
 * A terminal execution is an ordered record stream in one STRICT table: one
 * `started` row (command, working directory, resource policy, approval
 * state), `output` rows (chunks already REDACTED by the caller's boundary
 * layer — this repository never sees raw secrets it must strip, it only
 * stores what it is given), and one `exit` row. Sequences are 1-based and
 * gapless per (workspace_id, terminal_id), allocated inside the caller's
 * transaction (D10: the recorder writes the row AND its journal entry in one
 * atomic unit; this repository accepts the transactional exec). Every read
 * and write is workspace-scoped (E12).
 *
 * Writer-side rules keep a recorded execution honest: the first row of a
 * terminal is `started` (typed refusal otherwise), output/exit rows arrive
 * only after the start, and nothing arrives after the exit — an execution
 * that ended cannot grow new output. These refusals are typed
 * (TerminalEventsRepositoryError) so the recorder and the read-only API map
 * them, never invent states (G4/G5).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/** The three record kinds of one terminal execution stream. */
export type TerminalRecordKind = "started" | "output" | "exit";

/** Which process pipe a recorded output chunk came from. */
export type TerminalOutputStream = "stdout" | "stderr";

/** The record-time approval posture of the execution (shown truthfully). */
export type TerminalApprovalState = "not_required" | "pending" | "approved" | "rejected";

/** The assembled state of one execution: running until its exit row lands. */
export type TerminalExecutionState = "running" | "exited";

/** The storage cap on one recorded chunk (mirrors the schema CHECK). */
export const TERMINAL_CHUNK_MAX_CHARS = 8_192;

/** Storage failure codes for the terminal boundary (SCREAMING_SNAKE). */
export type TerminalEventsFailureCode =
  | "TERMINAL_ALREADY_STARTED"
  | "TERMINAL_NOT_STARTED"
  | "TERMINAL_ALREADY_EXITED"
  | "TERMINAL_NOT_FOUND";

export class TerminalEventsRepositoryError extends Error {
  readonly code: TerminalEventsFailureCode;
  readonly category: "conflict" | "state";

  constructor(code: TerminalEventsFailureCode, category: "conflict" | "state", message: string) {
    super(`${code}: ${message}`);
    this.name = "TerminalEventsRepositoryError";
    this.code = code;
    this.category = category;
  }
}

export interface TerminalStartRow {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  session_id: string | null;
  command: string;
  workdir: string;
  /** Validated JSON (the schema CHECK enforces json_valid). */
  resource_policy_json: string;
  approval_state: TerminalApprovalState;
  recorded_at: string;
}

export interface TerminalOutputRow {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  stream: TerminalOutputStream;
  /** Already-redacted chunk text (G3: the boundary layer owns redaction). */
  chunk: string;
  recorded_at: string;
}

export interface TerminalExitRow {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  exit_code: number | null;
  exit_signal: string | null;
  recorded_at: string;
}

/** One stored row of any kind, exactly as the table holds it. */
export interface TerminalEventRow {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  session_id: string | null;
  kind: TerminalRecordKind;
  sequence: number;
  command: string | null;
  workdir: string | null;
  resource_policy_json: string | null;
  approval_state: TerminalApprovalState | null;
  stream: TerminalOutputStream | null;
  chunk: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  recorded_at: string;
}

/** One recorded output chunk in the assembled read model. */
export interface TerminalRecordOutputChunk {
  sequence: number;
  stream: TerminalOutputStream;
  text: string;
  recorded_at: string;
}

/** The assembled durable record of one terminal execution. */
export interface TerminalRecord {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  session_id: string | null;
  command: string;
  workdir: string;
  resource_policy: Record<string, unknown>;
  approval_state: TerminalApprovalState;
  state: TerminalExecutionState;
  started_at: string;
  exited_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  output: TerminalRecordOutputChunk[];
}

interface StoredRow {
  workspace_id: string;
  terminal_id: string;
  agent_id: string;
  session_id: string | null;
  kind: string;
  sequence: number | bigint;
  command: string | null;
  workdir: string | null;
  resource_policy_json: string | null;
  approval_state: string | null;
  stream: string | null;
  chunk: string | null;
  exit_code: number | bigint | null;
  exit_signal: string | null;
  recorded_at: string;
}

const ROW_COLUMNS = `workspace_id, terminal_id, agent_id, session_id, kind, sequence,
       command, workdir, resource_policy_json, approval_state, stream, chunk,
       exit_code, exit_signal, recorded_at`;

function numberOrNull(value: number | bigint | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

export class TerminalEventsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  /**
   * The `started` row of one execution — always its sequence 1. Refuses a
   * terminal that already has rows (TERMINAL_ALREADY_STARTED).
   */
  insertStart(row: TerminalStartRow, exec?: DatabaseSync): TerminalEventRow {
    const db = exec ?? this.tx.connection();
    const existing = db
      .prepare(
        "SELECT COUNT(*) AS n FROM terminal_events WHERE workspace_id = ? AND terminal_id = ?",
      )
      .get(row.workspace_id, row.terminal_id) as { n: number | bigint } | undefined;
    if ((existing?.n ?? 0) > 0) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_ALREADY_STARTED",
        "conflict",
        `terminal execution ${row.terminal_id} already started in this workspace`,
      );
    }
    db.prepare(
      `INSERT INTO terminal_events
         (workspace_id, terminal_id, agent_id, session_id, kind, sequence,
          command, workdir, resource_policy_json, approval_state, stream, chunk,
          exit_code, exit_signal, recorded_at)
       VALUES (?, ?, ?, ?, 'started', 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      row.workspace_id,
      row.terminal_id,
      row.agent_id,
      row.session_id,
      row.command,
      row.workdir,
      row.resource_policy_json,
      row.approval_state,
      row.recorded_at,
    );
    return this.requireRowBySequence(row.workspace_id, row.terminal_id, 1, db);
  }

  /**
   * One `output` chunk. Refuses terminals that never started
   * (TERMINAL_NOT_STARTED) or already exited (TERMINAL_ALREADY_EXITED);
   * allocates the next per-terminal sequence in the same transaction.
   */
  appendOutput(row: TerminalOutputRow, exec?: DatabaseSync): TerminalEventRow {
    const db = exec ?? this.tx.connection();
    const started = this.startRow(row.workspace_id, row.terminal_id, db);
    if (!started) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_NOT_STARTED",
        "state",
        `terminal execution ${row.terminal_id} never started in this workspace`,
      );
    }
    this.refuseIfExited(row.workspace_id, row.terminal_id, db);
    const sequence = this.nextSequence(row.workspace_id, row.terminal_id, db);
    db.prepare(
      `INSERT INTO terminal_events
         (workspace_id, terminal_id, agent_id, session_id, kind, sequence,
          command, workdir, resource_policy_json, approval_state, stream, chunk,
          exit_code, exit_signal, recorded_at)
       VALUES (?, ?, ?, NULL, 'output', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?)`,
    ).run(
      row.workspace_id,
      row.terminal_id,
      row.agent_id,
      sequence,
      row.stream,
      row.chunk,
      row.recorded_at,
    );
    return this.requireRowBySequence(row.workspace_id, row.terminal_id, sequence, db);
  }

  /**
   * The `exit` row. Refuses terminals that never started or already exited;
   * an exit is write-once, so the execution's end cannot be rewritten (G5).
   */
  appendExit(row: TerminalExitRow, exec?: DatabaseSync): TerminalEventRow {
    const db = exec ?? this.tx.connection();
    const started = this.startRow(row.workspace_id, row.terminal_id, db);
    if (!started) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_NOT_STARTED",
        "state",
        `terminal execution ${row.terminal_id} never started in this workspace`,
      );
    }
    this.refuseIfExited(row.workspace_id, row.terminal_id, db);
    const sequence = this.nextSequence(row.workspace_id, row.terminal_id, db);
    db.prepare(
      `INSERT INTO terminal_events
         (workspace_id, terminal_id, agent_id, session_id, kind, sequence,
          command, workdir, resource_policy_json, approval_state, stream, chunk,
          exit_code, exit_signal, recorded_at)
       VALUES (?, ?, ?, NULL, 'exit', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      row.workspace_id,
      row.terminal_id,
      row.agent_id,
      sequence,
      row.exit_code,
      row.exit_signal,
      row.recorded_at,
    );
    return this.requireRowBySequence(row.workspace_id, row.terminal_id, sequence, db);
  }

  /** All stored rows of one execution, sequence-ordered (the durable replay). */
  listRows(workspaceId: string, terminalId: string, exec?: DatabaseSync): TerminalEventRow[] {
    const db = exec ?? this.tx.connection();
    const rows = db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM terminal_events
         WHERE workspace_id = ? AND terminal_id = ?
         ORDER BY sequence ASC`,
      )
      .all(workspaceId, terminalId) as unknown as StoredRow[];
    return rows.map(deserializeRow);
  }

  /** The assembled record, or null when no such terminal exists in the workspace. */
  getRecord(workspaceId: string, terminalId: string, exec?: DatabaseSync): TerminalRecord | null {
    const rows = this.listRows(workspaceId, terminalId, exec);
    if (rows.length === 0) {
      return null;
    }
    return assembleRecord(rows);
  }

  /** The assembled record; the typed TERMINAL_NOT_FOUND when absent (E12). */
  requireRecord(workspaceId: string, terminalId: string, exec?: DatabaseSync): TerminalRecord {
    const record = this.getRecord(workspaceId, terminalId, exec);
    if (!record) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_NOT_FOUND",
        "state",
        `no terminal execution with this id exists in the workspace`,
      );
    }
    return record;
  }

  /**
   * The Agent's newest execution (insertion order), or null. Terminal ids are
   * fresh per execution, so the newest `started` row is the current one.
   */
  latestRecord(workspaceId: string, agentId: string, exec?: DatabaseSync): TerminalRecord | null {
    const records = this.listRecordsByAgent(workspaceId, agentId, 1, exec);
    return records[0] ?? null;
  }

  /**
   * The Agent's executions, newest first, assembled to their terminal state.
   * `limit` bounds the assembled records (the panel's recent history).
   */
  listRecordsByAgent(
    workspaceId: string,
    agentId: string,
    limit: number,
    exec?: DatabaseSync,
  ): TerminalRecord[] {
    const db = exec ?? this.tx.connection();
    const startedRows = db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM terminal_events
         WHERE workspace_id = ? AND agent_id = ? AND kind = 'started'
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(workspaceId, agentId, limit) as unknown as StoredRow[];
    const records: TerminalRecord[] = [];
    for (const started of startedRows) {
      const rows = this.listRows(workspaceId, started.terminal_id, db);
      if (rows.length > 0) {
        records.push(assembleRecord(rows));
      }
    }
    return records;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private startRow(workspaceId: string, terminalId: string, db: DatabaseSync): StoredRow | null {
    const row = db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM terminal_events
         WHERE workspace_id = ? AND terminal_id = ? AND kind = 'started'`,
      )
      .get(workspaceId, terminalId) as StoredRow | undefined;
    return row ?? null;
  }

  private refuseIfExited(workspaceId: string, terminalId: string, db: DatabaseSync): void {
    const exited = db
      .prepare(
        "SELECT 1 FROM terminal_events WHERE workspace_id = ? AND terminal_id = ? AND kind = 'exit'",
      )
      .get(workspaceId, terminalId);
    if (exited) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_ALREADY_EXITED",
        "conflict",
        `terminal execution ${terminalId} already exited; its record is closed`,
      );
    }
  }

  private nextSequence(workspaceId: string, terminalId: string, db: DatabaseSync): number {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM terminal_events WHERE workspace_id = ? AND terminal_id = ?",
      )
      .get(workspaceId, terminalId) as { next_sequence: number | bigint } | undefined;
    const next = row?.next_sequence;
    if (typeof next === "bigint") {
      return Number(next);
    }
    if (typeof next !== "number") {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_NOT_STARTED",
        "state",
        "failed to allocate the next terminal sequence",
      );
    }
    return next;
  }

  private requireRowBySequence(
    workspaceId: string,
    terminalId: string,
    sequence: number,
    db: DatabaseSync,
  ): TerminalEventRow {
    const row = db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         FROM terminal_events
         WHERE workspace_id = ? AND terminal_id = ? AND sequence = ?`,
      )
      .get(workspaceId, terminalId, sequence) as StoredRow | undefined;
    if (!row) {
      throw new TerminalEventsRepositoryError(
        "TERMINAL_NOT_FOUND",
        "state",
        `terminal row ${terminalId}#${sequence} vanished inside its own write transaction`,
      );
    }
    return deserializeRow(row);
  }
}

function deserializeRow(row: StoredRow): TerminalEventRow {
  return {
    workspace_id: row.workspace_id,
    terminal_id: row.terminal_id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    kind: row.kind as TerminalRecordKind,
    sequence: numberOrNull(row.sequence) ?? 0,
    command: row.command,
    workdir: row.workdir,
    resource_policy_json: row.resource_policy_json,
    approval_state: (row.approval_state ?? null) as TerminalEventRow["approval_state"],
    stream: (row.stream ?? null) as TerminalEventRow["stream"],
    chunk: row.chunk,
    exit_code: numberOrNull(row.exit_code),
    exit_signal: row.exit_signal,
    recorded_at: row.recorded_at,
  };
}

/**
 * Assemble the read model from the ordered rows. The started row is the
 * record's identity; the exit row (when present) closes it. A malformed
 * started row is unrepresentable by the schema (the column-family CHECKs),
 * so the assembly can trust it — and still refuses honestly if the rows
 * ever disagree (G4, never an invented record).
 */
function assembleRecord(rows: TerminalEventRow[]): TerminalRecord {
  const started = rows.find((row) => row.kind === "started");
  const exit = rows.find((row) => row.kind === "exit");
  if (!started) {
    throw new TerminalEventsRepositoryError(
      "TERMINAL_NOT_FOUND",
      "state",
      "terminal rows exist without a started row; the record is not assembleable",
    );
  }
  let resourcePolicy: Record<string, unknown>;
  try {
    resourcePolicy =
      started.resource_policy_json !== null
        ? (JSON.parse(started.resource_policy_json) as Record<string, unknown>)
        : {};
  } catch {
    throw new TerminalEventsRepositoryError(
      "TERMINAL_NOT_FOUND",
      "state",
      "the terminal's stored resource policy is not valid JSON; the record is not assembleable",
    );
  }
  return {
    workspace_id: started.workspace_id,
    terminal_id: started.terminal_id,
    agent_id: started.agent_id,
    session_id: started.session_id,
    command: started.command ?? "",
    workdir: started.workdir ?? "",
    resource_policy: resourcePolicy,
    approval_state: started.approval_state ?? "not_required",
    state: exit ? "exited" : "running",
    started_at: started.recorded_at,
    exited_at: exit?.recorded_at ?? null,
    exit_code: exit?.exit_code ?? null,
    exit_signal: exit?.exit_signal ?? null,
    output: rows
      .filter((row) => row.kind === "output")
      .map((row) => ({
        sequence: row.sequence,
        stream: (row.stream ?? "stdout") as TerminalOutputStream,
        text: row.chunk ?? "",
        recorded_at: row.recorded_at,
      })),
  };
}
