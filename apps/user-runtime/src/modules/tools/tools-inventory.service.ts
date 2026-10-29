/**
 * Agent-created tool inventory service (S21 chunk 5; PRD §7, E4, D38, D35,
 * D23 rule 6, G2/G6, AC7/AC8) — the declarative, versioned records Agents
 * create, and the lifecycle that keeps every one of them inside the D38
 * effective-capability intersection.
 *
 * Lifecycle (E4):
 *   preview (zero side effects, D35/D30) → create (RE-VALIDATED — preview
 *   answers are never trusted, D30/D36) → [READ_ONLY: auto-activate |
 *   risky: `created`] → activation (the RUNTIME GRANT — a USER decision
 *   recorded in exactly one runtime place) → active ⇄ disabled.
 *
 * The D38 intersection at creation: the tool's declared capabilities must be
 * a subset of PLATFORM_TOOL_CATALOG ∩ the pinned pack's allow-list union —
 * nothing an Agent creates can widen platform, pack, Operation, workspace,
 * or grant limits. The refusal names the layer that refused (platform vs
 * pack) so the UI can say which limit bound the request.
 *
 * Activation is a runtime grant (tool_activation_grants, created ONLY here,
 * behind the actor refusal): agents — including the creating Agent itself —
 * can never grant activation (G6; D9's "prompts cannot grant capabilities").
 * The executor consults the activation state for agent-created tools before
 * any execution, so an unactivated or unshared tool is unexecutable no
 * matter what grants exist.
 */
import { randomUUID } from "node:crypto";

import {
  ToolDefinition,
  type RiskClass,
  type ToolDefinition as ToolDefinitionType,
} from "@shera-bot/contracts";

import type { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { ToolRegistry } from "./tool-registry.ts";

/**
 * The PLATFORM tool catalog (S21): the runtime's known tool vocabulary —
 * every tool_id the platform implements mapped to the capabilities it
 * carries. The platform layer of the D38 intersection: a capability absent
 * from this catalog is not implementable, whatever a pack or an Agent
 * declares. The student pack's five allow-listed tools plus one deliberate
 * platform-only capability (memory.write) keep the two intersection layers
 * independently testable.
 */
export const PLATFORM_TOOL_CATALOG: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tool_web_search: ["web.search"],
  tool_file_read: ["file.read"],
  tool_file_write: ["file.write"],
  tool_code_exec: ["code.exec"],
  tool_repo_push: ["repo.push"],
  tool_memory_write: ["memory.write"],
});

/** Stable failure codes for the inventory boundary (SCREAMING_SNAKE). */
export type ToolsInventoryFailureCode =
  | "TOOL_CAPABILITY_NOT_ALLOWED"
  | "TOOL_ALREADY_EXISTS"
  | "TOOL_NOT_FOUND"
  | "ACTIVATION_REQUIRES_RUNTIME_GRANT"
  | "TOOL_INPUT_INVALID";

export class ToolsInventoryError extends Error {
  readonly code: ToolsInventoryFailureCode;
  readonly category: "validation" | "state" | "forbidden";

  constructor(
    code: ToolsInventoryFailureCode,
    category: "validation" | "state" | "forbidden",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ToolsInventoryError";
    this.code = code;
    this.category = category;
  }
}

/** The creation input (preview and create share the shape — create re-validates). */
export interface ToolCreationInput {
  workspace_id: string;
  requested_by: { type: "user" | "agent"; id: string };
  tool: {
    tool_id: string;
    name: string;
    purpose: string;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    capabilities: string[];
    risk_class: RiskClass;
    inventory_scope: "private" | "shared";
    timeout_ms?: number;
    redaction_policy?: "standard" | "strict";
    recovery?: "replayable" | "idempotent_retry" | "needs_human";
  };
}

/** The pure creation preview (D35/D30): the resolved shape + the D38 verdict. */
export type ToolCreationPreview =
  | {
      ok: true;
      tool_id: string;
      risk_class: RiskClass;
      /** Auto-activation posture at create time (E4: READ_ONLY auto-activates). */
      auto_activates: boolean;
      /** The D35 ladder entry the resolved risk class maps to. */
      ladder_label: string;
    }
  | {
      ok: false;
      error_code: ToolsInventoryFailureCode;
      /** Which D38 layer refused: platform (not implementable) or pack (not allowed). */
      layer: "platform" | "pack";
      detail: string;
    };

export interface ToolActivationInput {
  workspace_id: string;
  tool_id: string;
  version: string;
  target: { kind: "agent" | "operation" | "workspace"; id: string };
  actor: { type: "user" | "agent" | "runtime"; id: string };
}

export type ToolActivationResult = { granted: boolean; state: "created" | "active" };

export interface ToolsInventoryDeps {
  tx: SqliteTransactions;
  tools: ToolsRepository;
  registry: ToolRegistry;
  /** The pinned pack's tool allow-list (the composition's loaded manifest). */
  packToolAllowList: ReadonlyArray<{ tool_id: string; version: string }>;
  now?: () => string;
}

/** The per-tool defaults the creation form may omit (bounded, typed). */
const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolsInventoryService {
  /**
   * The pinned pack's allow-list, late-bound by the composition (the pack
   * loads after the wiring). The default is EMPTY — fail-closed: without a
   * pinned pack the intersection is empty and every creation is refused at
   * the pack layer (G4 — never a fake allowance).
   */
  private packAllowList: ReadonlyArray<{ tool_id: string; version: string }>;

  constructor(private readonly deps: ToolsInventoryDeps) {
    // The composition's allow-list seeds the late-bound field (a test or a
    // caller without a late pack load still enforces its deps' list).
    this.packAllowList = deps.packToolAllowList;
  }

  setPackToolAllowList(allowList: ReadonlyArray<{ tool_id: string; version: string }>): void {
    this.packAllowList = allowList;
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /** The D38 pack layer: the capability union of the allow-listed tools. */
  private packAllowedCapabilities(): Set<string> {
    const allowed = new Set<string>();
    for (const ref of this.packAllowList) {
      const capabilities = PLATFORM_TOOL_CATALOG[ref.tool_id];
      if (capabilities) {
        for (const capability of capabilities) {
          allowed.add(capability);
        }
      }
    }
    return allowed;
  }

  /**
   * The D38 intersection check (AC7): every declared capability must be
   * platform-implementable AND pack-allowed. The refusal names the layer.
   */
  private checkIntersection(
    capabilities: readonly string[],
  ): Extract<ToolCreationPreview, { ok: false }> | null {
    for (const capability of capabilities) {
      const platformImplements = Object.values(PLATFORM_TOOL_CATALOG).some((set) =>
        set.includes(capability),
      );
      if (!platformImplements) {
        return {
          ok: false,
          error_code: "TOOL_CAPABILITY_NOT_ALLOWED",
          layer: "platform",
          detail: `the platform does not implement the capability '${capability}' — nothing an Agent creates can widen platform limits (D38)`,
        };
      }
      if (!this.packAllowedCapabilities().has(capability)) {
        return {
          ok: false,
          error_code: "TOOL_CAPABILITY_NOT_ALLOWED",
          layer: "pack",
          detail: `the pinned pack does not allow the capability '${capability}' — nothing an Agent creates can widen pack limits (D38)`,
        };
      }
    }
    return null;
  }

  /**
   * The creation preview (D35/D30): a pure read model. NOTHING is written —
   * the answer resolves what creation WOULD do (ladder entry, auto-activation
   * posture, the D38 verdict), and the create command re-derives all of it
   * (preview answers are never trusted).
   */
  previewCreation(input: ToolCreationInput): ToolCreationPreview {
    const refusal = this.checkIntersection(input.tool.capabilities);
    if (refusal) {
      return refusal;
    }
    return {
      ok: true,
      tool_id: input.tool.tool_id,
      risk_class: input.tool.risk_class,
      auto_activates: input.tool.risk_class === "READ_ONLY",
      ladder_label:
        input.tool.risk_class === "READ_ONLY" ? "Runs automatically" : "Explicit approval",
    };
  }

  /**
   * Create one agent-created tool (E4). Re-validates EVERYTHING the preview
   * resolved (the preview is never trusted — D30/D36), enforces the D38
   * intersection, and lands the row + the registry registration in one
   * transaction. READ_ONLY tools auto-activate (non-destructive creation may
   * auto-activate, E4) with the creator's activation grant recorded; risky
   * tools land in `created` and wait for the user's activation decision.
   */
  createTool(input: ToolCreationInput): {
    tool_id: string;
    version: string;
    state: "created" | "active";
  } {
    if (input.requested_by.type !== "agent") {
      throw new ToolsInventoryError(
        "TOOL_INPUT_INVALID",
        "validation",
        "agent-created tools are created by an Agent actor (the record's owner)",
      );
    }
    const refusal = this.checkIntersection(input.tool.capabilities);
    if (refusal) {
      throw new ToolsInventoryError(refusal.error_code, "forbidden", refusal.detail);
    }

    const version = "1.0.0";
    const now = this.now();
    const autoActivates = input.tool.risk_class === "READ_ONLY";
    const state: "created" | "active" = autoActivates ? "active" : "created";

    const definition: ToolDefinitionType = {
      tool_id: input.tool.tool_id,
      workspace_id: input.workspace_id,
      version,
      name: input.tool.name,
      purpose: input.tool.purpose,
      owner: { kind: "agent", agent_id: input.requested_by.id },
      inventory_scope: input.tool.inventory_scope,
      input_schema: input.tool.input_schema,
      output_schema: input.tool.output_schema,
      capabilities: input.tool.capabilities,
      risk_class: input.tool.risk_class,
      timeout_ms: input.tool.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      redaction_policy: input.tool.redaction_policy ?? "standard",
      approval_policy: autoActivates ? "auto_read_only" : "approval_required",
      // E13: an undeclared recovery class stores the safe default — the
      // contracts schema's own default; the runtime never invents one (AC4).
      recovery: input.tool.recovery ?? "needs_human",
      created_at: now,
    };
    // G2: the record must satisfy the contracts schema before anything is
    // written — a malformed creation is a typed refusal, never normalized.
    const parsed = ToolDefinition.safeParse(definition);
    if (!parsed.success) {
      throw new ToolsInventoryError(
        "TOOL_INPUT_INVALID",
        "validation",
        `the tool record failed the contracts schema (${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")})`,
      );
    }

    this.deps.tx.transaction((exec) => {
      const dbExec = exec as SqliteExec;
      const existing = this.deps.tools.getAgentTool(
        input.workspace_id,
        input.tool.tool_id,
        version,
        dbExec,
      );
      if (existing !== null) {
        throw new ToolsInventoryError(
          "TOOL_ALREADY_EXISTS",
          "state",
          `tool ${input.tool.tool_id}@${version} already exists in this workspace (idempotent replay answers the original creation)`,
        );
      }
      this.deps.tools.insertAgentTool(
        {
          workspace_id: input.workspace_id,
          tool_id: input.tool.tool_id,
          version,
          name: parsed.data.name,
          purpose: parsed.data.purpose,
          owner_kind: "agent",
          owner_agent_id: input.requested_by.id,
          inventory_scope: parsed.data.inventory_scope,
          input_schema: parsed.data.input_schema as Record<string, unknown>,
          output_schema: parsed.data.output_schema as Record<string, unknown>,
          capabilities: parsed.data.capabilities,
          risk_class: parsed.data.risk_class,
          timeout_ms: parsed.data.timeout_ms,
          resource_limits: parsed.data.resource_limits,
          redaction_policy: parsed.data.redaction_policy,
          approval_policy: parsed.data.approval_policy,
          recovery: parsed.data.recovery,
          state,
          // The enabled flag is the DISABLE-SWITCH state, not the lifecycle
          // state: a `created` tool is unactivated (the activation grant
          // refuses it), not disabled. Both refuse execution — with
          // different, honest error codes.
          enabled: 1,
          max_response_bytes: 262_144,
          created_by_agent_id: input.requested_by.id,
          created_at: now,
        },
        dbExec,
      );
      if (autoActivates) {
        // E4: non-destructive creation may auto-activate — the activation
        // grant for the creator is recorded in the SAME transaction (the one
        // runtime place; a user decision is not required for READ_ONLY).
        this.deps.tools.recordActivationGrant(
          {
            workspace_id: input.workspace_id,
            tool_id: input.tool.tool_id,
            tool_version: version,
            target_kind: "agent",
            target_id: input.requested_by.id,
            granted_by: `agent:${input.requested_by.id}`,
            granted_at: now,
          },
          dbExec,
        );
      }
    });

    this.deps.registry.register({
      definition: parsed.data,
      enabled: true, // not disabled; the lifecycle gate is the activation check
      max_response_bytes: 262_144,
      origin: "agent_created",
      bindingName: this.bindingForCapabilities(parsed.data.capabilities),
    });

    return { tool_id: input.tool.tool_id, version, state };
  }

  /**
   * The binding resolution for agent-created tools: the inventory binds the
   * demo note bindings by capability family (the prototype's authored
   * mapping — a creation form never supplies executable content, D28).
   */
  private bindingForCapabilities(capabilities: readonly string[]): string {
    if (capabilities.includes("file.write") || capabilities.includes("notes.write")) {
      return "notes-append";
    }
    return "notes-read";
  }

  /**
   * Activate one agent-created tool into a toolset (E4, AC8): the runtime
   * grant, recorded in exactly one place behind the actor refusal. AGENTS
   * cannot grant — including the creating Agent for its own tool (an agent
   * actor is refused before any state check, G6). A USER decision records
   * the grant and flips the row active; a replayed activation answers
   * "already granted" (D23 rule 6) without a second write.
   */
  activateTool(input: ToolActivationInput): ToolActivationResult {
    if (input.actor.type !== "user") {
      throw new ToolsInventoryError(
        "ACTIVATION_REQUIRES_RUNTIME_GRANT",
        "forbidden",
        "activation is a runtime grant only a user decision can record — an Agent (including the creating Agent) cannot grant it, even to itself (G6)",
      );
    }
    const row = this.deps.tools.getAgentTool(input.workspace_id, input.tool_id, input.version);
    if (row === null) {
      throw new ToolsInventoryError(
        "TOOL_NOT_FOUND",
        "state",
        `no agent-created tool ${input.tool_id}@${input.version} in this workspace`,
      );
    }
    if (row.state === "disabled") {
      throw new ToolsInventoryError(
        "TOOL_NOT_FOUND",
        "state",
        "a disabled tool cannot be activated until re-enabled",
      );
    }
    const granted = this.deps.tools.recordActivationGrant({
      workspace_id: input.workspace_id,
      tool_id: input.tool_id,
      tool_version: input.version,
      target_kind: input.target.kind,
      target_id: input.target.id,
      granted_by: `user:${input.actor.id}`,
      granted_at: this.now(),
    });
    if (granted && row.state !== "active") {
      this.deps.tools.updateAgentToolState(
        input.workspace_id,
        input.tool_id,
        input.version,
        "active",
      );
      this.deps.registry.register({
        definition: this.toDefinition(row),
        enabled: true,
        max_response_bytes: 262_144,
        origin: "agent_created",
        bindingName: this.bindingForCapabilities(row.capabilities),
      });
    }
    return { granted, state: granted ? "active" : row.state === "active" ? "active" : "created" };
  }

  /** Disable/enable the disable switch rows (the executor consults them first). */
  disableTool(workspaceId: string, toolId: string, actor: { type: string; id: string }): void {
    if (actor.type !== "user") {
      throw new ToolsInventoryError(
        "ACTIVATION_REQUIRES_RUNTIME_GRANT",
        "forbidden",
        "disabling a tool is a user decision (G6)",
      );
    }
    this.deps.tools.insertDisablement(workspaceId, toolId, actor.id, this.now());
  }

  enableTool(workspaceId: string, toolId: string, actor: { type: string; id: string }): void {
    if (actor.type !== "user") {
      throw new ToolsInventoryError(
        "ACTIVATION_REQUIRES_RUNTIME_GRANT",
        "forbidden",
        "re-enabling a tool is a user decision (G6)",
      );
    }
    this.deps.tools.deleteDisablement(workspaceId, toolId);
  }

  /** Rebuild the contracts definition from a stored row (registration shape). */
  private toDefinition(
    row: ReturnType<ToolsRepository["getAgentTool"]> & object,
  ): ToolDefinitionType {
    return {
      tool_id: row.tool_id,
      workspace_id: row.workspace_id,
      version: row.version,
      name: row.name,
      purpose: row.purpose,
      owner:
        row.owner_kind === "agent" && row.owner_agent_id
          ? { kind: "agent", agent_id: row.owner_agent_id }
          : { kind: "platform" },
      inventory_scope: row.inventory_scope,
      input_schema: row.input_schema,
      output_schema: row.output_schema,
      capabilities: row.capabilities,
      risk_class: row.risk_class,
      timeout_ms: row.timeout_ms,
      resource_limits: row.resource_limits,
      redaction_policy: row.redaction_policy,
      approval_policy: row.approval_policy,
      recovery: row.recovery,
      created_at: row.created_at,
      ...(row.updated_at ? { updated_at: row.updated_at } : {}),
    };
  }

  /** Mint an execution id (the inventory does not execute — executor-only). */
  newExecutionId(): string {
    return `exe_${randomUUID()}`;
  }
}
