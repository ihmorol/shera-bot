/**
 * S18 chunk 1 — the read-only terminal live-views HTTP API (issue #19; PRD
 * §4.3, §14, §19 AC19/AC21, §20, D11, E12, G3/G6).
 *
 * ---------------------------------------------------------------------------
 * The HTTP surface
 *
 * Three GET routes expose what the terminal recorder durably stored:
 *
 *   GET /v1/terminals/events  — the durable replay of one Agent's terminal
 *     journal stream (`terminal:<workspace_id>:<agent_id>`), cursor-paged by
 *     the D26 per-stream sequence (after_sequence), optionally narrowed to
 *     one terminal execution. This is what a reconnecting panel replays.
 *
 *   GET /v1/terminals/state   — the Agent's CURRENT session terminal state:
 *     the latest execution (running or exited) plus the recent history, as
 *    sembled from terminal_events rows.
 *
 *   GET /v1/terminals/:terminal_id — one execution's durable record: the
 *     command, working directory, resource policy, approval state, the
 *     redacted output chunks in order, and the exit.
 *
 * THE NO-TAKEOVER ACCEPTANCE CRITERION IS THE ROUTE INVENTORY ITSELF: the
 * surface contains ZERO terminal-control routes — no stdin write, no signal
 * send, no command execution — because the runtime offers no terminal control
 * at all in this slice (PRD §4.3: the user receives a live shared READ-ONLY
 * view; §20: direct takeover is future work). The routes are reads only; any
 * non-GET verb on these paths answers the typed ROUTE_NOT_FOUND (there is no
 * mutation handler to hit), and the module's contract test enumerates the
 * registered routes and asserts the exact inventory.
 *
 * Every route is workspace-scoped (E12): the workspace_id is required on
 * every read, and every repository/journal call is workspace-keyed — another
 * workspace's terminal activity is invisible, and an unknown terminal in the
 * reading workspace is the typed TERMINAL_NOT_FOUND 404, never a guessed
 * record (G4). Output chunks were REDACTED before persistence (G3), so these
 * responses are clean by construction; nothing here re-derives content.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Express } from "express";

import { WorkspaceId } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type {
  TerminalEventsRepository,
  TerminalRecord,
} from "../../adapters/sqlite/terminal-events-repository.ts";
import { TerminalEventsRepositoryError } from "../../adapters/sqlite/terminal-events-repository.ts";
import { terminalStreamFor } from "../../modules/terminals/terminals.events.ts";
import { contractValidationResponse } from "../http/typed-errors.ts";

// ---------------------------------------------------------------------------
// Route paths (the contracts convention: literal constants, one definition)
// ---------------------------------------------------------------------------

/** GET — the durable replay of one Agent's terminal journal stream. */
export const LIST_TERMINAL_EVENTS_PATH = "/v1/terminals/events" as const;
/** GET — one Agent's current session terminal state (latest + recent). */
export const GET_TERMINAL_STATE_PATH = "/v1/terminals/state" as const;
/** GET — one execution's assembled durable record. */
export const GET_TERMINAL_PATH = "/v1/terminals/:terminal_id" as const;

/** The composed handle: the routes never touch SQL and never re-derive. */
export interface TerminalsApiHandle {
  listTerminalEvents(input: {
    workspaceId: string;
    agentId: string;
    afterSequence: number;
    limit: number;
    terminalId?: string | undefined;
  }): {
    events: Array<{
      sequence: number;
      event_id: string;
      type: string;
      occurred_at: string;
      payload: Record<string, unknown>;
    }>;
    next_after_sequence: number;
  };
  getTerminal(workspaceId: string, terminalId: string): TerminalRecord;
  getTerminalState(
    workspaceId: string,
    agentId: string,
  ): { agent_id: string; current: TerminalRecord | null; recent: TerminalRecord[] };
}

/** The recent-history window the state route assembles. */
const STATE_RECENT_LIMIT = 10;

/** The journal replay batch cap (matches the S16/S20 read-model replays). */
const JOURNAL_REPLAY_LIMIT_CAP = 1_000;
const JOURNAL_REPLAY_LIMIT_DEFAULT = 200;

export function buildLiveViewsApiHandle(deps: {
  terminals: TerminalEventsRepository;
  journal: Pick<EventJournalRepository, "readFrom">;
}): TerminalsApiHandle {
  return {
    listTerminalEvents(input) {
      const streamId = terminalStreamFor(input.workspaceId, input.agentId);
      const rows = deps.journal.readFrom(
        input.workspaceId,
        streamId,
        input.afterSequence,
        input.limit,
      );
      const events = rows
        .map((row) => ({
          sequence: row.sequence,
          event_id: row.event_id,
          type: row.event_type,
          occurred_at: row.occurred_at,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        }))
        .filter((event) =>
          input.terminalId === undefined
            ? true
            : (event.payload["terminal_id"] as string | undefined) === input.terminalId,
        );
      return {
        events,
        next_after_sequence:
          rows.length > 0 ? (rows[rows.length - 1]?.sequence ?? 0) : input.afterSequence,
      };
    },

    getTerminal(workspaceId, terminalId) {
      return deps.terminals.requireRecord(workspaceId, terminalId);
    },

    getTerminalState(workspaceId, agentId) {
      const recent = deps.terminals.listRecordsByAgent(workspaceId, agentId, STATE_RECENT_LIMIT);
      return {
        agent_id: agentId,
        current: recent[0] ?? null,
        recent,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The routes (registered into the shared app; reads only, E12 everywhere)
// ---------------------------------------------------------------------------

/** E12: every read takes the workspace from the query. */
const TerminalWorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

const AgentScopedQuery = z.strictObject({
  workspace_id: WorkspaceId,
  agent_id: z.string().min(1).max(256),
});

const TerminalEventsQuery = z.strictObject({
  workspace_id: WorkspaceId,
  agent_id: z.string().min(1).max(256),
  after_sequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(JOURNAL_REPLAY_LIMIT_CAP)
    .default(JOURNAL_REPLAY_LIMIT_DEFAULT),
  terminal_id: z.string().min(1).max(256).optional(),
});

/**
 * Register the live-views routes. ORDER MATTERS: the literal-segment paths
 (/v1/terminals/events, /v1/terminals/state) register BEFORE the
 * :terminal_id capture (Express matches in registration order — the same
 * discipline as the S15/S20 modules).
 */
export function registerLiveViewsRoutes(app: Express, deps: TerminalsApiHandle): void {
  // GET /v1/terminals/events — the durable terminal replay (cursor-paged).
  app.get(LIST_TERMINAL_EVENTS_PATH, (req, res) => {
    const query = TerminalEventsQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The terminal replay request is not valid: a workspace_id and an agent_id are required.",
          ),
        );
      return;
    }
    res.status(200).json(
      deps.listTerminalEvents({
        workspaceId: query.data.workspace_id,
        agentId: query.data.agent_id,
        afterSequence: query.data.after_sequence,
        limit: query.data.limit,
        ...(query.data.terminal_id !== undefined ? { terminalId: query.data.terminal_id } : {}),
      }),
    );
  });

  // GET /v1/terminals/state — the current session terminal state (latest
  // execution + recent history). Registered before the :terminal_id capture.
  app.get(GET_TERMINAL_STATE_PATH, (req, res) => {
    const query = AgentScopedQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The terminal state request is not valid: a workspace_id and an agent_id are required.",
          ),
        );
      return;
    }
    res.status(200).json(deps.getTerminalState(query.data.workspace_id, query.data.agent_id));
  });

  // GET /v1/terminals/:terminal_id — one execution's durable record. Unknown
  // id in the workspace (or another workspace's id): the typed 404 (E12).
  app.get(GET_TERMINAL_PATH, (req, res) => {
    const terminalId = z.string().min(1).max(256).safeParse(req.params.terminal_id);
    const query = TerminalWorkspaceQuery.safeParse(req.query);
    if (!terminalId.success || !query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The terminal record request is not valid: a workspace_id is required.",
          ),
        );
      return;
    }
    try {
      res.status(200).json(deps.getTerminal(query.data.workspace_id, terminalId.data));
    } catch (error) {
      if (error instanceof TerminalEventsRepositoryError && error.code === "TERMINAL_NOT_FOUND") {
        res.status(404).json({
          code: "TERMINAL_NOT_FOUND",
          category: "state",
          safe_message: "The terminal execution record does not exist in this workspace.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: randomUUID(),
        });
        return;
      }
      throw error;
    }
  });
}

/** The route-level schema-mismatch body (the same shape the middleware emits). */
function validationFailure(safeMessage: string) {
  return {
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation",
    safe_message: safeMessage,
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  };
}

// Re-export so the transport wiring and tests share one error surface.
export { TerminalEventsRepositoryError, contractValidationResponse };
