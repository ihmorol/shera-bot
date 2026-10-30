/**
 * The run-control surface (S22; PRD §8, AC15, AC3; D8) — the HTTP boundary
 * over the RunCancellationService and the run's journal read:
 *
 *   - POST /v1/operations/:operation_id/runs/:run_id/cancel — the user's
 *     stop control. The body carries the workspace and the cancelling actor
 *     (the S20 decision-body convention: the session-bound browser proxy
 *     binds the actor; the local API relays it verbatim). Every outcome is a
 *     typed 200: `cancelled` (the full teardown evidence + the preserved
 *     inventory), `already_cancelled` (the idempotent replay — a second
 *     cancel is a no-op, never an error), `already_settled` (the cancel lost
 *     the race against completion — deterministic, nothing corrupts),
 *     `actor_refused` (an agent cannot cancel), `not_found` (404).
 *   - GET  /v1/operations/:operation_id/runs/:run_id/events — the run's
 *     journal events on BOTH its streams (the worker telemetry stream and
 *     the task:<run_id> lifecycle stream), oldest first. This is the TRUE
 *     attempt-count source the UI renders (AC3): the task.retry_scheduled
 *     envelopes' attempt numbers, never a hardcoded copy.
 *
 * The routes never touch SQL and never re-derive rules — every answer comes
 * from the services (the same discipline as the S19/S20/S21 surfaces).
 */
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import { z } from "zod";

import { Id, WorkspaceId } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type {
  RunCancellationOutcome,
  RunCancellationService,
} from "../../modules/tasks/run-cancellation.service.ts";

// ---------------------------------------------------------------------------
// Route paths (the contracts convention: literal constants, one definition)
// ---------------------------------------------------------------------------

export const CANCEL_RUN_PATH = "/v1/operations/:operation_id/runs/:run_id/cancel" as const;
export const RUN_EVENTS_PATH = "/v1/operations/:operation_id/runs/:run_id/events" as const;

// ---------------------------------------------------------------------------
// The composed handle (built by compose.ts over the chunk-4 services)
// ---------------------------------------------------------------------------

export interface RunEventReadModel {
  event_id: string;
  /** The stream the event rode (worker telemetry or the lifecycle stream). */
  stream_id: string;
  type: string;
  sequence: number;
  occurred_at: string;
  /** The stored payload: a full D26 envelope for lifecycle events, the bare
   * record for runtime events — verbatim, redacted at every write boundary. */
  payload: unknown;
}

export interface RunControlApiHandle {
  cancelRun(input: {
    workspaceId: string;
    runId: string;
    actor: { type: "user" | "admin"; id: string };
  }): Promise<RunCancellationOutcome>;
  listRunEvents(input: { workspaceId: string; runId: string }): RunEventReadModel[];
}

export function buildRunControlApiHandle(deps: {
  runCancellation: RunCancellationService;
  journal: Pick<EventJournalRepository, "readFrom">;
}): RunControlApiHandle {
  return {
    cancelRun: (input) => deps.runCancellation.cancelRun(input),
    listRunEvents: ({ workspaceId, runId }) => {
      // Two streams carry one run's journal: the worker telemetry (stream_id
      // = run_id, the S13 run-stream semantics) and the D8 lifecycle stream
      // (task:<run_id>). Merged oldest-first (occurred_at, then sequence).
      const merged = [
        ...deps.journal.readFrom(workspaceId, runId, 0, 10_000),
        ...deps.journal.readFrom(workspaceId, `task:${runId}`, 0, 10_000),
      ];
      return merged
        .sort((a, b) => {
          const byTime = a.occurred_at.localeCompare(b.occurred_at);
          if (byTime !== 0) return byTime;
          return a.sequence - b.sequence;
        })
        .map((row) => {
          let payload: unknown;
          try {
            payload = JSON.parse(row.payload);
          } catch {
            payload = null;
          }
          return {
            event_id: row.event_id,
            stream_id: row.stream_id,
            type: row.event_type,
            sequence: row.sequence,
            occurred_at: row.occurred_at,
            payload,
          };
        });
    },
  };
}

// ---------------------------------------------------------------------------
// The route registration (the module owns its literal-before-capture order)
// ---------------------------------------------------------------------------

const CancelRunBody = z.strictObject({
  workspace_id: WorkspaceId,
  cancelled_by: z.union([
    z.strictObject({ type: z.literal("user"), id: Id }),
    z.strictObject({ type: z.literal("admin"), id: Id }),
  ]),
});

const RunWorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

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

export function registerRunControlRoutes(app: Express, deps: RunControlApiHandle): void {
  // POST .../cancel — the user's stop control (idempotent; deterministic on
  // races; every outcome typed).
  app.post(CANCEL_RUN_PATH, (req, res) => {
    const runId = Id.safeParse(req.params.run_id);
    const body = CancelRunBody.safeParse(req.body);
    if (!runId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The cancel request is not valid: a workspace_id and a user or admin cancelled_by are required.",
          ),
        );
      return;
    }
    deps
      .cancelRun({
        workspaceId: body.data.workspace_id,
        runId: runId.data,
        actor: body.data.cancelled_by,
      })
      .then((outcome) => {
        if (outcome.outcome === "not_found") {
          res.status(404).json(outcome);
          return;
        }
        res.status(200).json(outcome);
      })
      .catch(() => {
        res
          .status(500)
          .json(
            validationFailure(
              "The cancellation could not be completed; the run state is unchanged.",
            ),
          );
      });
  });

  // GET .../events — the run's journal (the TRUE attempt-count source, AC3).
  app.get(RUN_EVENTS_PATH, (req, res) => {
    const runId = Id.safeParse(req.params.run_id);
    const query = RunWorkspaceQuery.safeParse(req.query);
    if (!runId.success || !query.success) {
      res
        .status(400)
        .json(validationFailure("The events request is not valid: a workspace_id is required."));
      return;
    }
    res.status(200).json({
      events: deps.listRunEvents({ workspaceId: query.data.workspace_id, runId: runId.data }),
    });
  });
}
