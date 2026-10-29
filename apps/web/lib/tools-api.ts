import { z } from "zod";

import { RecoveryClass, RiskClass, type Actor } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * S21 chunk 7 — the typed browser client for the tools HTTP surface (chunk
 * 6's /v1/tools routes), reached through the same-origin runtime proxy
 * (/api/runtime/* → the container's local API). Every failure arrives as the
 * S02 taxonomy through the shared typed-error parser, so surfaces show
 * safe_message only (G3); a 2xx body that breaks its contract is a server
 * drift, never a fabricated success.
 *
 * The inventory vocabulary is the truthful read: owner, scope, risk class,
 * permissions (capabilities), version, and the lifecycle state — with the
 * disable switch that actually prevents execution (AC6). The history is the
 * redacted tool history the executor recorded (args summary + result summary
 * are pre-redacted and bounded — G3/AC9); raw arguments exist nowhere.
 */

/** One inventory entry exactly as GET /v1/tools answers it. */
export const ToolInventoryEntry = z.strictObject({
  tool_id: z.string(),
  version: z.string(),
  name: z.string(),
  purpose: z.string(),
  owner: z.strictObject({
    kind: z.enum(["platform", "agent"]),
    agent_id: z.string().nullable(),
  }),
  inventory_scope: z.enum(["private", "shared"]).nullable(),
  capabilities: z.array(z.string()),
  risk_class: RiskClass,
  approval_policy: z.enum(["auto_read_only", "preview_required", "approval_required"]),
  recovery: RecoveryClass,
  timeout_ms: z.number().int().positive(),
  state: z.enum(["active", "created", "disabled"]),
  origin: z.enum(["builtin", "agent_created"]),
  disabled: z.boolean(),
});
export type ToolInventoryEntry = z.infer<typeof ToolInventoryEntry>;

const InventoryPayload = z.strictObject({ tools: z.array(ToolInventoryEntry) });

/** One execution row exactly as GET /v1/tools/history answers it (redacted). */
export const ToolHistoryEntry = z.strictObject({
  execution_id: z.string(),
  task_id: z.string(),
  conversation_id: z.string(),
  agent_id: z.string(),
  tool_id: z.string(),
  tool_version: z.string(),
  capability: z.string(),
  risk_class: RiskClass,
  recovery: RecoveryClass,
  args_digest: z.string(),
  args_summary: z.string(),
  preview: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum([
    "proposed",
    "validated",
    "running",
    "awaiting_approval",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
  ]),
  approval_id: z.string().nullable(),
  grant_id: z.string().nullable(),
  error_code: z.string().nullable(),
  result_summary: z.string().nullable(),
  timeout_ms: z.number().int().positive(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});
export type ToolHistoryEntry = z.infer<typeof ToolHistoryEntry>;

const HistoryPayload = z.strictObject({ history: z.array(ToolHistoryEntry) });

/** The pure creation preview (D30 posture — the preview is never trusted). */
export const ToolCreationPreview = z.union([
  z.strictObject({
    ok: z.literal(true),
    tool_id: z.string(),
    risk_class: RiskClass,
    auto_activates: z.boolean(),
    ladder_label: z.string(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error_code: z.string(),
    layer: z.enum(["platform", "pack"]),
    detail: z.string(),
  }),
]);
export type ToolCreationPreview = z.infer<typeof ToolCreationPreview>;

/** The tool creation form's typed shape (the preview/create shared contract). */
export interface ToolCreationForm {
  tool_id: string;
  name: string;
  purpose: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  capabilities: string[];
  risk_class: ToolInventoryEntry["risk_class"];
  inventory_scope: "private" | "shared";
}

const CreatedPayload = z.strictObject({
  created: z.strictObject({ tool_id: z.string(), version: z.string(), state: z.string() }),
});
const ActivationPayload = z.strictObject({
  activation: z.strictObject({ granted: z.boolean(), state: z.string() }),
});

export async function fetchToolInventory(workspaceId: string): Promise<ToolInventoryEntry[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/tools?${query.toString()}`,
    (payload) => InventoryPayload.parse(payload).tools,
  );
}

export async function fetchToolHistory(
  workspaceId: string,
  filter: { task_id?: string; tool_id?: string } = {},
): Promise<ToolHistoryEntry[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  if (filter.task_id) {
    query.set("task_id", filter.task_id);
  }
  if (filter.tool_id) {
    query.set("tool_id", filter.tool_id);
  }
  return requestRuntime(
    `/api/runtime/v1/tools/history?${query.toString()}`,
    (payload) => HistoryPayload.parse(payload).history,
  );
}

export async function previewToolCreation(
  workspaceId: string,
  ownerAgentId: string,
  form: ToolCreationForm,
): Promise<ToolCreationPreview> {
  return requestRuntime(
    "/api/runtime/v1/tools/creation-preview",
    (payload) => ToolCreationPreview.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        requested_by: { type: "agent", id: ownerAgentId },
        tool: form,
      }),
    },
  );
}

export async function createTool(
  workspaceId: string,
  ownerAgentId: string,
  actor: Actor,
  form: ToolCreationForm,
): Promise<{ tool_id: string; version: string; state: string }> {
  return requestRuntime(
    "/api/runtime/v1/tools/create",
    (payload) => CreatedPayload.parse(payload).created,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        requested_by: { type: "agent", id: ownerAgentId },
        actor,
        tool: form,
      }),
    },
  );
}

export async function activateTool(
  workspaceId: string,
  toolId: string,
  version: string,
  target: { kind: "agent" | "operation" | "workspace"; id: string },
  actor: Actor,
): Promise<{ granted: boolean; state: string }> {
  return requestRuntime(
    "/api/runtime/v1/tools/activate",
    (payload) => ActivationPayload.parse(payload).activation,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        tool_id: toolId,
        version,
        target,
        actor,
      }),
    },
  );
}

export async function disableTool(
  workspaceId: string,
  toolId: string,
  actor: Actor,
): Promise<void> {
  await requestRuntime(
    "/api/runtime/v1/tools/disable",
    (payload) => z.strictObject({ ok: z.boolean() }).parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, tool_id: toolId, actor }),
    },
  );
}

export async function enableTool(workspaceId: string, toolId: string, actor: Actor): Promise<void> {
  await requestRuntime(
    "/api/runtime/v1/tools/enable",
    (payload) => z.strictObject({ ok: z.boolean() }).parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, tool_id: toolId, actor }),
    },
  );
}
