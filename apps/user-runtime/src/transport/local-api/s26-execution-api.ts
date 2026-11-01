/**
 * Execution tools composition (S26 chunk 6; PRD §7, D27, D35, G2/G3/G4) —
 * the composition-owned registration of the two sandboxed execution tool
 * families as platform built-ins. The DEFINITIONS here are authored
 * configuration (the same posture as registerBuiltinNoteTools): risk classes
 * from the D35 ladder (LOCAL_MUTATION — gated, never auto-run; the D35
 * "code execution → show command, working directory, resource policy" row is
 * the capability-prefix refinement the S21 ladder table already carries),
 * the D27 resource limits as record data, and the implementing bindings from
 * modules/execution (which own every rule at execution time).
 */
import type { ToolRegistry } from "../../modules/tools/tool-registry.ts";
import {
  makeCodeExecutionBinding,
  makeTerminalExecutionBinding,
  type ExecutionToolDeps,
} from "../../modules/execution/execution-tool-binding.ts";

/** The execution tools' common D27 resource envelope (record data). */
export const EXECUTION_TOOL_RESOURCE_LIMITS = {
  max_memory_mb: 1024,
  max_cpu_seconds: 30,
  max_processes: 32,
  max_disk_mb: 64,
} as const;

/**
 * Register the sandboxed code-execution and terminal-execution built-ins for
 * one workspace. Both are LOCAL_MUTATION (gated: a proposal pauses through
 * the S20 machinery until a grant or a decision — AC7); neither is ever
 * auto-run (G6).
 */
export function registerExecutionTools(
  registry: ToolRegistry,
  workspaceId: string,
  deps: ExecutionToolDeps,
): void {
  const common = {
    workspace_id: workspaceId,
    version: "1.0.0",
    owner: { kind: "platform" } as const,
    inventory_scope: "shared" as const,
    output_schema: { type: "object" },
    resource_limits: EXECUTION_TOOL_RESOURCE_LIMITS,
    redaction_policy: "standard" as const,
    created_at: new Date().toISOString(),
  };
  registry.registerBinding("code-execution", makeCodeExecutionBinding(deps));
  registry.registerBinding("terminal-execution", makeTerminalExecutionBinding(deps));
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_code_exec",
      name: "Sandboxed code execution",
      purpose:
        "Run a code payload (node/python3/shell) inside the D27 sandbox: fixed workspace workdir, path-checked, network disabled, kernel-limited, process tree terminated with the task.",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          language: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["code", "language"],
      },
      capabilities: ["code.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      approval_policy: "approval_required",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "code-execution",
  });
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_terminal_exec",
      name: "Sandboxed terminal execution",
      purpose:
        "Run one shell command inside the D27 sandbox: fixed workspace workdir, path-checked, network disabled, kernel-limited; the output streams into the terminal live view.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
      capabilities: ["terminal.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      approval_policy: "approval_required",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "terminal-execution",
  });
}
