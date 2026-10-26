import { z } from "zod";

import { OperationLaunchPreview, SemVer } from "@shera-bot/contracts";

import { RuntimeApiError } from "@/lib/runtime-client";
import { UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the S15 launch preview surfaces (chunk 2), reached
 * through the same-origin runtime proxy exactly like the conversation, agent,
 * and Operation clients (the same transport idiom and typed failures):
 *
 *   GET /v1/operation-definitions                                 the pinned
 *                                    pack's definition summaries (the D30
 *                                    launch menu: id, version, title, and
 *                                    the purpose verbatim)
 *   GET /v1/operation-definitions/:operation_definition_id/preview  the
 *                                    OperationLaunchPreview — ALL EIGHT D30
 *                                    groups, recomputed READ-ONLY by the
 *                                    runtime for the optional roster
 *                                    override (comma-separated
 *                                    roster_agent_ids and a
 *                                    coordinator_agent_id, "none" allowed)
 *
 * STRICTLY READ-ONLY: the preview is the safety gate where nothing may
 * execute before the user confirms (D30, AC6/AC23), so there is deliberately
 * NO mutation function here — chunk 3's launch route is the only path that
 * will ever create the Operation, and it does not exist yet. The override
 * params ride the query string (the server recomputes every group); the UI
 * never patches the preview locally.
 */

/** One definition summary in the launch menu (mirrors the runtime verbatim). */
export const OperationDefinitionSummarySchema = z.strictObject({
  operation_definition_id: z.string().min(1),
  version: SemVer,
  title: z.string().min(1),
  purpose_summary: z.string().min(1),
});
export type OperationDefinitionSummary = z.infer<typeof OperationDefinitionSummarySchema>;

const DefinitionsListResponse = z.strictObject({
  definitions: z.array(OperationDefinitionSummarySchema),
});

/**
 * The read-only roster override (D30 co-planning): a comma-separated Agent id
 * list and/or a coordinator ("none" allowed). Absent fields leave the pack's
 * own recommendation in force; the server answers `source: request_override`
 * and recomputes every group read-only.
 */
export interface OperationPreviewOverrides {
  roster_agent_ids?: string[];
  coordinator_agent_id?: string;
}

// ---------------------------------------------------------------------------
// Transport — the shared runtime idiom (lib/runtime-client.ts, lib/agent-api.ts,
// lib/operation-api.ts), scoped to the /v1/operation-definitions prefix.
// ---------------------------------------------------------------------------

function toPreviewError(payload: unknown): RuntimeApiError {
  const typed = typedErrorFromPayload(payload);
  return typed instanceof RuntimeApiError ? typed : new RuntimeApiError(typed.sheraError);
}

async function requestPreview<T>(path: string, parse: (payload: unknown) => T): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: "GET" });
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toPreviewError(payload);
  }
  try {
    return parse(payload);
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      throw error;
    }
    // A 2xx body that fails its contract is a server drift, not user error.
    throw toPreviewError(null);
  }
}

// ---------------------------------------------------------------------------
// Reads (S15 chunk 2 surface — GET-only)
// ---------------------------------------------------------------------------

export function fetchOperationDefinitions(
  workspaceId: string,
): Promise<OperationDefinitionSummary[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestPreview(
    `/api/runtime/v1/operation-definitions?${query.toString()}`,
    (payload) => DefinitionsListResponse.parse(payload).definitions,
  );
}

/**
 * The preview query string: the workspace selector (required — E12 scoping)
 * plus ONLY the override params actually present. A default read carries no
 * override params at all, so the URL itself says "the pack's own
 * recommendation".
 */
export function previewQueryParams(
  workspaceId: string,
  overrides: OperationPreviewOverrides = {},
): string {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (overrides.roster_agent_ids !== undefined) {
    query.set("roster_agent_ids", overrides.roster_agent_ids.join(","));
  }
  if (overrides.coordinator_agent_id !== undefined) {
    query.set("coordinator_agent_id", overrides.coordinator_agent_id);
  }
  return query.toString();
}

export function fetchOperationLaunchPreview(
  workspaceId: string,
  operationDefinitionId: string,
  overrides: OperationPreviewOverrides = {},
): Promise<OperationLaunchPreview> {
  return requestPreview(
    `/api/runtime/v1/operation-definitions/${encodeURIComponent(operationDefinitionId)}/preview?${previewQueryParams(workspaceId, overrides)}`,
    (payload) => OperationLaunchPreview.parse(payload),
  );
}
