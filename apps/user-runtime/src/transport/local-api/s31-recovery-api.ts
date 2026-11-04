/**
 * The recovery status surface (S31 chunk 4; PRD §13, UI_DESIGN S11, D32/D33)
 * — the HTTP read the honest recovery surfaces render from:
 *
 *   GET /v1/recovery/status?workspace_id=…
 *
 * The read model is assembled from the runtime's OWN records, never invented:
 *
 *  - `review_needed` — the RECOVERY_REQUIRED runs (the D8 rows), each with
 *    the checkpoint's pending action summary + the recorded resume
 *    instructions (what could not be proven safe, and what the review
 *    decides on);
 *  - `resumed` — the LAST boot scan's auto-resumes (the RecoveryDriver's
 *    report: basis, checkpoint version, replayed honesty);
 *  - `timelines` — per run, the durable journal story: checkpoint.taken →
 *    restart (the reaped worker) → recovery.decided (resume or pause), the
 *    markers the run timeline renders;
 *  - `workspace_state` — the S11 banner state: review_needed wins (the user
 *    is needed), then recovering (the boot pass still in flight), then
 *    resumed (the last boot auto-resumed something), else idle.
 *
 * The routes never touch SQL — every answer comes from the repositories and
 * the driver's report (the same discipline as the S19/S20/S21/S22 surfaces).
 */
import type { Express } from "express";
import { z } from "zod";

import { WorkspaceId } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { RunCheckpointsRepository } from "../../adapters/sqlite/run-checkpoints-repository.ts";
import type { RecoveryScanReport } from "../../modules/recovery/recovery-driver.service.ts";
import { taskStreamId } from "../../modules/tasks/task-events.ts";

export const RECOVERY_STATUS_PATH = "/v1/recovery/status" as const;

/** One RECOVERY_REQUIRED run — the review the user owes. */
export interface RecoveryReviewEntry {
  run_id: string;
  operation_id: string;
  /** The conversation the deep link addresses (the Operation chat). */
  conversation_id: string | null;
  /** The unprovable pending step (the checkpoint's recorded summary). */
  pending_summary: string | null;
  /** The recorded resume plan the review decides on. */
  resume_instructions: string | null;
  since: string;
}

/** One run the last boot auto-resumed (the S11 RESUMED transient's substance). */
export interface RecoveryResumedEntry {
  run_id: string;
  basis: "replayable" | "idempotent_retry";
  checkpoint_version: number | null;
  step_id: string | null;
  /** Honest replay accounting: false = the re-drive did not complete. */
  replayed: boolean;
}

/** One timeline marker (the web renders these verbatim, oldest first). */
export type RecoveryTimelineMarker =
  | { kind: "checkpoint"; at: string; checkpoint_version: number; step_id: string }
  | { kind: "restart"; at: string }
  | {
      kind: "resume";
      at: string;
      basis: "replayable" | "idempotent_retry";
      checkpoint_version: number | null;
      step_id: string | null;
    }
  | { kind: "pause"; at: string; pending_summary: string | null };

export interface RecoveryTimeline {
  run_id: string;
  markers: RecoveryTimelineMarker[];
}

export interface RecoveryStatusReadModel {
  workspace_id: string;
  workspace_state: "recovering" | "resumed" | "review_needed" | "idle";
  review_needed: RecoveryReviewEntry[];
  resumed: RecoveryResumedEntry[];
  /** Keyed by run id; only runs WITH recovery journal history appear. */
  timelines: Record<string, RecoveryTimeline>;
  generated_at: string;
}

export interface RecoveryApiHandle {
  status(workspaceId: string): RecoveryStatusReadModel;
}

const MARKER_KIND_ORDER: Record<RecoveryTimelineMarker["kind"], number> = {
  checkpoint: 0,
  restart: 1,
  resume: 2,
  pause: 2,
};

export function buildRecoveryApiHandle(deps: {
  /** The composed recovery surface (the boot scan's report + settle state). */
  recovery: {
    lastReport(): RecoveryScanReport | null;
    bootSettled(): boolean;
  };
  operations: Pick<OperationsRepository, "listRunsByState" | "findRunOperation" | "findChat">;
  checkpoints: Pick<RunCheckpointsRepository, "latestForTask" | "listForTask">;
  journal: Pick<EventJournalRepository, "readFrom">;
  now?: (() => string) | undefined;
}): RecoveryApiHandle {
  const stepIdForVersion = (
    workspaceId: string,
    runId: string,
    version: number | null,
  ): string | null => {
    if (version === null) return null;
    const row = deps.checkpoints
      .listForTask(workspaceId, runId)
      .find((candidate) => candidate.checkpoint_version === version);
    return row?.step_id ?? null;
  };

  const pendingSummaryFor = (workspaceId: string, runId: string): string | null => {
    const latest = deps.checkpoints.latestForTask(workspaceId, runId);
    if (latest === null || latest.pending_action_json === null) return null;
    try {
      const parsed = JSON.parse(latest.pending_action_json) as { summary?: unknown };
      return typeof parsed.summary === "string" ? parsed.summary : null;
    } catch {
      return null;
    }
  };

  const timelineFor = (workspaceId: string, runId: string): RecoveryTimeline | null => {
    const markers: RecoveryTimelineMarker[] = [];
    // The task stream: the checkpoint boundaries + the recovery decisions.
    for (const row of deps.journal.readFrom(workspaceId, taskStreamId(runId), 0, 10_000)) {
      if (row.event_type === "checkpoint.taken") {
        try {
          const envelope = JSON.parse(row.payload) as {
            payload?: { step_id?: unknown; checkpoint_version?: unknown };
          };
          const stepId = envelope.payload?.step_id;
          const version = envelope.payload?.checkpoint_version;
          if (typeof stepId === "string" && typeof version === "number") {
            markers.push({
              kind: "checkpoint",
              at: row.occurred_at,
              checkpoint_version: version,
              step_id: stepId,
            });
          }
        } catch {
          // A corrupt row never breaks the timeline (bounded, skipped).
        }
      } else if (row.event_type === "recovery.decided") {
        try {
          const payload = JSON.parse(row.payload) as {
            basis?: unknown;
            resume_from_checkpoint_version?: unknown;
            replayed?: unknown;
          };
          if (payload.replayed !== true) continue;
          const basis = payload.basis;
          if (basis !== "replayable" && basis !== "idempotent_retry") continue;
          const version =
            typeof payload.resume_from_checkpoint_version === "number"
              ? payload.resume_from_checkpoint_version
              : null;
          markers.push({
            kind: "resume",
            at: row.occurred_at,
            basis,
            checkpoint_version: version,
            step_id: stepIdForVersion(workspaceId, runId, version),
          });
        } catch {
          // bounded, skipped
        }
      } else if (row.event_type === "task.recovery_required") {
        // The pause is a decided marker only when the recovery driver (not
        // the S22 failure path) made it — the journal cannot tell, so the
        // pause marker's substance comes from the checkpoint record and the
        // D8 envelope supplies the moment.
        markers.push({
          kind: "pause",
          at: row.occurred_at,
          pending_summary: pendingSummaryFor(workspaceId, runId),
        });
      }
    }
    // The worker stream (the S13 raw-run semantics): the reaped worker is
    // the restart marker.
    for (const row of deps.journal.readFrom(workspaceId, runId, 0, 10_000)) {
      if (row.event_type === "worker.reaped") {
        markers.push({ kind: "restart", at: row.occurred_at });
      }
    }
    if (markers.length === 0) return null;
    markers.sort((a, b) => {
      const byTime = a.at.localeCompare(b.at);
      if (byTime !== 0) return byTime;
      return MARKER_KIND_ORDER[a.kind] - MARKER_KIND_ORDER[b.kind];
    });
    return { run_id: runId, markers };
  };

  return {
    status(workspaceId: string): RecoveryStatusReadModel {
      const now = deps.now ? deps.now() : new Date().toISOString();

      const reviewNeeded: RecoveryReviewEntry[] = deps.operations
        .listRunsByState("RECOVERY_REQUIRED")
        .filter((run) => run.workspace_id === workspaceId)
        .map((run) => {
          const operationId = deps.operations.findRunOperation(workspaceId, run.run_id) ?? "";
          return {
            run_id: run.run_id,
            operation_id: operationId,
            conversation_id: operationId
              ? (deps.operations.findChat(workspaceId, operationId) ?? operationId)
              : null,
            pending_summary: pendingSummaryFor(workspaceId, run.run_id),
            resume_instructions:
              deps.checkpoints.latestForTask(workspaceId, run.run_id)?.resume_instructions ?? null,
            since: run.updated_at,
          };
        });

      const lastReport = deps.recovery.lastReport();
      const resumed: RecoveryResumedEntry[] = (lastReport?.visited ?? [])
        .filter((entry) => entry.outcome.outcome === "resumed")
        .filter((entry) => entry.workspaceId === workspaceId)
        .map((entry) => {
          const outcome = entry.outcome as {
            outcome: "resumed";
            basis: "replayable" | "idempotent_retry";
          };
          const latest = deps.checkpoints.latestForTask(workspaceId, entry.runId);
          return {
            run_id: entry.runId,
            basis: outcome.basis,
            checkpoint_version: latest?.checkpoint_version ?? null,
            step_id: latest?.step_id ?? null,
            replayed: true,
          };
        });

      const timelines: Record<string, RecoveryTimeline> = {};
      for (const runId of new Set([
        ...reviewNeeded.map((entry) => entry.run_id),
        ...resumed.map((entry) => entry.run_id),
      ])) {
        const timeline = timelineFor(workspaceId, runId);
        if (timeline !== null) timelines[runId] = timeline;
      }

      const workspaceState: RecoveryStatusReadModel["workspace_state"] =
        reviewNeeded.length > 0
          ? "review_needed"
          : !deps.recovery.bootSettled()
            ? "recovering"
            : resumed.length > 0
              ? "resumed"
              : "idle";

      return {
        workspace_id: workspaceId,
        workspace_state: workspaceState,
        review_needed: reviewNeeded,
        resumed,
        timelines,
        generated_at: now,
      };
    },
  };
}

const RecoveryStatusQuery = z.strictObject({ workspace_id: WorkspaceId });

/** The route-level schema-mismatch body (the same shape the middleware emits). */
function validationFailure(safeMessage: string) {
  return {
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation",
    safe_message: safeMessage,
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: "recovery-status",
  };
}

export function registerRecoveryRoutes(
  app: Express,
  deps: { recovery: RecoveryApiHandle; workspaceId: string },
): void {
  app.get(RECOVERY_STATUS_PATH, (req, res) => {
    const query = RecoveryStatusQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The recovery status request is not valid: a workspace_id is required.",
          ),
        );
      return;
    }
    res.status(200).json(deps.recovery.status(query.data.workspace_id));
  });
}
