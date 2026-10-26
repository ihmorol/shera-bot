import { z } from "zod";

import { RuntimeApiError } from "@/lib/runtime-client";
import { UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the S16 Task workers admission readout (D32 layer
 * 3, E1; UI_DESIGN S11 resource states), reached through the same-origin
 * runtime proxy exactly like the conversation, agent, and operation clients
 * (lib/runtime-client.ts, lib/agent-api.ts, lib/operation-api.ts — the same
 * transport idiom and typed failures):
 *
 *   GET /v1/workers/admission?workspace_id=…
 *
 * The ONE worker surface a browser may read (the proxy allowlist pins it);
 * every worker mutation stays runtime-internal — agents propose; the runtime
 * validates and executes. The readout is the honest "who is waiting and why":
 * configured limits, the runtime-wide live worker count, and THIS workspace's
 * queued runs with their machine-readable refusal verbatim. There is no WS
 * fanout for worker events in this slice, so the surface POLLS on the shared
 * visible-tab cadence (lib/worker-data.ts) and an absent or failed read is
 * never rendered as a state (G4).
 */

/** The machine-readable queued-reason codes the runtime's admission gate emits. */
export const WORKER_QUEUED_REASON_CODES = [
  "worker_limit_reached",
  "memory_limit",
  "disk_pressure",
  "provider_concurrency",
] as const;

/** One queued run's refusal — the exact object the worker.queued event carries. */
export const WorkerQueuedReasonSchema = z.strictObject({
  code: z.enum(WORKER_QUEUED_REASON_CODES),
  limit: z.number().int().nullable(),
  current: z.number().int().nullable(),
});
export type WorkerQueuedReason = z.infer<typeof WorkerQueuedReasonSchema>;

/** The E1 admission policy as the runtime reports it (all fields required). */
export const WorkerAdmissionLimitsSchema = z.strictObject({
  maxConcurrentWorkers: z.number().int().min(1),
  maxWorkerMemoryBytes: z.number().int().min(1),
  maxTotalWorkersMemoryBytes: z.number().int().min(1),
  minFreeDiskBytes: z.number().int().min(0),
  maxConcurrentRunsPerProvider: z.number().int().min(1),
  maxWorkerProcesses: z.number().int().min(1),
});
export type WorkerAdmissionLimits = z.infer<typeof WorkerAdmissionLimitsSchema>;

/** One run waiting in the runtime's admission queue. */
export const WorkerQueuedRunSchema = z.strictObject({
  workspace_id: z.string().min(1),
  run_id: z.string().min(1),
  reason: WorkerQueuedReasonSchema,
  message: z.string(),
});
export type WorkerQueuedRun = z.infer<typeof WorkerQueuedRunSchema>;

/** The GET /v1/workers/admission read model (the runtime's shape verbatim). */
export const WorkerAdmissionReadoutSchema = z.strictObject({
  configured: z.boolean(),
  limits: WorkerAdmissionLimitsSchema.nullable(),
  live_workers: z.number().int().min(0),
  queued_runs: z.array(WorkerQueuedRunSchema),
});
export type WorkerAdmissionReadout = z.infer<typeof WorkerAdmissionReadoutSchema>;

function toWorkerError(payload: unknown): RuntimeApiError {
  const typed = typedErrorFromPayload(payload);
  return typed instanceof RuntimeApiError ? typed : new RuntimeApiError(typed.sheraError);
}

/** The single typed read idiom shared with the other lib clients. */
export async function fetchWorkerAdmission(workspaceId: string): Promise<WorkerAdmissionReadout> {
  let response: Response;
  try {
    response = await fetch(`/v1/workers/admission?workspace_id=${encodeURIComponent(workspaceId)}`);
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toWorkerError(payload);
  }
  try {
    return WorkerAdmissionReadoutSchema.parse(payload);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    // A 2xx body that fails its contract is a server drift, not user error.
    throw toWorkerError(null);
  }
}
