"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";

import { requestRuntime } from "@/lib/runtime-client";
import type {
  RunRecoveryMarkerData,
  RunRecoveryTimelineData,
} from "@/lib/recovery-copy";

/**
 * The typed browser client for the S31 recovery status surface
 * (GET /v1/recovery/status through the same-origin runtime proxy) and the
 * `useRecoveryStatus` hook the honest recovery surfaces read.
 *
 * The read model IS the runtime's own record — the banner state, the review
 * entries, and the per-run timelines come from the journal and the D8 rows,
 * never from invented state (G4). A failed read renders NO banner (the
 * §6.4 connection banner owns transport failure); the surface never guesses
 * a recovery state it cannot read.
 */

const BASIS = z.enum(["replayable", "idempotent_retry"]);

const TimelineMarker = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checkpoint"),
    at: z.string(),
    checkpoint_version: z.number().int().min(1),
    step_id: z.string(),
  }),
  z.strictObject({ kind: z.literal("restart"), at: z.string() }),
  z.strictObject({
    kind: z.literal("resume"),
    at: z.string(),
    basis: BASIS,
    checkpoint_version: z.number().int().min(1).nullable(),
    step_id: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("pause"),
    at: z.string(),
    pending_summary: z.string().nullable(),
  }),
]);

const ReviewEntry = z.strictObject({
  run_id: z.string(),
  operation_id: z.string(),
  conversation_id: z.string().nullable(),
  pending_summary: z.string().nullable(),
  resume_instructions: z.string().nullable(),
  since: z.string(),
});

const ResumedEntry = z.strictObject({
  run_id: z.string(),
  basis: BASIS,
  checkpoint_version: z.number().int().min(1).nullable(),
  step_id: z.string().nullable(),
  replayed: z.boolean(),
});

export const RecoveryStatus = z.strictObject({
  workspace_id: z.string(),
  workspace_state: z.enum(["recovering", "resumed", "review_needed", "idle"]),
  review_needed: z.array(ReviewEntry),
  resumed: z.array(ResumedEntry),
  timelines: z.record(z.string(), z.strictObject({ run_id: z.string(), markers: z.array(TimelineMarker) })),
  generated_at: z.string(),
});
export type RecoveryStatus = z.infer<typeof RecoveryStatus>;

export type RecoveryWorkspaceState = RecoveryStatus["workspace_state"];

/** The runtime's snake_case marker → the copy layer's component shape. */
function markerFromApi(marker: z.infer<typeof TimelineMarker>): RunRecoveryMarkerData {
  switch (marker.kind) {
    case "checkpoint":
      return {
        kind: "checkpoint",
        at: marker.at,
        checkpointVersion: marker.checkpoint_version,
        stepId: marker.step_id,
      };
    case "restart":
      return { kind: "restart", at: marker.at };
    case "resume":
      return {
        kind: "resume",
        at: marker.at,
        basis: marker.basis,
        checkpointVersion: marker.checkpoint_version,
        stepId: marker.step_id,
      };
    case "pause":
      return { kind: "pause", at: marker.at, pendingSummary: marker.pending_summary };
  }
}

/** The per-run timeline read the run cards render. */
export function timelineFromStatus(status: RecoveryStatus, runId: string): RunRecoveryTimelineData | undefined {
  const entry = status.timelines[runId];
  if (!entry) return undefined;
  return {
    runId: entry.run_id,
    markers: entry.markers.map(markerFromApi),
  };
}

/** All timelines keyed by run id (the runs panel's prop shape). */
export function timelinesFromStatus(
  status: RecoveryStatus,
): Record<string, RunRecoveryTimelineData> {
  const out: Record<string, RunRecoveryTimelineData> = {};
  for (const runId of Object.keys(status.timelines)) {
    const timeline = timelineFromStatus(status, runId);
    if (timeline) out[runId] = timeline;
  }
  return out;
}

export function fetchRecoveryStatus(workspaceId: string): Promise<RecoveryStatus> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(`/api/runtime/v1/recovery/status?${query.toString()}`, (payload) =>
    RecoveryStatus.parse(payload),
  );
}

/**
 * The recovery status read. Polls on the visible-tab cadence (the recovery
 * states are boot-scale events, not per-second telemetry); a failure is NO
 * banner — never a fabricated state (G4).
 */
export function useRecoveryStatus(
  workspaceId: string | undefined,
): UseQueryResult<RecoveryStatus> {
  return useQuery({
    queryKey: ["recovery-status", workspaceId],
    queryFn: () => fetchRecoveryStatus(workspaceId!),
    enabled: workspaceId !== undefined,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
