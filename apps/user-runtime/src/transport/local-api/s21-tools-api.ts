/**
 * Tools API (S21 chunk 6; PRD §7, E4, D38, G2/G3/G6) — the HTTP facade over
 * the runtime tool executor and inventory service. The routes never touch
 * SQL and never re-derive a rule: every answer comes from the registry, the
 * inventory service, and the history repository, workspace-scoped (E12) by
 * construction.
 *
 * Reads (the inventory + the tool history) are GET; the mutations are POST
 * commands in the D23 rule 6 convention (creation-preview is POST because it
 * carries a typed body — it is a pure read model with ZERO side effects, the
 * D30 preview posture). The browser allowlist (packages/contracts
 * isBrowserRuntimePath) mirrors exactly this inventory; tool mutations from
 * the browser carry the session-bound user actor (the proxy rebuilds it —
 * the S20 security pattern), so a client-asserted identity cannot reach the
 * runtime through the browser path.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { RiskClass, ToolDefinition } from "@shera-bot/contracts";

import type { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import {
  ToolsInventoryError,
  type ToolCreationPreview,
  type ToolsInventoryService,
} from "../../modules/tools/tools-inventory.service.ts";
import type { ToolRegistry } from "../../modules/tools/tool-registry.ts";

// ---------------------------------------------------------------------------
// Route paths (the contracts convention: literal constants, one definition)
// ---------------------------------------------------------------------------

export const LIST_TOOLS_PATH = "/v1/tools" as const;
export const LIST_TOOL_HISTORY_PATH = "/v1/tools/history" as const;
export const TOOL_CREATION_PREVIEW_PATH = "/v1/tools/creation-preview" as const;
export const TOOL_CREATE_PATH = "/v1/tools/create" as const;
export const TOOL_ACTIVATE_PATH = "/v1/tools/activate" as const;
export const TOOL_DISABLE_PATH = "/v1/tools/disable" as const;
export const TOOL_ENABLE_PATH = "/v1/tools/enable" as const;

// ---------------------------------------------------------------------------
// The composed handle (built by compose.ts over the registry + inventory)
// ---------------------------------------------------------------------------

/** One inventory entry: the truthful owner/scope/risk/permissions/version. */
export interface ToolInventoryEntry {
  tool_id: string;
  version: string;
  name: string;
  purpose: string;
  owner: { kind: "platform" | "agent"; agent_id: string | null };
  inventory_scope: "private" | "shared" | null;
  capabilities: string[];
  risk_class: RiskClass;
  approval_policy: ToolDefinition["approval_policy"];
  recovery: ToolDefinition["recovery"];
  timeout_ms: number;
  /** Execution states: active | created (awaiting activation) | disabled. */
  state: "active" | "created" | "disabled";
  origin: "builtin" | "agent_created";
  disabled: boolean;
}

export interface ToolHistoryEntry {
  execution_id: string;
  task_id: string;
  conversation_id: string;
  agent_id: string;
  tool_id: string;
  tool_version: string;
  capability: string;
  risk_class: RiskClass;
  recovery: ToolDefinition["recovery"];
  args_digest: string;
  /** Bounded, PRE-REDACTED — the raw arguments never reach this surface (G3). */
  args_summary: string;
  preview: Record<string, unknown> | null;
  status: string;
  approval_id: string | null;
  grant_id: string | null;
  error_code: string | null;
  result_summary: string | null;
  timeout_ms: number;
  started_at: string;
  finished_at: string | null;
}

/** The tools API facade (mirrors the approvals handle's shape). */
export interface ToolsApiHandle {
  /** The full inventory: registry built-ins + agent-created rows, truthfully. */
  listInventory(workspaceId: string): ToolInventoryEntry[];
  /** The tool history read model (redacted at the executor boundary). */
  listHistory(
    workspaceId: string,
    filter: { task_id?: string; tool_id?: string },
  ): ToolHistoryEntry[];
  /** The pure creation preview (zero side effects, D30 posture). */
  previewCreation(input: unknown): ToolCreationPreview;
  /** Create one agent-created tool (the owner agent + the authorizing user). */
  createTool(input: unknown): { tool_id: string; version: string; state: string };
  /** The runtime grant (user actor only — the service refuses agents). */
  activateTool(input: unknown): { granted: boolean; state: string };
  /** The disable switch that beats any grant (user actor only). */
  disableTool(input: unknown): void;
  /** Re-enable (user actor only). */
  enableTool(input: unknown): void;
}

const WorkspaceQuery = z.strictObject({ workspace_id: z.string().min(1).max(128) });

const CreationPreviewInput = z.strictObject({
  workspace_id: z.string().min(1).max(128),
  requested_by: z.strictObject({ type: z.enum(["user", "agent"]), id: z.string().min(1).max(128) }),
  tool: z.strictObject({
    tool_id: z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(2000),
    input_schema: z.record(z.string(), z.unknown()),
    output_schema: z.record(z.string(), z.unknown()),
    capabilities: z.array(z.string().min(1).max(128)).min(1).max(50),
    risk_class: z.enum([
      "READ_ONLY",
      "LOCAL_MUTATION",
      "DESTRUCTIVE_LOCAL",
      "EXTERNAL_WRITE",
      "CREDENTIAL_ACCESS",
      "DEPLOYMENT",
      "FINANCIAL_OR_IRREVERSIBLE",
    ]),
    inventory_scope: z.enum(["private", "shared"]),
    timeout_ms: z.number().int().min(1).max(600000).optional(),
    redaction_policy: z.enum(["standard", "strict"]).optional(),
    recovery: z.enum(["replayable", "idempotent_retry", "needs_human"]).optional(),
  }),
});

const CreateToolInput = CreationPreviewInput.extend({
  /** The authorizing actor — a USER (the browser path binds it server-side). */
  actor: z.strictObject({ type: z.literal("user"), id: z.string().min(1).max(128) }),
});

const ActivateToolInput = z.strictObject({
  workspace_id: z.string().min(1).max(128),
  tool_id: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  target: z.strictObject({
    kind: z.enum(["agent", "operation", "workspace"]),
    id: z.string().min(1).max(128),
  }),
  // The actor is relayed verbatim — the SERVICE owns the G6 refusal (an
  // agent actor is the typed 403, never a transport-level validation error).
  actor: z.strictObject({
    type: z.enum(["user", "agent", "runtime"]),
    id: z.string().min(1).max(128),
  }),
});

const DisableToolInput = z.strictObject({
  workspace_id: z.string().min(1).max(128),
  tool_id: z.string().min(1).max(128),
  actor: z.strictObject({
    type: z.enum(["user", "agent", "runtime"]),
    id: z.string().min(1).max(128),
  }),
});

const HistoryQuery = WorkspaceQuery.extend({
  task_id: z.string().min(1).max(256).optional(),
  tool_id: z.string().min(1).max(256).optional(),
});

/**
 * The platform's built-in note tools (S21): the REAL demo family whose
 * effects the executor records — a workspace note read (READ_ONLY) and a
 * note append (LOCAL_MUTATION, diff preview). Registered at composition;
 * capabilities inside the pinned pack's union (D38).
 */
export function registerBuiltinNoteTools(registry: ToolRegistry, workspaceId: string): void {
  const common = {
    workspace_id: workspaceId,
    version: "1.0.0",
    owner: { kind: "platform" } as const,
    inventory_scope: "shared" as const,
    output_schema: { type: "object" },
    resource_limits: {
      max_memory_mb: 256,
      max_cpu_seconds: 30,
      max_processes: 4,
      max_disk_mb: 64,
    },
    redaction_policy: "standard" as const,
    created_at: new Date().toISOString(),
  };
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_note_read",
      name: "Read a workspace note",
      purpose: "Read a workspace note's content (the prototype's real read-only tool).",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      capabilities: ["file.read"],
      risk_class: "READ_ONLY",
      timeout_ms: 30_000,
      approval_policy: "auto_read_only",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "notes-read",
  });
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_note_append",
      name: "Append a note line",
      purpose: "Append one line to a workspace note (preview-gated local mutation).",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "string" } },
        required: ["path", "line"],
      },
      capabilities: ["file.write"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 30_000,
      approval_policy: "approval_required",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "notes-append",
  });
}

export function buildToolsApiHandle(deps: {
  registry: ToolRegistry;
  tools: ToolsRepository;
  inventory: ToolsInventoryService;
}): ToolsApiHandle {
  const { registry, tools, inventory } = deps;
  return {
    listInventory(workspaceId) {
      const disablements = new Set(tools.listDisablements(workspaceId).map((row) => row.tool_id));
      // Only PLATFORM-origin registry records come from the registry side;
      // agent-created rows are listed from the inventory table (the durable
      // record) — registering into the registry never double-lists a tool.
      const builtinEntries: ToolInventoryEntry[] = registry
        .list(workspaceId)
        .filter((record) => record.origin === "builtin")
        .map((record) => ({
          tool_id: record.definition.tool_id,
          version: record.definition.version,
          name: record.definition.name,
          purpose: record.definition.purpose,
          owner:
            record.definition.owner.kind === "agent"
              ? { kind: "agent", agent_id: record.definition.owner.agent_id }
              : { kind: "platform", agent_id: null },
          inventory_scope: record.definition.inventory_scope,
          capabilities: [...record.definition.capabilities],
          risk_class: record.definition.risk_class,
          approval_policy: record.definition.approval_policy,
          recovery: record.definition.recovery,
          timeout_ms: record.definition.timeout_ms,
          state: record.enabled ? "active" : "disabled",
          origin: "builtin",
          disabled: !record.enabled || disablements.has(record.definition.tool_id),
        }));
      const agentEntries: ToolInventoryEntry[] = tools.listAgentTools(workspaceId).map((row) => ({
        tool_id: row.tool_id,
        version: row.version,
        name: row.name,
        purpose: row.purpose,
        owner: { kind: "agent", agent_id: row.owner_agent_id },
        inventory_scope: row.inventory_scope,
        capabilities: row.capabilities,
        risk_class: row.risk_class,
        approval_policy: row.approval_policy,
        recovery: row.recovery,
        timeout_ms: row.timeout_ms,
        state: row.state,
        origin: "agent_created",
        disabled: row.enabled === 0 || disablements.has(row.tool_id) || row.state === "disabled",
      }));
      return [...builtinEntries, ...agentEntries];
    },

    listHistory(workspaceId, filter) {
      // No filter: the workspace-wide history, newest first (the Tool history
      // tab's read). E12: the workspace predicate scopes every branch.
      const rows = filter.tool_id
        ? tools.listExecutionsByTool(workspaceId, filter.tool_id)
        : filter.task_id
          ? tools.listExecutionsByTask(workspaceId, filter.task_id)
          : tools.listExecutionsByWorkspace(workspaceId);
      return rows.map((row) => ({
        execution_id: row.execution_id,
        task_id: row.task_id,
        conversation_id: row.conversation_id,
        agent_id: row.agent_id,
        tool_id: row.tool_id,
        tool_version: row.tool_version,
        capability: row.capability,
        risk_class: row.risk_class,
        recovery: row.recovery,
        args_digest: row.args_digest,
        args_summary: row.args_summary,
        preview: row.preview,
        status: row.status,
        approval_id: row.approval_id,
        grant_id: row.grant_id,
        error_code: row.error_code,
        result_summary: row.result_summary,
        timeout_ms: row.timeout_ms,
        started_at: row.started_at,
        finished_at: row.finished_at,
      }));
    },

    previewCreation(input) {
      const verdict = CreationPreviewInput.safeParse(input);
      if (!verdict.success) {
        return {
          ok: false,
          error_code: "TOOL_INPUT_INVALID" as const,
          layer: "platform" as const,
          detail: "the creation request does not conform to the typed creation contract",
        };
      }
      const t = verdict.data.tool;
      return inventory.previewCreation({
        workspace_id: verdict.data.workspace_id,
        requested_by: verdict.data.requested_by,
        tool: {
          tool_id: t.tool_id,
          name: t.name,
          purpose: t.purpose,
          input_schema: t.input_schema,
          output_schema: t.output_schema,
          capabilities: t.capabilities,
          risk_class: t.risk_class,
          inventory_scope: t.inventory_scope,
          ...(t.timeout_ms !== undefined ? { timeout_ms: t.timeout_ms } : {}),
          ...(t.redaction_policy !== undefined ? { redaction_policy: t.redaction_policy } : {}),
          ...(t.recovery !== undefined ? { recovery: t.recovery } : {}),
        },
      });
    },

    createTool(input) {
      const verdict = CreateToolInput.safeParse(input);
      if (!verdict.success) {
        throw new ToolsApiError("TOOL_INPUT_INVALID", "the create request is not typed data");
      }
      // The authorizing actor must be the user the request names (the proxy
      // rebuilds it from the session on the browser path). Optional fields
      // are normalized (exactOptionalPropertyTypes): absent stays absent.
      const t = verdict.data.tool;
      return inventory.createTool({
        workspace_id: verdict.data.workspace_id,
        requested_by: { type: "agent", id: verdict.data.requested_by.id },
        tool: {
          tool_id: t.tool_id,
          name: t.name,
          purpose: t.purpose,
          input_schema: t.input_schema,
          output_schema: t.output_schema,
          capabilities: t.capabilities,
          risk_class: t.risk_class,
          inventory_scope: t.inventory_scope,
          ...(t.timeout_ms !== undefined ? { timeout_ms: t.timeout_ms } : {}),
          ...(t.redaction_policy !== undefined ? { redaction_policy: t.redaction_policy } : {}),
          ...(t.recovery !== undefined ? { recovery: t.recovery } : {}),
        },
      });
    },

    activateTool(input) {
      const verdict = ActivateToolInput.safeParse(input);
      if (!verdict.success) {
        throw new ToolsApiError("TOOL_INPUT_INVALID", "the activation request is not typed data");
      }
      return inventory.activateTool({
        workspace_id: verdict.data.workspace_id,
        tool_id: verdict.data.tool_id,
        version: verdict.data.version,
        target: verdict.data.target,
        actor: verdict.data.actor,
      });
    },

    disableTool(input) {
      const verdict = DisableToolInput.safeParse(input);
      if (!verdict.success) {
        throw new ToolsApiError("TOOL_INPUT_INVALID", "the disable request is not typed data");
      }
      inventory.disableTool(verdict.data.workspace_id, verdict.data.tool_id, verdict.data.actor);
    },

    enableTool(input) {
      const verdict = DisableToolInput.safeParse(input);
      if (!verdict.success) {
        throw new ToolsApiError("TOOL_INPUT_INVALID", "the enable request is not typed data");
      }
      inventory.enableTool(verdict.data.workspace_id, verdict.data.tool_id, verdict.data.actor);
    },
  };
}

export class ToolsApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ToolsApiError";
    this.code = code;
  }
}

/** The typed 400 body every route answers on a malformed envelope. */
function contractValidation(res: import("express").Response): void {
  res.status(400).json({
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation",
    safe_message: "The tools request is not valid: a workspace_id is required.",
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  });
}

/** Register the S21 tools routes (literal segments; the module owns ordering). */
export function registerToolsRoutes(app: import("express").Express, deps: ToolsApiHandle): void {
  // GET /v1/tools — the inventory read model (built-ins + agent-created).
  app.get(LIST_TOOLS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      contractValidation(res);
      return;
    }
    res.status(200).json({ tools: deps.listInventory(query.data.workspace_id) });
  });

  // GET /v1/tools/history — the redacted tool history (task/tool filters).
  app.get(LIST_TOOL_HISTORY_PATH, (req, res) => {
    const query = HistoryQuery.safeParse(req.query);
    if (!query.success) {
      contractValidation(res);
      return;
    }
    res.status(200).json({
      history: deps.listHistory(query.data.workspace_id, {
        ...(query.data.task_id ? { task_id: query.data.task_id } : {}),
        ...(query.data.tool_id ? { tool_id: query.data.tool_id } : {}),
      }),
    });
  });

  // POST /v1/tools/creation-preview — the PURE preview (zero side effects).
  app.post(TOOL_CREATION_PREVIEW_PATH, (req, res) => {
    res.status(200).json({ preview: deps.previewCreation(req.body) });
  });

  // POST /v1/tools/create — the creation command (re-validates everything).
  app.post(TOOL_CREATE_PATH, (req, res) => {
    try {
      res.status(200).json({ created: deps.createTool(req.body) });
    } catch (error) {
      res.status(error instanceof ToolsApiError ? 400 : 422).json({
        code:
          error instanceof ToolsInventoryError
            ? error.code
            : error instanceof ToolsApiError
              ? error.code
              : "TOOL_CREATION_REFUSED",
        category: "forbidden",
        safe_message:
          error instanceof Error ? error.message : "the tool creation was refused by policy",
        retryable: false,
        user_action: "adjust the tool to stay within the workspace's allowed capabilities",
        internal_details: null,
        correlation_id: randomUUID(),
      });
    }
  });

  // POST /v1/tools/activate — the runtime grant (user actor only).
  app.post(TOOL_ACTIVATE_PATH, (req, res) => {
    try {
      res.status(200).json({ activation: deps.activateTool(req.body) });
    } catch (error) {
      res.status(403).json({
        code: error instanceof Error ? error.message.split(":")[0] : "ACTIVATION_REFUSED",
        category: "forbidden",
        safe_message:
          error instanceof Error
            ? error.message
            : "activation requires a user decision (a runtime grant)",
        retryable: false,
        user_action: "activate the tool from Settings as the user",
        internal_details: null,
        correlation_id: randomUUID(),
      });
    }
  });

  // POST /v1/tools/disable + /v1/tools/enable — the switch that beats grants.
  const disableEnable =
    (handler: (input: unknown) => void) =>
    (req: import("express").Request, res: import("express").Response) => {
      try {
        handler(req.body);
        res.status(200).json({ ok: true });
      } catch (error) {
        res.status(403).json({
          code: error instanceof Error ? error.message.split(":")[0] : "TOOL_STATE_REFUSED",
          category: "forbidden",
          safe_message:
            error instanceof Error ? error.message : "the tool state change was refused",
          retryable: false,
          user_action: "change the switch from Settings as the user",
          internal_details: null,
          correlation_id: randomUUID(),
        });
      }
    };
  app.post(
    TOOL_DISABLE_PATH,
    disableEnable((input) => deps.disableTool(input)),
  );
  app.post(
    TOOL_ENABLE_PATH,
    disableEnable((input) => deps.enableTool(input)),
  );
}
