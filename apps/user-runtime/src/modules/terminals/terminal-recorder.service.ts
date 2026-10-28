/**
 * TerminalRecorder (S18 chunk 1; PRD §4.3, D10, D11, D27, G3) — the runtime
 * boundary every recorded terminal execution passes through.
 *
 * The recorder is the ONLY writer of terminal_events and the ONLY producer
 * of the terminal.* journal vocabulary. Each record method writes the
 * terminal row AND its event-journal entry inside ONE transaction (D10: the
 * row never commits without its journal entry, and the journal entry never
 * commits without its row — a mid-write failure rolls both back), so the
 * durable replay and the stored records can never disagree.
 *
 * G3 boundary: output chunks (and the recorded command/workdir fields) pass
 * through the secret-redaction layer BEFORE anything is built or written —
 * the persisted rows, the journal payloads, and the post-commit WS broadcast
 * (which replays these journal rows) are all clean by construction. Chunks
 * are additionally bounded to the storage cap the schema enforces.
 *
 * Consumers: the session/harness spawn seam wrapper records what the runtime
 * already launches on an Agent's behalf (session-terminal-recorder.ts); the
 * execution slices (S26) will feed real Agent-initiated shell executions
 * through this same surface. The recorder never executes anything itself
 * (G2: agents propose; the runtime validates and executes — this module
 * only RECORDS what the runtime already did).
 */
import { randomUUID } from "node:crypto";

import type { TerminalEventsRepository } from "../../adapters/sqlite/terminal-events-repository.ts";
import { TERMINAL_CHUNK_MAX_CHARS } from "../../adapters/sqlite/terminal-events-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type {
  TerminalApprovalState,
  TerminalOutputStream,
} from "../../adapters/sqlite/terminal-events-repository.ts";
import type { EventsService } from "../events/events.service.ts";
import { terminalStreamFor } from "./terminals.events.ts";
import { redactSecrets } from "./secret-redaction.ts";

/** The redacted operator-fault sink shape (the transport's RedactedLogger). */
export type TerminalFaultLog = (event: string, fields: Record<string, unknown>) => void;

/** The facts of one terminal execution's start, as recorded truthfully. */
export interface TerminalExecutionStartInput {
  workspace_id: string;
  agent_id: string;
  /** The supervised session incarnation when the execution rides one. */
  session_id: string | null;
  command: string;
  workdir: string;
  resource_policy: Record<string, unknown>;
  approval_state: TerminalApprovalState;
}

export interface TerminalExecutionOutputInput {
  workspace_id: string;
  agent_id: string;
  terminal_id: string;
  stream: TerminalOutputStream;
  /** The RAW chunk; the recorder redacts and bounds it before persistence. */
  raw_chunk: string;
}

export interface TerminalExecutionExitInput {
  workspace_id: string;
  agent_id: string;
  terminal_id: string;
  exit_code: number | null;
  exit_signal: string | null;
}

export interface TerminalRecorderDeps {
  tx: SqliteTransactions;
  terminals: TerminalEventsRepository;
  events: Pick<EventsService, "appendEvent">;
  /** Contained operator-fault sink (callers own the redaction discipline). */
  logFault?: TerminalFaultLog | undefined;
  /** Injectable clock for the rows' recorded_at stamps; default wall clock. */
  now?: (() => string) | undefined;
}

export class TerminalRecorder {
  constructor(private readonly deps: TerminalRecorderDeps) {}

  /**
   * Record the start of one terminal execution: the `started` row and the
   * `terminal.started` journal entry commit in ONE transaction (D10).
   * Returns the fresh terminal id.
   */
  startExecution(input: TerminalExecutionStartInput): string {
    const terminalId = `term-${randomUUID()}`;
    const recordedAt = this.now();
    // G3: the recorded fields pass the same redaction boundary as output
    // chunks — a credential riding a command line never reaches storage.
    const command = redactSecrets(input.command);
    const workdir = redactSecrets(input.workdir);
    this.deps.tx.transaction((exec) => {
      this.deps.terminals.insertStart(
        {
          workspace_id: input.workspace_id,
          terminal_id: terminalId,
          agent_id: input.agent_id,
          session_id: input.session_id,
          command,
          workdir,
          resource_policy_json: JSON.stringify(input.resource_policy),
          approval_state: input.approval_state,
          recorded_at: recordedAt,
        },
        exec,
      );
      this.deps.events.appendEvent({
        event_id: randomUUID(),
        stream_id: terminalStreamFor(input.workspace_id, input.agent_id),
        type: "terminal.started",
        payload: {
          workspace_id: input.workspace_id,
          agent_id: input.agent_id,
          terminal_id: terminalId,
          session_id: input.session_id,
          command,
          workdir,
          resource_policy: input.resource_policy,
          approval_state: input.approval_state,
        },
        workspace_id: input.workspace_id,
        correlation_id: `agent-terminal:${input.workspace_id}:${input.agent_id}`,
      });
    });
    return terminalId;
  }

  /**
   * Record one output chunk: REDACT and bound first (G3), then the `output`
   * row and the `terminal.output` journal entry commit in ONE transaction.
   */
  recordOutput(input: TerminalExecutionOutputInput): void {
    const text = redactSecrets(input.raw_chunk).slice(0, TERMINAL_CHUNK_MAX_CHARS);
    const recordedAt = this.now();
    this.deps.tx.transaction((exec) => {
      this.deps.terminals.appendOutput(
        {
          workspace_id: input.workspace_id,
          terminal_id: input.terminal_id,
          agent_id: input.agent_id,
          stream: input.stream,
          chunk: text,
          recorded_at: recordedAt,
        },
        exec,
      );
      this.deps.events.appendEvent({
        event_id: randomUUID(),
        stream_id: terminalStreamFor(input.workspace_id, input.agent_id),
        type: "terminal.output",
        payload: {
          workspace_id: input.workspace_id,
          agent_id: input.agent_id,
          terminal_id: input.terminal_id,
          stream: input.stream,
          text,
        },
        workspace_id: input.workspace_id,
        correlation_id: `agent-terminal:${input.workspace_id}:${input.agent_id}`,
      });
    });
  }

  /**
   * Record the execution's exit: the `exit` row and the `terminal.exited`
   * journal entry commit in ONE transaction. Write-once — the repository
   * refuses a second exit (G5: never silently rewrite a recorded end).
   */
  recordExit(input: TerminalExecutionExitInput): void {
    const recordedAt = this.now();
    this.deps.tx.transaction((exec) => {
      this.deps.terminals.appendExit(
        {
          workspace_id: input.workspace_id,
          terminal_id: input.terminal_id,
          agent_id: input.agent_id,
          exit_code: input.exit_code,
          exit_signal: input.exit_signal,
          recorded_at: recordedAt,
        },
        exec,
      );
      this.deps.events.appendEvent({
        event_id: randomUUID(),
        stream_id: terminalStreamFor(input.workspace_id, input.agent_id),
        type: "terminal.exited",
        payload: {
          workspace_id: input.workspace_id,
          agent_id: input.agent_id,
          terminal_id: input.terminal_id,
          exit_code: input.exit_code,
          exit_signal: input.exit_signal,
        },
        workspace_id: input.workspace_id,
        correlation_id: `agent-terminal:${input.workspace_id}:${input.agent_id}`,
      });
    });
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }
}
