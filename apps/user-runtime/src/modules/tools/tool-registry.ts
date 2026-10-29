/**
 * Runtime tool registry (S21 chunk 2; D38, G2). The registry is the
 * runtime-owned set of tool definitions every proposal resolves against —
 * built-ins registered at composition (authored configuration) and
 * agent-created tools registered by the inventory service (E4). Adapters are
 * UNTRUSTED: a proposal naming a tool the registry does not know is a typed
 * refusal, never a classification (G2).
 *
 * The registry carries the RUNTIME-side fields the contracts ToolDefinition
 * deliberately does not (E30 precedent: runtime records may extend beyond the
 * contracts shape — contracts stay untouched): the enabled flag, the per-tool
 * response budget, the origin, and the binding that implements the family.
 * Definitions are parsed through the contracts ToolDefinition schema at
 * registration — a malformed definition is refused, never normalized.
 */
import { ToolDefinition, type ToolDefinition as ToolDefinitionType } from "@shera-bot/contracts";

import type { ToolBinding } from "./tool-binding.ts";

/** One registered tool: the contracts definition + runtime-side fields. */
export interface RuntimeToolRecord {
  definition: ToolDefinitionType;
  enabled: boolean;
  /** Per-tool response budget (AC5 — a record field, not a global guess). */
  max_response_bytes: number;
  origin: "builtin" | "agent_created";
  /** The implementing binding (resolved by name at registration). */
  binding: ToolBinding;
}

export interface ToolRegistryRegistration {
  /** Parsed through the contracts schema — a malformed definition is refused. */
  definition: unknown;
  enabled: boolean;
  max_response_bytes: number;
  origin: "builtin" | "agent_created";
  /** The binding implementing this family (must already be registered). */
  bindingName: string;
}

export class ToolRegistry {
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly tools = new Map<string, RuntimeToolRecord>();

  registerBinding(name: string, binding: ToolBinding): void {
    this.bindings.set(name, binding);
  }

  /**
   * Register one tool. Keyed by (workspace_id, tool_id, version) — E12: two
   * workspaces' registries are independent namespaces.
   */
  register(registration: ToolRegistryRegistration): void {
    const verdict = ToolDefinition.safeParse(registration.definition);
    if (!verdict.success) {
      throw new Error(
        `TOOL_DEFINITION_INVALID: the tool definition failed the contracts schema (${verdict.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")})`,
      );
    }
    const definition = verdict.data;
    const binding = this.bindings.get(registration.bindingName);
    if (!binding) {
      throw new Error(`TOOL_BINDING_MISSING: no binding registered as ${registration.bindingName}`);
    }
    const key = registryKey(definition.workspace_id, definition.tool_id, definition.version);
    this.tools.set(key, {
      definition,
      enabled: registration.enabled,
      max_response_bytes: registration.max_response_bytes,
      origin: registration.origin,
      binding,
    });
  }

  /** Convenience for the composition root's built-in registrations. */
  registerBuiltinTool(registration: Omit<ToolRegistryRegistration, "origin">): void {
    this.register({ ...registration, origin: "builtin" });
  }

  resolve(workspaceId: string, toolId: string, version: string): RuntimeToolRecord | null {
    return this.tools.get(registryKey(workspaceId, toolId, version)) ?? null;
  }

  /** All registered tools in the workspace (the inventory read model's built-ins). */
  list(workspaceId: string): RuntimeToolRecord[] {
    return [...this.tools.values()]
      .filter((record) => record.definition.workspace_id === workspaceId)
      .sort((a, b) => a.definition.tool_id.localeCompare(b.definition.tool_id));
  }
}

function registryKey(workspaceId: string, toolId: string, version: string): string {
  return `${workspaceId.replaceAll("|", "\\|")}|${toolId}|${version}`;
}
